import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { auditInternals } from "../../qa/cliproxy-audit.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const LEASED_PORT = 18848;

/**
 * Bounded await helper ensuring readiness and teardown promises never hang indefinitely.
 */
async function boundedPromise(promise, label, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runHungAdversarialProbe(options = {}) {
  const events = [];
  const startTs = Date.now();

  // =========================================================================
  // Probe 1: Deliberate Stalled Child Subprocess
  // - Lifecycle strictly wrapped in unconditional try / finally.
  // - Readiness subscription capped with boundedPromise(5s).
  // - Operation timeout (1000ms) armed ONLY after exact READY <pid> is observed.
  // - If readiness fails or times out, finally block aborts runGate and awaits
  //   bounded settlement, ensuring no detached child or process group leaks.
  // =========================================================================
  events.push({ type: "stalled-subprocess-probe-started" });

  let readyPid = null;
  let seenOutput = "";
  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  const childScript = "process.on('SIGTERM', () => {}); console.log('READY ' + process.pid); setInterval(() => {}, 100000);";

  const abortController = new AbortController();
  let operationTimer = null;
  let timeoutResult = null;
  let processReaped = false;
  let groupReaped = false;

  const gatePromise = auditInternals.runGate(
    [process.execPath, "-e", childScript],
    root,
    0, // timeoutMs 0: runGate will not auto-arm timer; controlled deadline armed after readiness
    {
      signal: abortController.signal,
      exitOnSignal: false,
      onStdout(chunk) {
        seenOutput += chunk;
        const match = seenOutput.match(/READY (\d+)/);
        if (match && !readyPid) {
          readyPid = Number(match[1]);
          events.push({ type: "stalled-subprocess-subscribed-ready", pid: readyPid });
          resolveReady(readyPid);
        }
      },
    }
  );

  try {
    // Await exact readiness subscription with bounded 5000ms safety cap
    await boundedPromise(readyPromise, "stalled child subprocess readiness");
    assert(typeof readyPid === "number" && readyPid > 0, "child pid must be a valid positive integer");

    // Arm controlled operation deadline strictly AFTER readiness observation
    operationTimer = setTimeout(() => {
      events.push({ type: "stalled-subprocess-timeout-armed-fired" });
      abortController.abort("TIMEOUT");
    }, 1000);

    timeoutResult = await boundedPromise(gatePromise, "stalled child gate primary settlement", 8000);
    clearTimeout(operationTimer);
    operationTimer = null;

    events.push({
      type: "stalled-subprocess-timeout-observed",
      signal: timeoutResult.signal,
      code: timeoutResult.code,
      duration_ms: Date.now() - startTs,
    });

    assert.equal(timeoutResult.signal, "TIMEOUT", "stalled child must result in TIMEOUT signal");
    assert.equal(timeoutResult.code, null, "timed out child process code must be null");

    // Verify child process and process group are dead and reaped (ESRCH)
    try {
      process.kill(readyPid, 0);
    } catch (err) {
      if (err.code === "ESRCH") processReaped = true;
    }
    try {
      process.kill(-readyPid, 0);
    } catch (err) {
      if (err.code === "ESRCH") groupReaped = true;
    }
    assert(processReaped, `child process ${readyPid} must be reaped (ESRCH)`);
    assert(groupReaped, `child process group -${readyPid} must be reaped (ESRCH)`);
    events.push({ type: "stalled-subprocess-teardown-verified", pid: readyPid, processReaped, groupReaped });
  } finally {
    let teardownError = null;
    if (operationTimer) {
      clearTimeout(operationTimer);
      operationTimer = null;
    }
    // Cancel runGate if still active
    if (!abortController.signal.aborted) {
      events.push({ type: "stalled-subprocess-cleanup-abort-signal" });
      abortController.abort("TEARDOWN");
    }
    // Await bounded gate settlement; propagate ALL gate settlement errors
    try {
      await boundedPromise(gatePromise, "stalled subprocess gate teardown settlement", 5000);
    } catch (err) {
      teardownError = err;
    }

    // Ensure fallback cleanup executes even if gate rejects; ignore only ESRCH signals
    if (typeof readyPid === "number" && readyPid > 0) {
      try {
        process.kill(-readyPid, "SIGKILL");
      } catch (err) {
        if (err.code !== "ESRCH") teardownError = teardownError ?? err;
      }
      try {
        process.kill(readyPid, "SIGKILL");
      } catch (err) {
        if (err.code !== "ESRCH") teardownError = teardownError ?? err;
      }
    }

    if (teardownError) {
      throw teardownError;
    }
  }

  // =========================================================================
  // Probe 2: Deliberate Stalled Fixture / Response Body Stream
  // - Direct bind to leased mock port 18848 (no fallback loops).
  // - Client initiates fetch; server receives request and enqueues real prefix.
  // - Client reads and verifies headers (200) + prefix text BEFORE arming deadline.
  // - Client arms controlled 600ms stream deadline on stalled body remainder.
  // - Bounded timeout aborts client body reader (TimeoutError / AbortError).
  // - Preserves timeout abort as the primary failure behavior under test.
  // - Observes abort rejection first, then performs bounded reader cancel and
  //   observes upstream stream/socket cancellation callback on server before server.stop.
  // - Removes streamDeadline listener on all paths in finally.
  // =========================================================================
  events.push({ type: "stalled-fixture-probe-started" });

  let serverReceived = false;
  let resolveServerReceived;
  const serverReceivedPromise = new Promise((resolve) => { resolveServerReceived = resolve; });

  let streamCancelled = false;
  let streamCancelReason = null;
  let resolveStreamCancelled;
  const streamCancelledPromise = new Promise((resolve) => { resolveStreamCancelled = resolve; });

  let server;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: LEASED_PORT,
      fetch(req) {
        serverReceived = true;
        events.push({ type: "stalled-fixture-request-received", port: LEASED_PORT, url: req.url });
        resolveServerReceived();
        return new Response(new ReadableStream({
          start(controller) {
            // Enqueue real prefix bytes
            const prefix = 'event: prefix\ndata: {"status":"prefix_received"}\n\n';
            controller.enqueue(new TextEncoder().encode(prefix));
            events.push({ type: "stalled-fixture-prefix-enqueued" });
            // Intentionally stalled: no further chunks enqueued, stream left open
          },
          cancel(reason) {
            streamCancelled = true;
            streamCancelReason = reason;
            events.push({ type: "stalled-fixture-stream-cancelled-observed", reason: String(reason) });
            resolveStreamCancelled(reason);
          },
        }), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
  } catch (err) {
    throw new Error(`Failed to bind leased mock port ${LEASED_PORT}: ${err.message}`);
  }
  events.push({ type: "stalled-fixture-server-bound", port: LEASED_PORT });

  const clientAbortController = new AbortController();
  let streamDeadline = null;
  let onStreamDeadline = null;
  let reader = null;
  let readerLockHeld = false;
  let clientError = null;
  let prefixVerified = false;
  let portReleased = false;
  let primaryError = null;
  let recordedAbortReason = null;
  let deadlineFired = false;
  let hasCausalCorrespondence = false;

  try {
    // 1. Issue fetch without stream deadline yet
    const fetchPromise = fetch(`http://127.0.0.1:${LEASED_PORT}/hung-fixture`, {
      signal: clientAbortController.signal,
    });

    // Bounded await for request arrival on server
    await boundedPromise(serverReceivedPromise, "stalled fixture server request arrival");
    assert(serverReceived, "server must receive request before reading");

    // Bounded await for response headers (200 OK)
    const response = await boundedPromise(fetchPromise, "stalled fixture response headers");
    assert.equal(response.status, 200, "headers status must be 200 OK");
    events.push({ type: "stalled-fixture-headers-received", status: response.status });

    // Read and verify real prefix chunk before arming deadline
    reader = response.body.getReader();
    readerLockHeld = true;
    const firstChunk = await boundedPromise(reader.read(), "stalled fixture prefix chunk read");
    assert.equal(firstChunk.done, false, "first chunk must not be done");
    const prefixStr = new TextDecoder().decode(firstChunk.value);
    assert(prefixStr.includes("prefix_received"), "prefix chunk must contain prefix_received");
    prefixVerified = true;
    events.push({ type: "stalled-fixture-prefix-received-and-verified", prefix_length: firstChunk.value.length });

    // 2. NOW arm controlled 600ms stream deadline on the stalled remainder of the stream
    // Create and subscribe deadline handler strictly AFTER verified prefix
    streamDeadline = AbortSignal.timeout(600);
    onStreamDeadline = () => {
      deadlineFired = true;
      recordedAbortReason = streamDeadline.reason;
      events.push({ type: "stalled-fixture-stream-deadline-fired", reason: streamDeadline.reason });
      clientAbortController.abort(streamDeadline.reason);
    };
    if (streamDeadline.aborted) {
      onStreamDeadline();
    } else {
      streamDeadline.addEventListener("abort", onStreamDeadline, { once: true });
    }

    // 3. Attempt reading stalled remainder; MUST reject due to client deadline abort
    // Bound the stalled read settlement independently of the abort trigger
    const readStalledBody = async () => {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    };

    try {
      await boundedPromise(readStalledBody(), "stalled body read settlement", 5000);
    } catch (err) {
      clientError = err;
      events.push({ type: "stalled-fixture-client-read-error-caught", name: err?.name, message: err?.message });
    }
    assert(clientError, "reading stalled stream remainder must reject on deadline abort");
    assert(deadlineFired, "stream deadline must have fired before client read rejection");
    assert(clientAbortController.signal.aborted, "client controller must be in aborted state");

    // Establish causal correspondence: client error must be caused by the recorded abort reason
    hasCausalCorrespondence =
      clientError === recordedAbortReason ||
      (clientError && clientError.cause === recordedAbortReason);
    assert(hasCausalCorrespondence, "client read error must be causally tied to fired deadline reason");

    // 4. Post-rejection cleanup: cancel reader, release lock by contract state, and observe upstream cancellation
    if (reader) {
      try {
        await boundedPromise(reader.cancel(clientError), "reader post-abort cancel cleanup", 2000);
      } catch (err) {
        // Ignore cancellation rejection ONLY when it is the identical recorded abort reason,
        // or an error whose cause is identical to the recorded abort reason.
        const isIdenticalAbortReason =
          err === recordedAbortReason ||
          err === clientError ||
          (err && err.cause != null && (err.cause === recordedAbortReason || err.cause === clientError));
        if (!isIdenticalAbortReason) {
          throw err;
        }
      }
    }
    if (reader && readerLockHeld) {
      readerLockHeld = false;
      reader.releaseLock();
    }

    // Bounded observation of upstream stream cancellation propagation before stopping server
    await boundedPromise(streamCancelledPromise, "upstream stream cancellation propagation");
    assert(streamCancelled, "server stream cancel callback must be invoked upon client abort");
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    const cleanupErrors = [];

    // Stage 1: Deadline listener removal & controller abort
    try {
      if (onStreamDeadline && streamDeadline) {
        streamDeadline.removeEventListener("abort", onStreamDeadline);
      }
      if (!clientAbortController.signal.aborted) {
        clientAbortController.abort("TEARDOWN");
      }
    } catch (err) {
      cleanupErrors.push(err);
    }

    // Stage 2: Reader lock release (if still held)
    if (reader && readerLockHeld) {
      readerLockHeld = false;
      try {
        reader.releaseLock();
      } catch (err) {
        cleanupErrors.push(err);
      }
    }

    // Stage 3: Server stop (must execute even if lock release threw)
    if (server) {
      try {
        server.stop(true);
        events.push({ type: "stalled-fixture-server-stopped", port: LEASED_PORT });
      } catch (err) {
        cleanupErrors.push(err);
      }
    }

    // Stage 4: Rebind probe (must execute even if server.stop threw)
    try {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: LEASED_PORT, fetch: () => new Response("ok") });
      probe.stop(true);
      portReleased = true;
      events.push({ type: "stalled-fixture-port-released-verified", port: LEASED_PORT });
    } catch (err) {
      cleanupErrors.push(err);
    }

    if (!portReleased) {
      cleanupErrors.push(new Error(`leased port ${LEASED_PORT} was not released or failed rebind probe`));
    }

    if (cleanupErrors.length > 0) {
      if (primaryError) {
        throw new AggregateError([primaryError, ...cleanupErrors], `Probe 2 failed with primary error and ${cleanupErrors.length} cleanup error(s): ${primaryError.message}`);
      } else {
        throw cleanupErrors[0];
      }
    }
  }

  // Derive resource accounting strictly from actual observations of owned handles
  const ownedProcessesRemaining = (processReaped && groupReaped) ? 0 : 1;
  const activeListenersRemaining = portReleased ? 0 : 1;

  const observedCleanup = {
    subprocess_reaped: processReaped && groupReaped,
    subprocess_pid_verified_esrch: readyPid,
    stream_cancelled: streamCancelled,
    stream_cancel_reason: String(streamCancelReason),
    port_unbound: portReleased,
    leased_port: LEASED_PORT,
    active_listeners: activeListenersRemaining,
    owned_processes: ownedProcessesRemaining,
  };

  const receipt = {
    schema: "cliproxy-parity/adversarial-hung-v1",
    task: "task-2",
    verdict: "HUNG_COMMAND_ADVERSARIAL_PASS",
    timestamp: new Date().toISOString(),
    assertions: [
      { id: "stalled-subprocess-readiness-bounded", expected: true, actual: typeof readyPid === "number" && readyPid > 0, pass: true },
      { id: "stalled-subprocess-timeout-signal", expected: "TIMEOUT", actual: timeoutResult?.signal, pass: true },
      { id: "stalled-subprocess-exit-code-null", expected: null, actual: timeoutResult?.code, pass: true },
      { id: "stalled-subprocess-reaped-esrch", expected: true, actual: processReaped && groupReaped, pass: true },
      { id: "stalled-fixture-prefix-observed-before-deadline", expected: true, actual: prefixVerified, pass: true },
      { id: "stalled-fixture-timeout-abort-error", expected: true, actual: hasCausalCorrespondence, pass: true },
      { id: "stalled-fixture-stream-cancellation-observed", expected: true, actual: streamCancelled, pass: true },
      { id: "stalled-fixture-port-released-rebindable", expected: true, actual: portReleased, pass: true },
    ],
    observed_cleanup: observedCleanup,
    events,
  };

  return receipt;
}

if (import.meta.main) {
  const result = await runHungAdversarialProbe();
  console.log(JSON.stringify(result, null, 2));
}

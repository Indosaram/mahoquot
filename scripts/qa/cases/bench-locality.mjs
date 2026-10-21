import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixture } from '../cliproxy-parity.mjs';
import { runLocalityBenchmark } from '../../../scripts/bench-locality.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function validateLocalityReport(report) {
  if (!report || typeof report !== 'object') throw new Error('locality report must be an object');
  if (report.matrix !== 'B3-B5,B8-B9') throw new Error(`unexpected matrix: ${report.matrix}`);
  if (!report.correctness_passed) throw new Error('correctness gate failed in locality report');

  // B3 checks
  const b3 = report.b3_history;
  if (!b3 || b3.rounds !== 5) throw new Error('b3 rounds incomplete');
  if (!b3.signature_recall_success) throw new Error('b3 signature recall failed');
  if (b3.raw_routing_headers_leaked !== 0) throw new Error('b3 leaked routing headers upstream');
  if (b3.hops !== b3.rounds || b3.rebind_count !== 0) throw new Error('b3 mock turn observations incomplete or rebound');
  if (!Array.isArray(b3.prompt_tokens_growth) || b3.prompt_tokens_growth.length !== 5) throw new Error('b3 prompt tokens growth incomplete');
  if (typeof b3.p50_ms !== 'number' || b3.p50_ms <= 0) throw new Error('b3 p50 latency missing or invalid');

  // B4 checks
  const b4 = report.b4_alternating;
  if (!b4 || b4.alternations !== 4) throw new Error('b4 alternations incomplete');
  if (!b4.independent_binding_retained) throw new Error('b4 independent binding not retained');
  if (!b4.failover_recovery_ok) throw new Error('b4 failover recovery failed');
  if (typeof b4.account_hops !== 'number' || typeof b4.cache_affinity_opportunity_loss !== 'number') throw new Error('b4 account observations incomplete');

  // B5 checks
  const b5 = report.b5_hierarchy;
  if (!b5 || b5.branches_tested !== 3) throw new Error('b5 branches incomplete');
  if (b5.cross_tenant_collisions !== 0) throw new Error(`b5 cross-tenant collisions detected: ${b5.cross_tenant_collisions}`);
  if (!b5.parent_policy_honored) throw new Error('b5 parent policy not honored');

  // B8 checks
  const b8 = report.b8_egress;
  if (!b8 || b8.total_requests !== 10) throw new Error('b8 total requests incomplete');
  if (!b8.next_request_correct_egress) throw new Error('b8 wrong egress detected');
  if (!b8.inflight_intact) throw new Error('b8 inflight requests disrupted');
  if (b8.direct_fallback_count !== 0) throw new Error(`b8 unexpected direct fallbacks: ${b8.direct_fallback_count}`);

  // B8 hop log checks (missing observation is a hard error)
  const hopLog = b8.hop_log;
  if (!Array.isArray(hopLog) || hopLog.length === 0) {
    throw new Error('b8 hop_log missing or empty (hard error: missing observation)');
  }
  for (const entry of hopLog) {
    if (!entry.request_id || typeof entry.request_id !== 'string') {
      throw new Error('b8 hop_log entry missing request_id (hard error: missing observation)');
    }
    if (!entry.timestamp || typeof entry.timestamp !== 'string') {
      throw new Error('b8 hop_log entry missing timestamp (hard error: missing observation)');
    }
    if (typeof entry.passed_loopback_proxy !== 'boolean' || typeof entry.reached_mock_directly !== 'boolean') {
      throw new Error('b8 hop_log entry missing hop observation (hard error: missing observation)');
    }
    if (entry.passed_loopback_proxy === entry.reached_mock_directly) {
      throw new Error('b8 hop_log entry contains contradictory hop observation (hard error: missing observation)');
    }
    if (typeof entry.config_generation !== 'number' || entry.config_generation <= 0) {
      throw new Error('b8 hop_log entry missing or invalid config_generation (hard error: missing observation)');
    }
  }

  // B9 checks
  const b9 = report.b9_antigravity;
  if (!b9 || !b9.pooling_enabled) throw new Error('b9 pooling not enabled');
  if (b9.accounts_tested !== 2) throw new Error('b9 accounts tested incomplete');
  if (b9.connection_reuse_count <= 0) throw new Error('b9 connection reuse count must be positive');
  if (b9.cross_account_leaks !== 0) throw new Error('b9 cross account leaks detected');
  if (b9.peak_rss_bytes <= 0) throw new Error('b9 peak RSS bytes must be positive');
  if (b9.peak_fds <= 0) throw new Error('b9 peak FDs must be positive');

  return {
    b3_b5_recorded: true,
    b8_b9_recorded: true,
  };
}

export async function runCase(variant, evidencePath, context) {
  if (!['happy', 'failure'].includes(variant)) throw new Error('unknown variant');
  const base = await runFixture('happy', `${evidencePath}.fixture.json`);

  const events = [...base.events];
  await mkdir(dirname(evidencePath), { recursive: true });

  const targetDir = join(dirname(context.binary), '..');
  const benchBin = join(targetDir, 'debug/bench');
  // Build the bench tool from the sources under test before use; a binary
  // left in the shared target by an earlier run may predate them.
  const build = Bun.spawn(['cargo', 'build', '-p', 'bench', '--bin', 'bench'], {
    cwd: join(root, 'mahoquot-proxy'),
    env: { ...process.env, CARGO_TARGET_DIR: targetDir, CARGO_NET_OFFLINE: 'true' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [, buildErr] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if ((await build.exited) !== 0) throw new Error(`failed to build bench: ${buildErr}`);

  const env = {
    ...process.env,
    BENCH: benchBin,
    GWBIN: context.binary,
    BENCH_EVIDENCE: `${evidencePath}.locality-dir`,
    CARGO_TARGET_DIR: targetDir,
  };

  let b3_b5_recorded = false;
  let b8_b9_recorded = false;
  let crossTenantCollisionDetected = false;
  let wrongEgressDetected = false;
  let report = null;

  if (variant === 'happy') {
    report = await runLocalityBenchmark(env);
    const verified = validateLocalityReport(report);
    b3_b5_recorded = verified.b3_b5_recorded;
    b8_b9_recorded = verified.b8_b9_recorded;

    events.push({
      type: 'bench-locality-measured',
      b3_rounds: report.b3_history.rounds,
      b4_alternations: report.b4_alternating.alternations,
      b5_branches: report.b5_hierarchy.branches_tested,
      b8_requests: report.b8_egress.total_requests,
      b8_direct_fallbacks: report.b8_egress.direct_fallback_count,
      b9_reuse: report.b9_antigravity.connection_reuse_count,
      b9_rss_bytes: report.b9_antigravity.peak_rss_bytes,
      b9_fds: report.b9_antigravity.peak_fds,
    });
  } else {
    // Failure variant injects real faults into live benchmark execution:
    // 1. BENCH_FAULT_EGRESS=true -> proxy bypassed, direct fallback observed in real traffic
    // 2. BENCH_FAULT_COLLISION=true -> multi-tenant collision injected and observed
    // The gate validates against the real observed report and detects both faults.
    const faultEnv = {
      ...env,
      BENCH_FAULT_EGRESS: 'true',
      BENCH_FAULT_COLLISION: 'true',
    };
    report = await runLocalityBenchmark(faultEnv);

    if (report.b5_hierarchy.cross_tenant_collisions === 0) throw new Error('collision fault was not observed at upstream mock');

    // Validate that the gate rejects the cross-tenant collision from observed data
    if (report.b5_hierarchy.cross_tenant_collisions > 0) {
      crossTenantCollisionDetected = true;
    }

    // Validate that the gate rejects the wrong egress from observed data and the per-request hop log
    const hopLog = report.b8_egress.hop_log ?? [];
    if (hopLog.length === 0) {
      throw new Error('b8 hop_log missing in failure variant (hard error: missing observation)');
    }
    for (const entry of hopLog) {
      if (!entry.request_id || !entry.timestamp || typeof entry.passed_loopback_proxy !== 'boolean' || typeof entry.reached_mock_directly !== 'boolean' || !entry.config_generation) {
        throw new Error('b8 hop_log entry incomplete in failure variant (hard error: missing observation)');
      }
    }

    const postSwitchHops = hopLog.filter(h => h.config_generation > 1);
    const postSwitchUsedWrongEgress = postSwitchHops.some(h => h.passed_loopback_proxy || !h.reached_mock_directly);

    if (report.b8_egress.direct_fallback_count > 0 || !report.b8_egress.next_request_correct_egress || postSwitchUsedWrongEgress) {
      wrongEgressDetected = true;
    }

    events.push({
      type: 'bench-locality-fault-detected-from-observation',
      crossTenantCollisionDetected,
      wrongEgressDetected,
      observed_cross_tenant_collisions: report.b5_hierarchy.cross_tenant_collisions,
      observed_direct_fallback_count: report.b8_egress.direct_fallback_count,
      observed_next_request_correct_egress: report.b8_egress.next_request_correct_egress,
    });
  }

  const assertions = variant === 'happy'
    ? [
        { id: 'b3-b5-recorded', expected: true, actual: b3_b5_recorded, pass: b3_b5_recorded === true },
        { id: 'b8-b9-recorded', expected: true, actual: b8_b9_recorded, pass: b8_b9_recorded === true },
      ]
    : [
        {
          id: 'cross-tenant-collision-detected',
          expected: true,
          actual: crossTenantCollisionDetected,
          pass: crossTenantCollisionDetected === true,
        },
        {
          id: 'wrong-egress-detected',
          expected: true,
          actual: wrongEgressDetected,
          pass: wrongEgressDetected === true,
        },
      ];

  const benchSha = await Bun.file(benchBin).exists()
    ? createHash('sha256').update(await readFile(benchBin)).digest('hex')
    : createHash('sha256').update(context.binary).digest('hex');

  const receipt = context.createReceipt({
    caseName: 'bench-locality',
    variant,
    assertions,
    requiredAssertionIds: assertions.map(a => a.id),
    events,
    wireRequests: [...base.wire_capture.gateway_requests],
    provenance: {
      ...base.provenance,
      bench_sha256: benchSha,
      matrix: 'B3-B5,B8-B9',
      locality_report_path: `${evidencePath}.locality-dir/locality-report.json`,
      measured_b_metrics: {
        b3_prompt_tokens: report.b3_history.prompt_tokens_growth,
        b3_p50_ms: report.b3_history.p50_ms,
        b3_p99_ms: report.b3_history.p99_ms,
        b4_alternations: report.b4_alternating.alternations,
        b5_branches: report.b5_hierarchy.branches_tested,
        b8_requests: report.b8_egress.total_requests,
        b8_direct_fallback_count: report.b8_egress.direct_fallback_count,
        b8_next_request_correct_egress: report.b8_egress.next_request_correct_egress,
        b9_connection_reuse_count: report.b9_antigravity.connection_reuse_count,
        b9_peak_rss_bytes: report.b9_antigravity.peak_rss_bytes,
        b9_peak_fds: report.b9_antigravity.peak_fds,
      },
    },
    teardown: base.teardown,
  });

  await writeFile(evidencePath, JSON.stringify(receipt, null, 2));
  return receipt;
}

import { isIP } from "node:net";

const requireValue = (value, message) => { if (!value) throw new Error(message); };

export function parseDiscovery(code, stdout) {
  requireValue(code === 0, `discovery command failed: ${code}`);
  const services = JSON.parse(stdout);
  requireValue(Array.isArray(services), "discovery must return an array");
  for (const service of services) {
    requireValue(service && typeof service === "object" && !Array.isArray(service), "invalid discovery service");
    requireValue(typeof service.instance_name === "string" && service.instance_name.trim().length > 0, "invalid discovery service identity");
    requireValue(Number.isInteger(service.port) && service.port > 0 && service.port <= 65535, "invalid discovery port");
    requireValue(typeof service.service_type === "string" && service.service_type.length > 0 && typeof service.domain === "string" && service.domain.length > 0, "invalid discovery type/domain");
    requireValue(typeof service.host === "string" && service.host.length > 0, "invalid discovery host");
    for (const [field, family] of [["ipv4", 4], ["ipv6", 6]]) {
      requireValue(Array.isArray(service[field]) && service[field].every((ip) => typeof ip === "string" && isIP(ip) === family), `invalid discovery ${field}`);
    }
    requireValue(service.raw_txt === undefined || (service.raw_txt !== null && typeof service.raw_txt === "object" && !Array.isArray(service.raw_txt) && Object.values(service.raw_txt).every((value) => typeof value === "string")), "invalid discovery TXT");
  }
  return services;
}

export function matchesLaunch(service, launch) {
  return service.instance_name === launch.instance_name && service.port === launch.port &&
    service.service_type === launch.service_type && service.domain === launch.domain &&
    service.raw_txt?.instance_id === launch.instance_id &&
    [...service.ipv4, ...service.ipv6].length === 1 &&
    [...service.ipv4, ...service.ipv6][0] === launch.address && service.host === launch.address;
}

export async function deadline(action, label, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

export function requireScopedCleanup(cleanup) {
  requireValue(cleanup.scope === "registered-keeper-groups" && cleanup.assumption === "descendants-do-not-setsid" && cleanup.independentGuestContainmentRequired === true, "missing cleanup scope/containment qualification");
  requireValue(cleanup.aggregateCensus === "unobserved" && cleanup.ownedProcesses === null && cleanup.openPipes === null && cleanup.listeners === null, "unmeasured cleanup aggregates must remain unobserved");
  requireValue(Array.isArray(cleanup.registeredSupervisors), "missing registered supervisor observations");
  const ids = new Set();
  for (const entry of cleanup.registeredSupervisors) {
    requireValue(Number.isInteger(entry.id) && entry.id > 0 && !ids.has(entry.id), "invalid registered supervisor identity");
    ids.add(entry.id);
    requireValue(entry.creation === "spawned" && entry.groupTerminated === true && entry.supervisorClosed === true && entry.supervisorExitCode === 0 && ["stdin", "stdout", "stderr"].every((name) => entry.registeredStdioClosed?.[name] === true), "incomplete registered supervisor cleanup");
  }
}

// An observation collector, NOT a receipt publisher or a production adapter.
// The isolated transport owner must implement this contract before runCase can use it.
// acquire/start must register ownership before their first fallible operation. cleanup
// must acknowledge registered keeper-group termination and observe registered
// stdio closure. Arbitrary descendants/listeners are not censused here; independent
// guest containment and the no-setsid assumption remain explicit prerequisites.
export async function collectDiscoveryContract(owner, launch, timeout = 15000) {
  const events = [];
  let observations, failure;
  const invoke = (name, ...args) => deadline(() => owner[name](...args), name, timeout);
  try {
    requireValue(isIP(launch.address) !== 0 && Number.isInteger(launch.port) && launch.port >= 18840 && launch.port <= 18899 &&
      typeof launch.instance_name === "string" && launch.instance_name.length > 0 && /^[A-F0-9]{4}$/.test(launch.instance_id), "invalid launched identity");
    const isolation = await invoke("acquire", launch);
    requireValue(isolation.transport === "isolated-discovery" && isolation.run_id === launch.run_id && isolation.ambient_multicast === false, "isolated transport required");
    await invoke("start", launch);
    const before = await invoke("discover");
    const services = parseDiscovery(before.code, before.stdout);
    requireValue(services.length === 1 && matchesLaunch(services[0], launch), "discovery does not identify exactly the launched gateway");
    events.push({ type: "discovered", service: services[0] });
    const terminal = await invoke("pty");
    requireValue(terminal.code === 0 && terminal.failure === null && terminal.output_subscribed_before_exec === true &&
      terminal.screens?.join(",") === "DASHBOARD,CONFIGURATION,ACCOUNTS LIST" &&
      terminal.raw_entered === true && terminal.restored === true && terminal.reaped === true && terminal.pipes_closed === true,
    "incomplete real PTY observation");
    // Install the subscription BEFORE triggering shutdown. The adapter must bind
    // this event to the actual responder's completed deregistration, not process exit.
    const subscription = owner.subscribeDeregistered(launch);
    requireValue(subscription && typeof subscription.cancel === "function", "missing deregistration subscription");
    const acknowledged = Promise.resolve(subscription.promise);
    // Avoid an unhandled rejection if stop fails before we consume the event.
    acknowledged.catch(() => {});
    try {
      await invoke("stop");
      const ack = await deadline(() => acknowledged, "deregistration acknowledgement", timeout);
      requireValue(ack.run_id === launch.run_id && ack.instance_name === launch.instance_name &&
        ack.instance_id === launch.instance_id && ack.address === launch.address && ack.port === launch.port &&
        ack.service_type === launch.service_type && ack.domain === launch.domain &&
        ack.responder_joined === true && ack.transport_removed === true, "wrong or incomplete deregistration acknowledgement");
      events.push({ type: "deregistered", ...ack });
      const after = await invoke("discover");
      requireValue(parseDiscovery(after.code, after.stdout).length === 0, "isolated discovery is not empty after acknowledged removal");
    } finally { subscription.cancel(); }
    observations = { events, terminal };
  } catch (error) { failure = error; }
  try {
    const cleanup = await deadline(() => owner.cleanup(), "cleanup", Math.max(timeout, 45000));
    requireScopedCleanup(cleanup);
    if (observations) {
      requireValue(cleanup.registeredSupervisors.length > 0, "successful collection requires registered supervisor observations");
      observations.cleanup = cleanup;
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "collection and cleanup failed") : error;
  }
  if (failure) throw failure;
  return observations;
}

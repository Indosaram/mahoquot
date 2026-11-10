// Subscribe at process creation, before any native start/quit trigger.
export function observeGatewayLifecycle(child) {
  let buffer = "";
  let active = null;
  let failure = null;
  let ended = false;
  const records = [];
  const waiters = new Set();
  const settle = () => {
    for (const waiter of waiters) {
      const value = records.find(waiter.match);
      if (failure || value) {
        waiters.delete(waiter);
        if (failure) waiter.reject(failure); else waiter.resolve(value);
      }
    }
  };
  const fail = (error) => { failure = error; settle(); };
  const data = (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.startsWith("MAHOQUOT_NATIVE_LIFECYCLE ")) continue;
      try {
        const event = JSON.parse(line.slice("MAHOQUOT_NATIVE_LIFECYCLE ".length));
        if (!Number.isSafeInteger(event.pid) || event.pid <= 1 || !Number.isSafeInteger(event.generation) || event.generation < 1) throw new Error("invalid lifecycle identity");
        if (event.event === "spawned") {
          if (active || records.some((old) => old.generation >= event.generation)) throw new Error("unexpected gateway generation");
          active = event;
        } else {
          if (!active || active.pid !== event.pid || active.generation !== event.generation) throw new Error("unowned lifecycle event");
          if (event.event === "wait-error") throw new Error("native gateway wait failed");
          if (!["ready", "reaped"].includes(event.event)) throw new Error("invalid lifecycle kind");
          if (event.event === "reaped") active = null;
        }
        records.push(event); settle();
      } catch (error) { fail(error); }
    }
  };
  const closed = () => {
    child.stdout.off("data", data);
    child.off("error", fail);
    ended = true;
    for (const waiter of waiters) waiter.reject(new Error("native lifecycle stream closed before requested event"));
    waiters.clear();
  };
  child.stdout.on("data", data);
  child.once("error", fail);
  child.once("close", closed);
  return {
    records,
    wait(event, generation) {
      const match = (value) => value.event === event && (generation === undefined || value.generation === generation);
      if (failure) return Promise.reject(failure);
      const existing = records.find(match);
      if (existing) return Promise.resolve(existing);
      if (ended) return Promise.reject(new Error("native lifecycle stream already closed"));
      return new Promise((resolve, reject) => waiters.add({ match, resolve, reject }));
    },
  };
}

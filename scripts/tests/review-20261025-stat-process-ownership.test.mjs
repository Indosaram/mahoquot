import { test, expect } from 'bun:test';
import { getProcessStats } from '../bench-resilience.mjs';
import { benchmarkOwner } from '../bench-locality.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fakeChild(command, events, { output = '', status = 0, hanging = false, stuck = false, brokenPipe = false } = {}) {
  const exit = deferred();
  const pipes = [deferred(), deferred()];
  const child = {
    exitCode: hanging ? null : status,
    exited: exit.promise.then(code => { events.push(`${command}:reaped`); return code; }),
    kill(signal) {
      events.push(`${command}:kill:${signal}`);
      if (!stuck) {
        child.exitCode = 137;
        exit.resolve(137);
        pipes.forEach(pipe => pipe.resolve());
      }
    },
  };
  for (const [index, name] of ['stdout', 'stderr'].entries()) {
    child[name] = (async function* () {
      events.push(`${command}:${name}:start`);
      if (index === 0 && output) yield Buffer.from(output);
      if (hanging) await pipes[index].promise;
      events.push(`${command}:${name}:drained`);
      if (brokenPipe && index === 1) throw new Error('fixture pipe failure');
    })();
  }
  if (!hanging) exit.resolve(status);
  return child;
}

for (const command of ['ps', 'lsof']) {
  test(`hanging ${command} is killed, reaped and drained before outer cleanup`, async () => {
    const events = [];
    const owner = benchmarkOwner();
    owner.release(() => events.push('outer:release'));
    const calls = [];
    let stats;
    try {
      stats = await getProcessStats(123, {
        spawn(argv, options) {
          calls.push(argv);
          expect(options).toEqual({ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
          return fakeChild(argv[0], events, { hanging: argv[0] === command, output: '24\n' });
        },
        listFds: async () => {
          if (command === 'lsof') throw new Error('no procfs');
          return ['0', '1'];
        },
        wait(promise, label, timeoutMs) {
          expect(timeoutMs).toBe(15000);
          if (label === `${command} capture`) {
            expect(events).toContain(`${command}:stdout:start`);
            expect(events).toContain(`${command}:stderr:start`);
            return Promise.reject(new Error('injected deadline event'));
          }
          return promise;
        },
      });
      events.push('stats:return');
    } finally { await owner.close(); }
    expect(calls).toEqual(command === 'ps'
      ? [['ps', '-o', 'rss=', '-p', '123']]
      : [['ps', '-o', 'rss=', '-p', '123'], ['lsof', '-p', '123']]);
    expect(stats).toEqual(command === 'ps' ? { rssBytes: null, fds: 2 } : { rssBytes: 24576, fds: null });
    expect(events).toContain(`${command}:kill:SIGKILL`);
    for (const event of ['reaped', 'stdout:drained', 'stderr:drained']) {
      expect(events.indexOf(`${command}:${event}`)).toBeLessThan(events.indexOf('stats:return'));
    }
    expect(events.indexOf('stats:return')).toBeLessThan(events.indexOf('outer:release'));
  });
}

for (const failure of ['stuck', 'brokenPipe', 'kill']) {
  test(`${failure} cleanup failure remains visible and outer finally runs`, async () => {
    const events = [];
    const owner = benchmarkOwner();
    owner.release(() => events.push('outer:release'));
    const operation = (async () => {
      try {
        return await getProcessStats(123, {
          spawn(argv) {
            const child = fakeChild(argv[0], events, {
              hanging: failure !== 'brokenPipe', stuck: failure === 'stuck', brokenPipe: failure === 'brokenPipe',
            });
            if (failure === 'kill') {
              const kill = child.kill;
              child.kill = signal => { kill(signal); throw new Error('fixture kill failure'); };
            }
            return child;
          },
          listFds: async () => [],
          wait(promise, label) {
            if (label.endsWith('capture') && failure !== 'brokenPipe') return Promise.reject(new Error('capture deadline'));
            if (failure === 'stuck') return Promise.reject(new Error(`${label} deadline`));
            return promise;
          },
        });
      } finally { await owner.close(); }
    })();
    await expect(operation).rejects.toBeInstanceOf(AggregateError);
    expect(events).toContain('outer:release');
  });
}

for (const output of ['', 'garbage', '0', '-1', 'Infinity']) {
  test(`invalid RSS ${JSON.stringify(output)} stays unavailable`, async () => {
    const stats = await getProcessStats(123, {
      spawn: argv => fakeChild(argv[0], [], { output }),
      listFds: async () => { throw new Error('no procfs'); },
      wait: promise => promise,
    });
    expect(stats).toEqual({ rssBytes: null, fds: null });
  });
}

test('missing executables and nonzero exits cannot manufacture measurements', async () => {
  for (const missing of [true, false]) {
    const stats = await getProcessStats(123, {
      spawn(argv) {
        if (missing) throw new Error('ENOENT');
        return fakeChild(argv[0], [], { output: argv[0] === 'ps' ? '24' : 'COMMAND PID\nfixture 123', status: 1 });
      },
      listFds: async () => { throw new Error('no procfs'); },
      wait: promise => promise,
    });
    expect(stats).toEqual({ rssBytes: null, fds: null });
  }
});

test('successful direct captures retain real observations', async () => {
  const stats = await getProcessStats(123, {
    spawn: argv => fakeChild(argv[0], [], { output: argv[0] === 'ps' ? '24\n' : 'COMMAND PID\nfixture 123\nfixture 123\n' }),
    listFds: async () => { throw new Error('no procfs'); },
    wait: promise => promise,
  });
  expect(stats).toEqual({ rssBytes: 24576, fds: 2 });
});

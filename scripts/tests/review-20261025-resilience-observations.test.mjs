import { test, expect } from 'bun:test';
import { observationJournal, exactCancellation, durableObservations, postcommitReplayPrevented } from '../bench-resilience.mjs';

function fixture() {
  return [
    { event: 'request', observation_id: 'phase-id', event_id: 'sqlite-id' },
    ...['guard-acquire', 'stream-open', 'guard-release', 'finalized', 'recorded'].map(event => ({ event, request_id: 'sqlite-id', ...(event === 'finalized' ? { status: 499 } : {}) })),
    { event: 'commit', event_ids: ['sqlite-id'], written: 1, rejected: 0, write_ms: 2.75, queue_depth: 3 },
    { event: 'flush', queue_depth: 0, enqueued: 1, written: 1, dropped: 0, failures: 0 },
  ];
}

test('phase correlation joins measured commits to database bytes, not aggregate rows', () => {
  const events = fixture();
  const result = durableObservations(events, ['phase-id'], [{ event_id: 'sqlite-id' }, { event_id: 'other-phase' }]);
  expect(result).toEqual({ event_ids: ['sqlite-id'], duplicate_events: 0, dropped_rows: 0, write_backlog: 3, p99_write_ms: 2.75, drained_shutdown: true });
  expect(durableObservations(events, ['phase-id'], [{ event_id: 'other-phase' }]).dropped_rows).toBe(1);
  expect(durableObservations(events, ['missing-phase'], [{ event_id: 'sqlite-id' }]).p99_write_ms).toBeNull();
});

test('durability rejects absent, duplicate, failed and invalid commit evidence', () => {
  for (const mutate of [
    e => e.filter(x => x.event !== 'commit'),
    e => [...e, e.find(x => x.event === 'commit')],
    e => e.map(x => x.event === 'commit' ? { ...x, written: null } : x),
    e => e.map(x => x.event === 'commit' ? { ...x, write_ms: -1 } : x),
    e => e.map(x => x.event === 'commit' ? { ...x, queue_depth: -1 } : x),
    e => e.map(x => x.event === 'flush' ? { ...x, failures: 1 } : x),
    e => e.map(x => x.event === 'flush' ? { ...x, queue_depth: 1 } : x),
    e => [...e.slice(0, -2), e.at(-1), e.at(-2)],
    e => [...e, e[0]],
  ]) expect(durableObservations(mutate(fixture()), ['phase-id'], [{ event_id: 'sqlite-id' }]).drained_shutdown).toBe(false);
  expect(durableObservations(fixture(), ['phase-id'], [{ event_id: 'sqlite-id' }, { event_id: 'sqlite-id' }]).duplicate_events).toBe(1);
});

test('exact cancellation requires correlated ordered once-only lifecycle', () => {
  expect(exactCancellation(fixture(), 'phase-id')).toBe(true);
  for (const name of ['guard-acquire', 'stream-open', 'guard-release', 'finalized', 'recorded']) {
    const events = fixture();
    expect(exactCancellation(events.filter(e => e.event !== name), 'phase-id')).toBe(false);
    expect(exactCancellation([...events, events.find(e => e.event === name)], 'phase-id')).toBe(false);
  }
  expect(exactCancellation(fixture().map(e => e.event === 'finalized' ? { ...e, status: 200 } : e), 'phase-id')).toBe(false);
  expect(exactCancellation(fixture().map(e => e.event === 'guard-release' ? { ...e, request_id: 'unrelated' } : e), 'phase-id')).toBe(false);
  expect(exactCancellation(fixture().reverse(), 'phase-id')).toBe(false);
});

test('postcommit proof requires actual delivery, injected failure and no second attempt', () => {
  const faults = [{ id: 'b7-postcommit-0', committed: true, failure_injected: true, failure_observed: true }];
  const executions = [{ id: 'b7-postcommit-0', status: 200 }];
  expect(postcommitReplayPrevented(faults, executions)).toBe(true);
  for (const field of ['committed', 'failure_injected', 'failure_observed']) {
    expect(postcommitReplayPrevented([{ ...faults[0], [field]: false }], executions)).toBe(false);
  }
  expect(postcommitReplayPrevented(faults, [...executions, { ...executions[0], status: 429 }])).toBe(false);
  expect(postcommitReplayPrevented([], executions)).toBe(false);
});

test('journal subscribes before events and retains complete structured observations', async () => {
  const journal = observationJournal();
  const observed = journal.wait(events => events.some(e => e.event === 'commit'));
  journal.line('INFO history_observation={"event":"commit","event_ids":["id"],"write_ms":1.5}');
  await observed;
  expect(journal.events[0].write_ms).toBe(1.5);
  expect(() => journal.line('INFO history_observation={invalid}')).toThrow();
});

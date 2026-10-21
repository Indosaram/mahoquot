import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixture } from '../cliproxy-parity.mjs';
import { runResilienceBenchmark } from '../../../scripts/bench-resilience.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function validateResilienceReport(report) {
  if (!report || typeof report !== 'object') throw new Error('resilience report must be an object');
  if (report.matrix !== 'B6-B7,B10-B13') throw new Error(`unexpected matrix: ${report.matrix}`);
  if (!report.correctness_passed) throw new Error('correctness gate failed in resilience report');

  const b6 = report.b6_burst_refresh;
  const b7 = report.b7_scoped_limits;
  const b10 = report.b10_slow_client;
  const b11 = report.b11_concurrency_ceiling;
  const b12 = report.b12_config_reload;
  const b13 = report.b13_sqlite_telemetry;

  const b6Passed = Boolean(
    b6 &&
    b6.burst_size === 100 &&
    b6.exact_refresh_count === 1 &&
    b6.replay_success_count === 100 &&
    b6.disk_token_preserved === true &&
    b6.token_generation >= 2 &&
    b6.storm_p99_ms > 0
  );

  const b7Passed = Boolean(
    b7 &&
    b7.rate_limits_injected > 0 &&
    b7.properly_scoped_cooling === true &&
    b7.failover_budget_respected === true &&
    b7.committed_replay_prevented === true &&
    b7.false_account_exclusion_count === 0 &&
    b7.average_failover_ms !== null &&
    b7.average_failover_ms > 0
  );

  const b10Passed = Boolean(
    b10 &&
    b10.slow_clients_tested === 20 &&
    b10.aborts_tested === 10 &&
    b10.guard_released_once_count === 30 &&
    b10.leaked_guards === 0 &&
    b10.zombie_upstream_tasks === 0 &&
    b10.abandoned_work_drained === true
  );

  const b11Passed = Boolean(
    b11 &&
    b11.target_concurrency === 525 &&
    b11.accepted_concurrency === 512 &&
    b11.admission_503_count === 13 &&
    b11.early_gate_release_count === 0 &&
    b11.history_memory_bounded === true &&
    b11.peak_rss_bytes !== null &&
    b11.peak_rss_bytes > 0 &&
    b11.peak_fds !== null &&
    b11.peak_fds > 0
  );

  const b12Passed = Boolean(
    b12 &&
    b12.reload_during_traffic_count === 5 &&
    b12.stale_credential_resurrections === 0 &&
    b12.next_request_updated === true &&
    b12.errors_during_reload === 0 &&
    b12.pause_time_ms !== null
  );

  const b13Passed = Boolean(
    b13 &&
    b13.telemetry_events_emitted === 100 &&
    b13.duplicate_events === 0 &&
    b13.dropped_rows === 0 &&
    b13.drained_shutdown === true &&
    b13.p99_write_ms > 0
  );

  return {
    b6Passed,
    b7Passed,
    b10Passed,
    b11Passed,
    b12Passed,
    b13Passed,
    b6_b7_recorded: b6Passed && b7Passed,
    b10_b13_recorded: b10Passed && b11Passed && b12Passed && b13Passed,
  };
}

export async function runCase(variant, evidencePath, context) {
  if (!['happy', 'failure'].includes(variant)) throw new Error(`unknown variant: ${variant}`);
  const base = await runFixture('happy', `${evidencePath}.fixture.json`);

  const events = [...base.events];
  await mkdir(dirname(evidencePath), { recursive: true });

  const targetDir = join(dirname(context.binary), '..');
  const benchBin = join(targetDir, 'debug/bench');

  const env = {
    ...process.env,
    BENCH: benchBin,
    GWBIN: context.binary,
    BENCH_EVIDENCE: `${evidencePath}.resilience-dir`,
    CARGO_TARGET_DIR: targetDir,
    GW_PORT: String(context.ports[0]),
    MOCK_PORT: String(context.ports[1]),
  };

  let b6_b7_recorded = false;
  let b10_b13_recorded = false;
  let leakedGuardDetected = false;
  let incompleteLogDetected = false;
  let report = null;

  if (variant === 'happy') {
    report = await runResilienceBenchmark(env);
    const verified = validateResilienceReport(report);
    b6_b7_recorded = verified.b6_b7_recorded;
    b10_b13_recorded = verified.b10_b13_recorded;

    events.push({
      type: 'bench-resilience-measured-b6',
      burst_size: report.b6_burst_refresh.burst_size,
      exact_refresh_count: report.b6_burst_refresh.exact_refresh_count,
      replay_success_count: report.b6_burst_refresh.replay_success_count,
      disk_token_preserved: report.b6_burst_refresh.disk_token_preserved,
      token_generation: report.b6_burst_refresh.token_generation,
      storm_p99_ms: report.b6_burst_refresh.storm_p99_ms,
      passed: verified.b6Passed,
    });

    events.push({
      type: 'bench-resilience-measured-b7',
      rate_limits_injected: report.b7_scoped_limits.rate_limits_injected,
      properly_scoped_cooling: report.b7_scoped_limits.properly_scoped_cooling,
      average_failover_ms: report.b7_scoped_limits.average_failover_ms,
      false_account_exclusion_count: report.b7_scoped_limits.false_account_exclusion_count,
      passed: verified.b7Passed,
    });

    events.push({
      type: 'bench-resilience-measured-b10',
      slow_clients_tested: report.b10_slow_client.slow_clients_tested,
      aborts_tested: report.b10_slow_client.aborts_tested,
      leaked_guards: report.b10_slow_client.leaked_guards,
      abandoned_work_drained: report.b10_slow_client.abandoned_work_drained,
      outstanding_fds: report.b10_slow_client.outstanding_fds,
      outstanding_rss_bytes: report.b10_slow_client.outstanding_rss_bytes,
      passed: verified.b10Passed,
    });

    events.push({
      type: 'bench-resilience-measured-b11',
      target_concurrency: report.b11_concurrency_ceiling.target_concurrency,
      accepted_concurrency: report.b11_concurrency_ceiling.accepted_concurrency,
      admission_503_count: report.b11_concurrency_ceiling.admission_503_count,
      early_gate_release_count: report.b11_concurrency_ceiling.early_gate_release_count,
      throughput_rps: report.b11_concurrency_ceiling.throughput_rps,
      peak_rss_bytes: report.b11_concurrency_ceiling.peak_rss_bytes,
      peak_fds: report.b11_concurrency_ceiling.peak_fds,
      history_memory_bounded: report.b11_concurrency_ceiling.history_memory_bounded,
      passed: verified.b11Passed,
    });

    events.push({
      type: 'bench-resilience-measured-b12',
      reload_during_traffic_count: report.b12_config_reload.reload_during_traffic_count,
      stale_credential_resurrections: report.b12_config_reload.stale_credential_resurrections,
      next_request_updated: report.b12_config_reload.next_request_updated,
      pause_time_ms: report.b12_config_reload.pause_time_ms,
      passed: verified.b12Passed,
    });

    events.push({
      type: 'bench-resilience-measured-b13',
      telemetry_events_emitted: report.b13_sqlite_telemetry.telemetry_events_emitted,
      duplicate_events: report.b13_sqlite_telemetry.duplicate_events,
      dropped_rows: report.b13_sqlite_telemetry.dropped_rows,
      drained_shutdown: report.b13_sqlite_telemetry.drained_shutdown,
      p99_write_ms: report.b13_sqlite_telemetry.p99_write_ms,
      peak_rss_bytes: report.b13_sqlite_telemetry.peak_rss_bytes,
      passed: verified.b13Passed,
    });
  } else {
    // Failure variant:
    // Run the real measured benchmark to get a live measured report.
    // Then corrupt the real report to verify that the audit detector
    // strictly detects and rejects defect states (leaked guards and dropped telemetry rows).
    report = await runResilienceBenchmark(env);

    const corruptGuardReport = JSON.parse(JSON.stringify(report));
    corruptGuardReport.b10_slow_client.leaked_guards = 5;
    corruptGuardReport.b10_slow_client.abandoned_work_drained = false;
    try {
      const v = validateResilienceReport(corruptGuardReport);
      leakedGuardDetected = !v.b10Passed;
    } catch {
      leakedGuardDetected = true;
    }

    const corruptLogReport = JSON.parse(JSON.stringify(report));
    corruptLogReport.b13_sqlite_telemetry.dropped_rows = 15;
    corruptLogReport.b13_sqlite_telemetry.drained_shutdown = false;
    try {
      const v = validateResilienceReport(corruptLogReport);
      incompleteLogDetected = !v.b13Passed;
    } catch {
      incompleteLogDetected = true;
    }

    events.push({
      type: 'bench-resilience-leaked-guard-detected',
      real_leaked: report.b10_slow_client.leaked_guards,
      corrupted_leaked: corruptGuardReport.b10_slow_client.leaked_guards,
      detected: leakedGuardDetected,
    });

    events.push({
      type: 'bench-resilience-incomplete-log-fails',
      real_dropped: report.b13_sqlite_telemetry.dropped_rows,
      corrupted_dropped: corruptLogReport.b13_sqlite_telemetry.dropped_rows,
      detected: incompleteLogDetected,
    });
  }

  const assertions = variant === 'happy'
    ? [
        { id: 'b6-b7-recorded', expected: true, actual: b6_b7_recorded, pass: b6_b7_recorded === true },
        { id: 'b10-b13-recorded', expected: true, actual: b10_b13_recorded, pass: b10_b13_recorded === true },
      ]
    : [
        {
          id: 'leaked-guard-detected',
          expected: true,
          actual: leakedGuardDetected,
          pass: leakedGuardDetected === true,
        },
        {
          id: 'incomplete-log-fails',
          expected: true,
          actual: incompleteLogDetected,
          pass: incompleteLogDetected === true,
        },
      ];

  const benchSha = await Bun.file(benchBin).exists()
    ? createHash('sha256').update(await readFile(benchBin)).digest('hex')
    : createHash('sha256').update(context.binary).digest('hex');

  const receipt = context.createReceipt({
    caseName: 'bench-resilience',
    variant,
    assertions,
    requiredAssertionIds: assertions.map(a => a.id),
    events,
    wireRequests: [...base.wire_capture.gateway_requests],
    provenance: {
      ...base.provenance,
      bench_sha256: benchSha,
      matrix: 'B6-B7,B10-B13',
      resilience_report_path: `${evidencePath}.resilience-dir/resilience-report.json`,
      measured_b_metrics: {
        b6_burst_size: report.b6_burst_refresh.burst_size,
        b6_exact_refresh_count: report.b6_burst_refresh.exact_refresh_count,
        b6_replay_success_count: report.b6_burst_refresh.replay_success_count,
        b6_disk_token_preserved: report.b6_burst_refresh.disk_token_preserved,
        b6_token_generation: report.b6_burst_refresh.token_generation,
        b6_storm_p99_ms: report.b6_burst_refresh.storm_p99_ms,
        b7_rate_limits_injected: report.b7_scoped_limits.rate_limits_injected,
        b7_properly_scoped_cooling: report.b7_scoped_limits.properly_scoped_cooling,
        b7_average_failover_ms: report.b7_scoped_limits.average_failover_ms,
        b7_false_account_exclusion_count: report.b7_scoped_limits.false_account_exclusion_count,
        b10_slow_clients_tested: report.b10_slow_client.slow_clients_tested,
        b10_aborts_tested: report.b10_slow_client.aborts_tested,
        b10_leaked_guards: report.b10_slow_client.leaked_guards,
        b10_abandoned_work_drained: report.b10_slow_client.abandoned_work_drained,
        b10_outstanding_fds: report.b10_slow_client.outstanding_fds,
        b10_outstanding_rss_bytes: report.b10_slow_client.outstanding_rss_bytes,
        b11_target_concurrency: report.b11_concurrency_ceiling.target_concurrency,
        b11_accepted_concurrency: report.b11_concurrency_ceiling.accepted_concurrency,
        b11_admission_503_count: report.b11_concurrency_ceiling.admission_503_count,
        b11_early_gate_release_count: report.b11_concurrency_ceiling.early_gate_release_count,
        b11_throughput_rps: report.b11_concurrency_ceiling.throughput_rps,
        b11_peak_rss_bytes: report.b11_concurrency_ceiling.peak_rss_bytes,
        b11_peak_fds: report.b11_concurrency_ceiling.peak_fds,
        b11_history_memory_bounded: report.b11_concurrency_ceiling.history_memory_bounded,
        b12_reload_during_traffic_count: report.b12_config_reload.reload_during_traffic_count,
        b12_stale_credential_resurrections: report.b12_config_reload.stale_credential_resurrections,
        b12_next_request_updated: report.b12_config_reload.next_request_updated,
        b12_pause_time_ms: report.b12_config_reload.pause_time_ms,
        b13_telemetry_events_emitted: report.b13_sqlite_telemetry.telemetry_events_emitted,
        b13_duplicate_events: report.b13_sqlite_telemetry.duplicate_events,
        b13_dropped_rows: report.b13_sqlite_telemetry.dropped_rows,
        b13_drained_shutdown: report.b13_sqlite_telemetry.drained_shutdown,
        b13_p99_write_ms: report.b13_sqlite_telemetry.p99_write_ms,
        b13_peak_rss_bytes: report.b13_sqlite_telemetry.peak_rss_bytes,
      },
    },
    teardown: base.teardown,
  });

  await writeFile(evidencePath, JSON.stringify(receipt, null, 2));
  return receipt;
}

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TtftStats {
    pub mean: f64,
    pub p50: f64,
    pub p90: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BenchReport {
    pub total: usize,
    pub concurrency: usize,
    pub successful: usize,
    pub failed: usize,
    pub wall_time_secs: f64,
    pub rps: f64,
    pub ttft_ms: TtftStats,
    pub errors: BTreeMap<String, usize>,
}

/// Compute nearest-rank percentile for a sorted slice:
/// idx = ceil(p / 100 * n) - 1, clamped to [0, n - 1].
pub fn nearest_rank_percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let n = sorted.len();
    let rank = ((p / 100.0) * n as f64).ceil() as usize;
    let idx = rank.saturating_sub(1).min(n - 1);
    sorted[idx]
}

pub fn calculate_mean(samples: &[f64]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    samples.iter().sum::<f64>() / samples.len() as f64
}

#[derive(Debug, Clone)]
pub struct StatsInput<'a> {
    pub total: usize,
    pub concurrency: usize,
    pub wall_time_secs: f64,
    pub sorted_ttft_ms: &'a [f64],
    pub errors: BTreeMap<String, usize>,
}

pub fn compute_report(input: StatsInput<'_>) -> BenchReport {
    let successful = input.sorted_ttft_ms.len();
    let failed = input.errors.values().sum();
    let rps = if input.wall_time_secs > 0.0 {
        input.total as f64 / input.wall_time_secs
    } else {
        0.0
    };

    let ttft_ms = TtftStats {
        mean: calculate_mean(input.sorted_ttft_ms),
        p50: nearest_rank_percentile(input.sorted_ttft_ms, 50.0),
        p90: nearest_rank_percentile(input.sorted_ttft_ms, 90.0),
        p95: nearest_rank_percentile(input.sorted_ttft_ms, 95.0),
        p99: nearest_rank_percentile(input.sorted_ttft_ms, 99.0),
        max: nearest_rank_percentile(input.sorted_ttft_ms, 100.0),
    };

    BenchReport {
        total: input.total,
        concurrency: input.concurrency,
        successful,
        failed,
        wall_time_secs: input.wall_time_secs,
        rps,
        ttft_ms,
        errors: input.errors,
    }
}

pub fn format_summary_line(report: &BenchReport) -> String {
    format!(
        "SUMMARY total={} conc={} p50={:.2}ms p99={:.2}ms rps={:.1} err={}",
        report.total,
        report.concurrency,
        report.ttft_ms.p50,
        report.ttft_ms.p99,
        report.rps,
        report.failed
    )
}

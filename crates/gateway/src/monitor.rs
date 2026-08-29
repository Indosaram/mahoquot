use serde::Serialize;
use std::collections::HashMap;
use std::fmt::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const RING_CAPACITY: usize = 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TtftSnapshot {
    pub p50_ms: f64,
    pub p90_ms: f64,
    pub p99_ms: f64,
    pub samples: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LastError {
    pub unix_ms: i64,
    pub status: u16,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct PromAccount {
    pub id: String,
    pub ok: u64,
    pub fails: u64,
    pub cooldown_until_unix_ms: Option<i64>,
}

#[derive(Debug)]
struct RingBuffer {
    samples: Vec<f64>,
    head: usize,
    is_full: bool,
}

impl Default for RingBuffer {
    fn default() -> Self {
        Self {
            samples: Vec::with_capacity(RING_CAPACITY),
            head: 0,
            is_full: false,
        }
    }
}

impl RingBuffer {
    fn push(&mut self, sample: f64) {
        if !self.is_full {
            self.samples.push(sample);
            self.is_full = self.samples.len() == RING_CAPACITY;
        } else {
            self.samples[self.head] = sample;
            self.head = (self.head + 1) % RING_CAPACITY;
        }
    }

    fn snapshot(&self) -> TtftSnapshot {
        if self.samples.is_empty() {
            return TtftSnapshot {
                p50_ms: 0.0,
                p90_ms: 0.0,
                p99_ms: 0.0,
                samples: 0,
            };
        }
        let mut sorted = self.samples.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        TtftSnapshot {
            p50_ms: calc_percentile(&sorted, 0.50),
            p90_ms: calc_percentile(&sorted, 0.90),
            p99_ms: calc_percentile(&sorted, 0.99),
            samples: sorted.len(),
        }
    }
}

fn calc_percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let idx = p * (sorted.len() - 1) as f64;
    let (lower, upper) = (idx.floor() as usize, idx.ceil() as usize);
    if lower == upper {
        sorted[lower]
    } else {
        let weight = idx - lower as f64;
        sorted[lower] * (1.0 - weight) + sorted[upper] * weight
    }
}

fn escape_label_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str(r#"\""#),
            '\n' => out.push_str(r"\n"),
            _ => out.push(c),
        }
    }
    out
}

#[derive(Debug)]
pub struct InFlightGuard {
    state: Arc<MonitorState>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.state.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Debug)]
pub struct MonitorState {
    started_at_unix_ms: i64,
    in_flight: AtomicU64,
    global_ttft: Mutex<RingBuffer>,
    account_ttft: Mutex<HashMap<String, RingBuffer>>,
    last_errors: Mutex<HashMap<String, LastError>>,
}

impl Default for MonitorState {
    fn default() -> Self {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Self::new(now_ms)
    }
}

impl MonitorState {
    pub fn new(now_unix_ms: i64) -> Self {
        Self {
            started_at_unix_ms: now_unix_ms,
            in_flight: AtomicU64::new(0),
            global_ttft: Mutex::new(RingBuffer::default()),
            account_ttft: Mutex::new(HashMap::new()),
            last_errors: Mutex::new(HashMap::new()),
        }
    }

    pub fn uptime_secs(&self, now_unix_ms: i64) -> u64 {
        if now_unix_ms > self.started_at_unix_ms {
            ((now_unix_ms - self.started_at_unix_ms) / 1000) as u64
        } else {
            0
        }
    }

    pub fn in_flight(&self) -> u64 {
        self.in_flight.load(Ordering::SeqCst)
    }

    pub fn track_in_flight(self: &Arc<Self>) -> InFlightGuard {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        InFlightGuard {
            state: Arc::clone(self),
        }
    }

    pub fn record_ttft(&self, account_id: &str, ttft_ms: f64) {
        if let Ok(mut global) = self.global_ttft.lock() {
            global.push(ttft_ms);
        }
        if let Ok(mut accounts) = self.account_ttft.lock() {
            accounts
                .entry(account_id.to_string())
                .or_default()
                .push(ttft_ms);
        }
    }

    pub fn ttft_percentiles(&self) -> TtftSnapshot {
        self.global_ttft
            .lock()
            .map(|g| g.snapshot())
            .unwrap_or_else(|_| TtftSnapshot {
                p50_ms: 0.0,
                p90_ms: 0.0,
                p99_ms: 0.0,
                samples: 0,
            })
    }

    pub fn account_ttft(&self, account_id: &str) -> Option<TtftSnapshot> {
        self.account_ttft
            .lock()
            .ok()
            .and_then(|accounts| accounts.get(account_id).map(|buf| buf.snapshot()))
    }

    pub fn record_error(&self, account_id: &str, status: u16, message: &str) {
        let unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let entry = LastError {
            unix_ms,
            status,
            message: message.to_string(),
        };
        if let Ok(mut errors) = self.last_errors.lock() {
            errors.insert(account_id.to_string(), entry);
        }
    }

    pub fn last_error(&self, account_id: &str) -> Option<LastError> {
        self.last_errors
            .lock()
            .ok()
            .and_then(|errors| errors.get(account_id).cloned())
    }

    pub fn render_prometheus(&self, now_unix_ms: i64, accounts: &[PromAccount]) -> String {
        let mut out = String::new();
        let _ = writeln!(out, "# HELP mahoquot_uptime_seconds Process uptime in seconds.\n# TYPE mahoquot_uptime_seconds gauge\nmahoquot_uptime_seconds {}", self.uptime_secs(now_unix_ms));
        let _ = writeln!(out, "# HELP mahoquot_in_flight_requests Current number of in-flight requests.\n# TYPE mahoquot_in_flight_requests gauge\nmahoquot_in_flight_requests {}", self.in_flight());

        let ttft = self.ttft_percentiles();
        let _ = writeln!(
            out,
            "# HELP mahoquot_ttft_milliseconds TTFT percentiles in milliseconds.\n# TYPE mahoquot_ttft_milliseconds gauge\nmahoquot_ttft_milliseconds{{quantile=\"0.5\"}} {}\nmahoquot_ttft_milliseconds{{quantile=\"0.9\"}} {}\nmahoquot_ttft_milliseconds{{quantile=\"0.99\"}} {}",
            ttft.p50_ms, ttft.p90_ms, ttft.p99_ms
        );

        let _ = writeln!(out, "# HELP mahoquot_account_requests_total Total request count per account.\n# TYPE mahoquot_account_requests_total counter");
        for acc in accounts {
            let id = escape_label_value(&acc.id);
            let _ = writeln!(
                out,
                "mahoquot_account_requests_total{{account=\"{id}\",outcome=\"ok\"}} {}",
                acc.ok
            );
            let _ = writeln!(
                out,
                "mahoquot_account_requests_total{{account=\"{id}\",outcome=\"fail\"}} {}",
                acc.fails
            );
        }

        let _ = writeln!(out, "# HELP mahoquot_account_cooldown_until_seconds Cooldown target timestamp in seconds.\n# TYPE mahoquot_account_cooldown_until_seconds gauge");
        for acc in accounts {
            let id = escape_label_value(&acc.id);
            let cooldown = match acc.cooldown_until_unix_ms {
                Some(until_ms) if until_ms > now_unix_ms => until_ms / 1000,
                _ => 0,
            };
            let _ = writeln!(
                out,
                "mahoquot_account_cooldown_until_seconds{{account=\"{id}\"}} {cooldown}"
            );
        }
        out
    }
}

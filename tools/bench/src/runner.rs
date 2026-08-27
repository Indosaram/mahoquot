use crate::stats::{compute_report, format_summary_line, BenchReport, StatsInput};
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::task::JoinSet;

const DEFAULT_BODY: &str = r#"{"model":"bench","stream":true}"#;

#[derive(Debug, Clone)]
pub struct BenchConfig {
    pub url: String,
    pub concurrency: usize,
    pub total: usize,
    pub out: PathBuf,
    pub headers: Vec<String>,
    pub body_json: Option<String>,
    pub timeout_ms: u64,
}

#[derive(Debug)]
pub enum SampleResult {
    Success { ttft_ms: f64 },
    Error { kind: String },
}

pub fn parse_headers(
    raw_headers: &[String],
) -> Result<HeaderMap, Box<dyn std::error::Error + Send + Sync>> {
    let mut map = HeaderMap::new();
    for h in raw_headers {
        let (k, v) = h
            .split_once(':')
            .ok_or_else(|| format!("invalid header format (expected 'Key: Value'): {h}"))?;
        let name = HeaderName::from_bytes(k.trim().as_bytes())?;
        let val = HeaderValue::from_str(v.trim())?;
        map.append(name, val);
    }
    if !map.contains_key(CONTENT_TYPE) {
        map.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    Ok(map)
}

fn map_reqwest_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "io:timeout".to_string()
    } else if err.is_connect() {
        "io:connect".to_string()
    } else if err.is_body() || err.is_decode() {
        "io:body".to_string()
    } else {
        "io:error".to_string()
    }
}

#[derive(Clone)]
pub struct RequestParams<'a> {
    pub client: &'a reqwest::Client,
    pub url: &'a str,
    pub headers: HeaderMap,
    pub body: Arc<String>,
    pub timeout: Duration,
}

pub async fn run_single_request(params: RequestParams<'_>) -> SampleResult {
    let start = Instant::now();
    let resp = match params
        .client
        .post(params.url)
        .headers(params.headers)
        .body(params.body.as_str().to_string())
        .timeout(params.timeout)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return SampleResult::Error {
                kind: map_reqwest_error(&e),
            };
        }
    };

    let status = resp.status();
    if !status.is_success() {
        return SampleResult::Error {
            kind: format!("status:{}", status.as_u16()),
        };
    }

    let mut stream = resp.bytes_stream();
    let first = match stream.next().await {
        Some(Ok(bytes)) => bytes,
        Some(Err(e)) => {
            return SampleResult::Error {
                kind: map_reqwest_error(&e),
            };
        }
        None => {
            return SampleResult::Error {
                kind: "io:empty_body".to_string(),
            };
        }
    };

    let ttft_ms = start.elapsed().as_secs_f64() * 1000.0;
    if first.is_empty() {
        // Continue draining
    }

    while let Some(chunk) = stream.next().await {
        if let Err(e) = chunk {
            return SampleResult::Error {
                kind: map_reqwest_error(&e),
            };
        }
    }

    SampleResult::Success { ttft_ms }
}

pub async fn run_benchmark(
    cfg: BenchConfig,
) -> Result<BenchReport, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::builder().build()?;
    let parsed_headers = parse_headers(&cfg.headers)?;
    let body = Arc::new(cfg.body_json.unwrap_or_else(|| DEFAULT_BODY.to_string()));
    let timeout = Duration::from_millis(cfg.timeout_ms);
    let concurrency = cfg.concurrency.max(1);

    let wall_start = Instant::now();
    let mut set = JoinSet::new();
    let mut spawned = 0;
    let mut results = Vec::with_capacity(cfg.total);

    while spawned < cfg.total || !set.is_empty() {
        while spawned < cfg.total && set.len() < concurrency {
            let cl = client.clone();
            let u = cfg.url.clone();
            let hdrs = parsed_headers.clone();
            let b = Arc::clone(&body);
            set.spawn(async move {
                run_single_request(RequestParams {
                    client: &cl,
                    url: &u,
                    headers: hdrs,
                    body: b,
                    timeout,
                })
                .await
            });
            spawned += 1;
        }

        if let Some(res) = set.join_next().await {
            match res {
                Ok(sample) => results.push(sample),
                Err(_) => results.push(SampleResult::Error {
                    kind: "io:task_join".to_string(),
                }),
            }
        }
    }

    let wall_time_secs = wall_start.elapsed().as_secs_f64();

    let mut ttft_samples = Vec::new();
    let mut errors: BTreeMap<String, usize> = BTreeMap::new();

    for r in results {
        match r {
            SampleResult::Success { ttft_ms } => ttft_samples.push(ttft_ms),
            SampleResult::Error { kind } => {
                *errors.entry(kind).or_insert(0) += 1;
            }
        }
    }

    ttft_samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let report = compute_report(StatsInput {
        total: cfg.total,
        concurrency: cfg.concurrency,
        wall_time_secs,
        sorted_ttft_ms: &ttft_samples,
        errors,
    });

    let json_bytes = serde_json::to_vec_pretty(&report)?;
    tokio::fs::write(&cfg.out, json_bytes).await?;

    let summary_line = format_summary_line(&report);
    println!("{summary_line}");

    Ok(report)
}

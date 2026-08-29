use crate::mock::{create_mock_router, MockConfig, MockState};
use crate::runner::{parse_headers, run_benchmark, run_single_request, BenchConfig, RequestParams};
use crate::stats::{nearest_rank_percentile, BenchReport};
use futures::StreamExt;
use reqwest::header::HeaderMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn test_nearest_rank_percentile_pure_fn() {
    // Given: 100 sorted samples from 1.0 to 100.0
    let samples: Vec<f64> = (1..=100).map(|x| x as f64).collect();

    // When & Then: nearest rank percentiles match formula ceil(p/100*n)-1
    assert_eq!(nearest_rank_percentile(&samples, 50.0), 50.0);
    assert_eq!(nearest_rank_percentile(&samples, 90.0), 90.0);
    assert_eq!(nearest_rank_percentile(&samples, 95.0), 95.0);
    assert_eq!(nearest_rank_percentile(&samples, 99.0), 99.0);
    assert_eq!(nearest_rank_percentile(&samples, 100.0), 100.0);

    // Edge cases
    assert_eq!(nearest_rank_percentile(&[], 50.0), 0.0);

    let single = vec![42.0];
    assert_eq!(nearest_rank_percentile(&single, 50.0), 42.0);
    assert_eq!(nearest_rank_percentile(&single, 99.0), 42.0);
}

#[tokio::test]
async fn test_codex_protocol_mock_emits_responses_event_sequence() {
    let cfg = MockConfig {
        port: 0,
        ttft_ms: 0,
        chunks: 3,
        fail_first_n: 0,
        fail_status: 429,
        protocol: crate::mock::MockProtocol::Codex,
    };
    let state = Arc::new(MockState::new(&cfg));
    let app = create_mock_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral");
    let port = listener.local_addr().expect("local addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve mock");
    });

    let body = reqwest::Client::new()
        .post(format!(
            "http://127.0.0.1:{port}/backend-api/codex/responses"
        ))
        .body(r#"{"model":"gpt-bench"}"#)
        .send()
        .await
        .expect("send codex req")
        .text()
        .await
        .expect("codex body");

    let events: Vec<&str> = body
        .lines()
        .filter_map(|l| l.strip_prefix("event: "))
        .collect();
    assert_eq!(
        events,
        vec![
            "response.created",
            "response.output_item.added",
            "response.content_part.added",
            "response.output_text.delta",
            "response.output_text.delta",
            "response.output_text.delta",
            "response.output_item.done",
            "response.completed",
        ]
    );
    assert!(!body.contains("chat.completion.chunk"));
    assert!(!body.contains("data: [DONE]"));
    assert!(body.contains(r#""usage":{"input_tokens":16,"output_tokens":20,"total_tokens":36}"#));
}

#[tokio::test]
async fn test_in_process_mock_ephemeral_port() {
    // Given: an ephemeral mock server with ttft_ms = 40, chunks = 3, fail_first_n = 1, fail_status = 429
    let cfg = MockConfig {
        port: 0,
        ttft_ms: 40,
        chunks: 3,
        fail_first_n: 1,
        fail_status: 429,
        protocol: crate::mock::MockProtocol::OpenAi,
    };
    let state = Arc::new(MockState::new(&cfg));
    let app = create_mock_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral");
    let port = listener.local_addr().expect("local addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve mock");
    });

    let client = reqwest::Client::new();
    let url_chat = format!("http://127.0.0.1:{port}/v1/chat/completions");
    let url_codex = format!("http://127.0.0.1:{port}/backend-api/codex/responses");

    // When 1: first request hits fail_first_n=1 -> should fail with 429
    let resp1 = client
        .post(&url_chat)
        .body(r#"{"model":"test"}"#)
        .send()
        .await
        .expect("send req1");
    assert_eq!(resp1.status().as_u16(), 429);
    let body1 = resp1.text().await.expect("text body1");
    assert_eq!(body1, r#"{"error":"mock"}"#);

    // When 2: second request to /v1/chat/completions -> succeeds with SSE stream >= 40ms TTFT
    let start2 = Instant::now();
    let resp2 = client
        .post(&url_chat)
        .body(r#"{"model":"test"}"#)
        .send()
        .await
        .expect("send req2");
    assert_eq!(resp2.status().as_u16(), 200);

    let mut stream2 = resp2.bytes_stream();
    let first_chunk = stream2.next().await.expect("first chunk").expect("bytes");
    let ttft = start2.elapsed();
    assert!(
        ttft >= Duration::from_millis(35),
        "TTFT {ttft:?} was under 35ms floor"
    );
    assert!(!first_chunk.is_empty());

    let mut full_body = String::from_utf8_lossy(&first_chunk).to_string();
    while let Some(chunk) = stream2.next().await {
        let b = chunk.expect("subsequent chunk");
        full_body.push_str(&String::from_utf8_lossy(&b));
    }
    assert!(
        full_body.contains("data: [DONE]\n\n"),
        "body missing [DONE]"
    );
    assert!(
        full_body.contains("chatcmpl-bench"),
        "body missing chat chunk"
    );

    // When 3: third request to /backend-api/codex/responses
    let resp3 = client
        .post(&url_codex)
        .body(r#"{"model":"test"}"#)
        .send()
        .await
        .expect("send req3");
    assert_eq!(resp3.status().as_u16(), 200);
}

#[tokio::test]
async fn test_50req_10conc_zero_error_run() {
    // Given: an ephemeral mock server with ttft_ms = 5, chunks = 2, fail_first_n = 0
    let cfg = MockConfig {
        port: 0,
        ttft_ms: 5,
        chunks: 2,
        fail_first_n: 0,
        fail_status: 429,
        protocol: crate::mock::MockProtocol::OpenAi,
    };
    let state = Arc::new(MockState::new(&cfg));
    let app = create_mock_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral");
    let port = listener.local_addr().expect("local addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve mock");
    });

    let out_dir = std::env::temp_dir();
    let out_file = out_dir.join(format!("bench_test_{}.json", port));

    let bench_cfg = BenchConfig {
        url: format!("http://127.0.0.1:{port}/v1/chat/completions"),
        concurrency: 10,
        total: 50,
        out: out_file.clone(),
        headers: vec!["Authorization: Bearer test-token".to_string()],
        body_json: Some(r#"{"model":"test-pinned-body"}"#.to_string()),
        timeout_ms: 5000,
    };

    // When: run benchmark
    let report = run_benchmark(bench_cfg).await.expect("run benchmark");

    // Then: 50 total, 50 successful, 0 failed
    assert_eq!(report.total, 50);
    assert_eq!(report.concurrency, 10);
    assert_eq!(report.successful, 50);
    assert_eq!(report.failed, 0);
    assert!(report.errors.is_empty());
    assert!(report.ttft_ms.p50 >= 4.0);

    // Verify output file
    let file_content = tokio::fs::read_to_string(&out_file)
        .await
        .expect("read out json");
    let parsed: BenchReport = serde_json::from_str(&file_content).expect("parse report json");
    assert_eq!(parsed.total, 50);
    assert_eq!(parsed.failed, 0);

    let _ = tokio::fs::remove_file(out_file).await;
}

#[tokio::test]
async fn test_headers_and_body_json_literal_pinning() {
    // Given: multiple headers and custom literal body
    let raw_headers = vec![
        "Authorization: Bearer test-token".to_string(),
        "X-Custom-Trace: req-12345".to_string(),
        "User-Agent: mahoquot-bench".to_string(),
    ];
    let parsed = parse_headers(&raw_headers).expect("parse headers");
    assert_eq!(
        parsed.get("authorization").expect("auth header"),
        "Bearer test-token"
    );
    assert_eq!(
        parsed.get("x-custom-trace").expect("trace header"),
        "req-12345"
    );
    assert_eq!(
        parsed.get("user-agent").expect("agent header"),
        "mahoquot-bench"
    );
    assert_eq!(
        parsed.get("content-type").expect("content type"),
        "application/json"
    );

    // Test in-process single request pinning
    let cfg = MockConfig {
        port: 0,
        ttft_ms: 1,
        chunks: 1,
        fail_first_n: 0,
        fail_status: 429,
        protocol: crate::mock::MockProtocol::OpenAi,
    };
    let state = Arc::new(MockState::new(&cfg));
    let app = create_mock_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral");
    let port = listener.local_addr().expect("local addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve mock");
    });

    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    let body_literal = Arc::new(r#"{"pinned_key":"pinned_val"}"#.to_string());
    let mut hdrs = HeaderMap::new();
    hdrs.insert(
        reqwest::header::AUTHORIZATION,
        reqwest::header::HeaderValue::from_static("Bearer pinned"),
    );

    let res = run_single_request(RequestParams {
        client: &client,
        url: &url,
        headers: hdrs,
        body: body_literal,
        timeout: Duration::from_millis(5000),
    })
    .await;
    match res {
        crate::runner::SampleResult::Success { ttft_ms } => {
            assert!(ttft_ms > 0.0);
        }
        crate::runner::SampleResult::Error { kind } => {
            panic!("expected success, got error: {kind}");
        }
    }
}

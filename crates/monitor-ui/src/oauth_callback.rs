//! Completes OAuth logins when the gateway runs on another machine.
//!
//! The gateway binds its browser-redirect listeners to `127.0.0.1` on whatever
//! host it runs on, and hands the browser a `localhost:<port>` redirect_uri,
//! because those client IDs are registered with the providers and the redirect
//! has to match. With a local gateway those are the same loopback and nothing
//! else is needed. With a remote gateway they are two different loopbacks, so
//! the browser's redirect lands on the wrong machine and the login stalls
//! after the provider has already approved it.
//!
//! Rather than asking every machine to hand-write an `ssh -L` tunnel, the app
//! listens on the callback ports itself and replays the redirect at the
//! gateway's public `/oauth-callback` route, which performs the token exchange
//! server side. Any machine that installs the app and points it at a remote
//! gateway gets working logins with no extra setup.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

/// Ports the gateway puts in its default `redirect_uri` values, one per
/// provider: antigravity, codex, anthropic, command-code.
pub const CALLBACK_PORTS: [u16; 4] = [51121, 1455, 54545, 5959];

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(20);
const LISTEN_ADDRESS: &str = "127.0.0.1";

/// `Some(url)` replays redirects at that gateway; `None` releases the ports
/// because a local gateway binds them itself.
type Directive = Option<String>;

fn channel() -> &'static Mutex<watch::Sender<Directive>> {
    static SENDER: OnceLock<Mutex<watch::Sender<Directive>>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (sender, receiver) = watch::channel(Directive::None);
        std::thread::spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            else {
                tracing::warn!("oauth callback forwarder unavailable");
                return;
            };
            runtime.block_on(supervise(receiver, CALLBACK_PORTS.to_vec()));
        });
        Mutex::new(sender)
    })
}

/// Points the forwarder at the gateway the app is configured to use.
///
/// Safe to call repeatedly, including with a local gateway, which releases the
/// ports. Callers must pass the current base URL after every connection change
/// and not only at startup: a machine that connects to a remote gateway for the
/// first time inside the app has to start forwarding without a relaunch, and a
/// gateway that becomes local again has to get its ports back.
pub fn apply(gateway_url: &str) {
    let directive = directive_for(
        gateway_url,
        crate::gateway_target_policy(gateway_url) == crate::GatewayTargetPolicy::ManageLocal,
    );
    let sender = channel().lock().unwrap_or_else(|error| error.into_inner());
    let _ = sender.send(directive);
}

fn directive_for(gateway_url: &str, gateway_is_local: bool) -> Directive {
    if gateway_is_local {
        None
    } else {
        Some(gateway_url.to_string())
    }
}

async fn supervise(mut directives: watch::Receiver<Directive>, ports: Vec<u16>) {
    loop {
        if directives.borrow_and_update().is_none() {
            if directives.changed().await.is_err() {
                return;
            }
            continue;
        }

        let listeners = ports
            .iter()
            .map(|port| tokio::spawn(serve(*port, directives.clone())))
            .collect::<Vec<_>>();

        loop {
            match directives.changed().await {
                Ok(()) => {
                    if directives.borrow_and_update().is_none() {
                        break;
                    }
                }
                Err(_) => {
                    for listener in &listeners {
                        listener.abort();
                    }
                    return;
                }
            }
        }

        for listener in listeners {
            listener.abort();
        }
    }
}

async fn serve(port: u16, mut directives: watch::Receiver<Directive>) {
    let listener = match TcpListener::bind((LISTEN_ADDRESS, port)).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::debug!(port, %error, "oauth callback port busy");
            return;
        }
    };
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { return };
                let Some(gateway_url) = directives.borrow_and_update().clone() else { return };
                tokio::spawn(async move {
                    let _ = handle(stream, &gateway_url).await;
                });
            }
            changed = directives.changed() => {
                if changed.is_err() || directives.borrow_and_update().is_none() {
                    return;
                }
            }
        }
    }
}

struct Request {
    method: String,
    target: String,
    body: Vec<u8>,
}

async fn handle(mut stream: TcpStream, gateway_url: &str) -> std::io::Result<()> {
    let Some(request) = read_request(&mut stream).await? else {
        return write_page(&mut stream, 400, "text/plain", "Bad request").await;
    };
    let query = request
        .target
        .split_once('?')
        .map_or("", |(_, query)| query);
    let upstream = format!(
        "{}/oauth-callback{}",
        gateway_url.trim_end_matches('/'),
        if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        }
    );

    let client = match reqwest::Client::builder().timeout(UPSTREAM_TIMEOUT).build() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%error, "oauth callback client unavailable");
            return write_page(&mut stream, 500, "text/plain", "Forwarder unavailable").await;
        }
    };
    let request = if request.method.eq_ignore_ascii_case("POST") {
        client.post(&upstream).body(request.body)
    } else {
        client.get(&upstream)
    };
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, %upstream, "oauth callback forward failed");
            return write_page(
                &mut stream,
                502,
                "text/plain",
                "Could not reach the gateway from this machine.",
            )
            .await;
        }
    };
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/html; charset=utf-8")
        .to_string();
    let body = response.text().await.unwrap_or_default();
    write_page(&mut stream, status, &content_type, &body).await
}

/// Reads one whole request. The cap keeps a peer from making the app allocate
/// without limit; `None` means it connected and said nothing usable.
async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 2048];
    let head_end = loop {
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        if buffer.len() >= MAX_REQUEST_BYTES {
            return Ok(None);
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Ok(None);
    };
    let content_length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);

    let mut body = buffer[head_end..].to_vec();
    while body.len() < content_length && buffer.len() < MAX_REQUEST_BYTES {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    Ok(Some(Request {
        method: method.to_string(),
        target: target.to_string(),
        body,
    }))
}

async fn write_page(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    async fn gateway_probe() -> (String, Arc<StdMutex<Vec<String>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        let app = axum::Router::new().route(
            "/oauth-callback",
            axum::routing::any(move |uri: axum::http::Uri| {
                let recorder = Arc::clone(&recorder);
                async move {
                    recorder
                        .lock()
                        .unwrap()
                        .push(uri.query().unwrap_or("").to_string());
                    axum::response::Html("<p>forwarded</p>")
                }
            }),
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (base, seen)
    }

    async fn free_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        listener.local_addr().unwrap().port()
    }

    async fn forwarder(gateway_url: String) -> (u16, watch::Sender<Directive>) {
        let port = free_port().await;
        let (sender, receiver) = watch::channel(Directive::Some(gateway_url));
        tokio::spawn(supervise(receiver, vec![port]));
        wait_until_bound(port).await;
        (port, sender)
    }

    async fn round_trip(port: u16, request: &[u8]) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    fn port_is_free(port: u16) -> bool {
        std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
    }

    async fn wait_until_bound(port: u16) {
        for _ in 0..500 {
            if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("port {port} never accepted a connection");
    }

    async fn wait_until_free(port: u16) {
        for _ in 0..500 {
            if port_is_free(port) {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("port {port} was never released");
    }

    #[tokio::test]
    async fn redirect_query_reaches_the_gateway_callback() {
        let (base, seen) = gateway_probe().await;
        let (port, _keep) = forwarder(base).await;

        let text = round_trip(
            port,
            b"GET /callback?code=abc&state=def HTTP/1.1\r\nHost: localhost\r\n\r\n",
        )
        .await;

        assert!(text.starts_with("HTTP/1.1 200"), "{text}");
        assert!(text.contains("forwarded"), "{text}");
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            ["code=abc&state=def"],
            "the gateway must receive the redirect query verbatim"
        );
    }

    #[tokio::test]
    async fn a_redirect_without_a_query_still_reaches_the_callback() {
        let (base, seen) = gateway_probe().await;
        let (port, _keep) = forwarder(base).await;

        round_trip(port, b"GET /callback HTTP/1.1\r\nHost: localhost\r\n\r\n").await;

        assert_eq!(seen.lock().unwrap().as_slice(), [""]);
    }

    #[tokio::test]
    async fn an_unreachable_gateway_is_reported_to_the_browser() {
        let (port, _keep) = forwarder("http://127.0.0.1:1".to_string()).await;

        let text = round_trip(
            port,
            b"GET /callback?code=abc HTTP/1.1\r\nHost: localhost\r\n\r\n",
        )
        .await;

        assert!(text.starts_with("HTTP/1.1 502"), "{text}");
        assert!(text.contains("Could not reach the gateway"), "{text}");
    }

    #[tokio::test]
    async fn a_local_gateway_is_never_forwarded_and_a_remote_one_is() {
        // The gateway binds these ports itself on loopback, so the app has to
        // stand down or the two race and one of them silently loses logins.
        assert_eq!(directive_for("http://127.0.0.1:18801", true), None);
        assert_eq!(
            directive_for("http://100.91.254.71:18801", false),
            Some("http://100.91.254.71:18801".to_string())
        );
    }

    #[tokio::test]
    async fn switching_to_a_local_gateway_releases_the_ports() {
        let (base, _) = gateway_probe().await;
        let port = free_port().await;
        let (sender, receiver) = watch::channel(Directive::Some(base));
        let supervisor = tokio::spawn(supervise(receiver, vec![port]));
        wait_until_bound(port).await;

        sender.send(None).unwrap();
        wait_until_free(port).await;

        supervisor.abort();
    }

    #[tokio::test]
    async fn switching_gateways_moves_the_forwarder_to_the_new_one() {
        let (first, seen_first) = gateway_probe().await;
        let (second, seen_second) = gateway_probe().await;
        let port = free_port().await;
        let (sender, receiver) = watch::channel(Directive::Some(first));
        let supervisor = tokio::spawn(supervise(receiver, vec![port]));
        wait_until_bound(port).await;

        sender.send(Some(second)).unwrap();
        for _ in 0..500 {
            if !seen_second.lock().unwrap().is_empty() {
                break;
            }
            let _ = round_trip(
                port,
                b"GET /callback?code=c HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
            .await;
            tokio::task::yield_now().await;
        }

        assert_eq!(seen_second.lock().unwrap().as_slice(), ["code=c"]);
        assert!(
            seen_first.lock().unwrap().len() <= 1,
            "the old gateway must not keep receiving redirects"
        );

        supervisor.abort();
    }
}

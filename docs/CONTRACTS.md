# M1 Locked Contracts

## selection (crates/router)
- Strategy::StrictRoundRobin — seq-by-member-id (see crates/router/src/lib.rs doc comment).
  Invariants tested: even distribution over N members; churn-immunity (cooldown/rejoin
  must not cause double-serving or starvation); no mutation of member objects.
- Strategy::FillFirst — first available member by list order.

## health transitions (owned by gateway, NOT router)
- Outcome::Success -> keep current health (re-enable Cooldown-expired handled lazily by is_available(now)).
- Outcome::RateLimited{retry_after} -> Health::Cooldown{until=now+(retry_after.unwrap_or(300))*1000}
- Outcome::AuthFailed -> Health::AuthFailed
- Outcome::ServerError / NetworkError -> unchanged health

## failover (gateway relay loop)
Attempt up to min(pool_available, 3) distinct accounts. Retryable-before-first-byte only:
HTTP 429/401/403/500/502/503/504. Any 2xx/3xx begins relay permanently. Other statuses
(e.g. 400) surface immediately to client. On exhaustion, relay the FINAL upstream
failure verbatim (transparency), increment exposed_errors metric.

## passthrough
No body parsing on matched-family routes. Relay raw bytes streams; connection reuse via
pooled hyper client per upstream host. TCP_NODELAY on.

## scope cuts (recorded, deferred to M2+)
token/SSE accounting tee, SQLite persistence, UI, affinity enforcement (hints ignored in
strict_rr for M1), automatic refresh-token rotation (smoke uses freshest cached creds).

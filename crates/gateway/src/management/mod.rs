//! The `/v0/management` surface.
//!
//! LANE SEAM: each route group lives in its own module and exposes a
//! `pub fn <group>_routes() -> Router<Arc<AppState>>`. `management_router`
//! merges them and applies the availability + authentication layers once, so a
//! group module never repeats the auth wiring and cannot accidentally omit it.

pub mod auth;

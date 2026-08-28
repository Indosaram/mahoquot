//! The `/v0/management` surface.
//!
//! LANE SEAM: each route group lives in its own module and exposes
//! `pub fn <group>_routes() -> Router<Arc<AppState>>`. `management_router`
//! merges them and applies the availability + authentication gate exactly
//! once, so a group module never repeats the auth wiring and cannot be mounted
//! without it.

pub mod auth;
pub mod core;
pub mod gate;
pub mod scalar_table;
pub mod scalars;
pub mod settings;
pub mod store;

use std::sync::Arc;

use axum::Router;

use crate::state::AppState;

pub fn management_router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .merge(core::core_routes())
        .merge(scalars::scalars_routes())
        .layer(axum::middleware::from_fn_with_state(
            state,
            gate::require_management_access,
        ))
        // An unimplemented management path must answer 404 like upstream's
        // NoRoute. Without this fallback the request escapes the nest and hits
        // the relay's inbound-key layer, which answers 401 with the wrong
        // error body entirely. The fallback sits outside the gate because
        // upstream's group middleware never runs for an unmatched route.
        .fallback(|| async { axum::http::StatusCode::NOT_FOUND })
}

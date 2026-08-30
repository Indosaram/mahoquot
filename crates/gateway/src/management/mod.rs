//! The `/v0/management` surface.
//!
//! LANE SEAM: each route group lives in its own module and exposes
//! `pub fn <group>_routes() -> Router<Arc<AppState>>`. `management_router`
//! merges them and applies the availability + authentication gate exactly
//! once, so a group module never repeats the auth wiring and cannot be mounted
//! without it.

pub mod apikeys;
pub mod core;
pub mod creds;
pub mod gate;
pub mod lists;
pub mod oauth;
pub mod observability;
pub mod plugins;
pub mod scalar_table;
pub mod scalars;
pub mod settings;
pub mod store;

use std::sync::Arc;

use axum::Router;

use crate::inbound::require_api_key;
use crate::state::AppState;

pub fn management_router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .merge(apikeys::apikeys_routes())
        .merge(creds::creds_routes())
        .merge(observability::observability_routes())
        .merge(core::core_routes())
        .merge(scalars::scalars_routes())
        .layer(axum::middleware::from_fn_with_state(
            state.api_keys.clone(),
            require_api_key,
        ))
        .layer(axum::middleware::from_fn(gate::stamp_management_response))
        // An unimplemented management path must answer 404 like upstream's
        // NoRoute. Without this fallback the request escapes the nest and hits
        // the relay's inbound-key layer, which answers 401 with the wrong
        // error body entirely. The fallback sits outside the gate because
        // upstream's group middleware never runs for an unmatched route.
        .fallback(|| async { axum::http::StatusCode::NOT_FOUND })
}

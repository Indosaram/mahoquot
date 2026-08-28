//! The `/v0/management` surface.
//!
//! LANE SEAM: each route group lives in its own module and exposes
//! `pub fn <group>_routes() -> Router<Arc<AppState>>`. `management_router`
//! merges them and applies the availability + authentication gate exactly
//! once, so a group module never repeats the auth wiring and cannot be mounted
//! without it.

pub mod auth;
pub mod gate;
pub mod scalars;
pub mod settings;
pub mod store;

use std::sync::Arc;

use axum::Router;

use crate::state::AppState;

pub fn management_router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .merge(scalars::scalars_routes())
        .layer(axum::middleware::from_fn_with_state(
            state,
            gate::require_management_access,
        ))
}

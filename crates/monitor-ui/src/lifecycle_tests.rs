use std::path::Path;

use crate::{
    gateway_target_policy, reclaim_listener_policy, stop_signal_order, GatewayTargetPolicy,
    ReclaimListenerPolicy, StopSignal,
};

#[test]
fn reclaim_policy_kills_only_the_gateway_executable() {
    let own_gateway = Path::new("/Applications/Mahoquot.app/Contents/MacOS/mahoquot-gateway");

    assert_eq!(
        reclaim_listener_policy(
            Path::new("/Applications/Mahoquot.app/Contents/MacOS/mahoquot-gateway"),
            own_gateway,
        ),
        ReclaimListenerPolicy::Terminate
    );
    assert_eq!(
        reclaim_listener_policy(Path::new("/usr/local/bin/foreign-service"), own_gateway),
        ReclaimListenerPolicy::Skip
    );
}

#[test]
fn a_remote_gateway_target_never_launches_or_reclaims_the_local_port() {
    assert_eq!(
        gateway_target_policy("http://127.0.0.1:18801"),
        GatewayTargetPolicy::ManageLocal
    );
    assert_eq!(
        gateway_target_policy("http://gateway.example.test:18801"),
        GatewayTargetPolicy::UseConfigured
    );
}

#[test]
fn stop_policy_attempts_graceful_shutdown_before_forcing_exit() {
    assert_eq!(
        stop_signal_order(),
        [StopSignal::Terminate, StopSignal::Kill]
    );
}

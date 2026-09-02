#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayOwnership {
    OwnedLocal,
    Remote,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownStep {
    RequestGraceful,
    FlushHistory,
    WaitForExit,
    ForceTerminate,
}

pub fn shutdown_plan(ownership: GatewayOwnership, graceful_exit: bool) -> Vec<ShutdownStep> {
    match ownership {
        GatewayOwnership::Remote => Vec::new(),
        GatewayOwnership::OwnedLocal if graceful_exit => vec![
            ShutdownStep::RequestGraceful,
            ShutdownStep::FlushHistory,
            ShutdownStep::WaitForExit,
        ],
        GatewayOwnership::OwnedLocal => vec![
            ShutdownStep::RequestGraceful,
            ShutdownStep::FlushHistory,
            ShutdownStep::WaitForExit,
            ShutdownStep::ForceTerminate,
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_sidecar_graceful_shutdown_flushes_and_reaps() {
        assert_eq!(
            shutdown_plan(GatewayOwnership::OwnedLocal, true),
            [
                ShutdownStep::RequestGraceful,
                ShutdownStep::FlushHistory,
                ShutdownStep::WaitForExit,
            ]
        );
    }

    #[test]
    fn hung_owned_sidecar_escalates_once() {
        let plan = shutdown_plan(GatewayOwnership::OwnedLocal, false);
        assert_eq!(
            plan.iter()
                .filter(|step| **step == ShutdownStep::ForceTerminate)
                .count(),
            1
        );
        assert_eq!(plan.last(), Some(&ShutdownStep::ForceTerminate));
    }

    #[test]
    fn remote_gateway_is_never_signaled() {
        assert!(shutdown_plan(GatewayOwnership::Remote, false).is_empty());
    }
}

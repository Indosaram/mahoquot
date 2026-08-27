//! Routing strategies over a dynamic pool.
//!
//! CONTRACT (docs/CONTRACTS.md §selection):
//! - StrictRoundRobin: member-id-keyed service sequence. Each select() picks the
//!   AVAILABLE member with the smallest (last_served_seq, tiebreak: first index),
//!   then stamps it with a monotonically increasing global sequence. This makes
//!   rotation perfectly even and immune to membership churn (no positional cursor).
//! - FillFirst: first AVAILABLE member in list order every time.
//! - select() MUST NOT mutate member objects; bookkeeping lives inside Router.
//! - Router is pure selection: health transitions are owned by the caller.

use std::collections::HashMap;
use std::sync::Arc;

use quotio_types::{PoolMember, SessionHint, Strategy};

#[derive(Default)]
pub struct Router {
    strategy: Strategy,
    /// member id -> last assigned sequence number
    last_served: HashMap<String, u64>,
    /// monotonically increasing global service counter
    seq: u64,
}

impl Router {
    pub fn new(strategy: Strategy) -> Self {
        Self {
            strategy,
            ..Default::default()
        }
    }

    /// Index into `members` of the next member to serve, or None if none available.
    pub fn select(&self, members: &[Arc<dyn PoolMember>], _hint: &SessionHint) -> Option<usize> {
        let _ = (&mut self.last_served, self.seq); // placeholder silence; lane rewrites body
        None
    }

    /// Report the result of serving member `id`. Reserved for future weighting.
    pub fn feedback(&self, _id: &str, _outcome: quotio_types::Outcome) {}

    pub fn strategy(&self) -> Strategy {
        self.strategy
    }
}

#[cfg(test)]
mod red_tests {
    //! INTENTIONALLY FAILING at scaffold (documented RED baseline).
    use super::*;
    use quotio_types::{Health, PoolMember};

    struct M {
        id: String,
        h: Health,
        reset: Option<i64>,
    }
    impl M {
        fn new(id: &str, h: Health) -> Arc<dyn PoolMember> {
            Arc::new(M {
                id: id.into(),
                h,
                reset: None,
            })
        }
    }
    impl PoolMember for M {
        fn id(&self) -> &str {
            &self.id
        }
        fn health(&self) -> Health {
            self.h
        }
        fn reset_at_unix(&self) -> Option<i64> {
            self.reset
        }
    }

    fn pool(ids: &[(&str, Health)]) -> Vec<Arc<dyn PoolMember>> {
        ids.iter().map(|(i, h)| M::new(i, *h)).collect()
    }

    #[test]
    fn strict_rr_distributes_evenly_over_four() {
        let p = pool(&[
            ("a", Health::Available),
            ("b", Health::Available),
            ("c", Health::Available),
            ("d", Health::Available),
        ]);
        let r = Router::new(Strategy::StrictRoundRobin);
        let hint = SessionHint::default();
        let mut counts = std::collections::HashMap::new();
        for _ in 0..40 {
            let i = r.select(&p, &hint).expect("pick");
            *counts.entry(p[i].id().to_string()).or_insert(0) += 1;
        }
        for id in ["a", "b", "c", "d"] {
            assert_eq!(
                counts[id], 10,
                "member {id} must be served exactly 10 times"
            );
        }
    }

    #[test]
    fn strict_rr_survives_membership_churn_without_cursor_poisoning() {
        let mut members: Vec<Arc<dyn PoolMember>> = vec![
            ("a", Health::Available),
            ("b", Health::Available),
            ("c", Health::Available),
        ]
        .into_iter()
        .map(|(i, h)| M::new(i, h))
        .collect();
        let r = Router::new(Strategy::StrictRoundRobin);
        let hint = SessionHint::default();
        // burn some rotations
        for i in 0..3 {
            r.select(&members, &hint);
            let _ = i;
        }
        // b cools down: all traffic goes to a,c evenly; b must not be double-skipped
        members[1] = M::new(
            "b",
            Health::Cooldown {
                until_unix_ms: i64::MAX,
            },
        );
        let mut a_c = std::collections::HashMap::new();
        for _ in 0..8 {
            let i = r.select(&members, &hint).unwrap();
            assert_ne!(members[i].id(), "b");
            *a_c.entry(members[i].id().to_string()).or_insert(0) += 1;
        }
        assert_eq!(a_c["a"], 4);
        assert_eq!(a_c["c"], 4);
        // b recovers: next 4 picks cover a,b,c,b-cycle evenly (each served per-seq rule)
        members[1] = M::new("b", Health::Available);
        let got = (0..3).map(|_| members[r.select(&members, &hint).unwrap()].id().to_string());
        let mut v: Vec<_> = got.collect();
        v.sort();
        assert_eq!(v, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn fill_first_pins_to_first_available_then_moves_on_cooldown() {
        let mut members = pool(&[("a", Health::Available), ("b", Health::Available)]);
        let r = Router::new(Strategy::FillFirst);
        let hint = SessionHint::default();
        for _ in 0..5 {
            assert_eq!(
                r.select(&members, &hint).map(|i| members[i].id()),
                Some("a")
            );
        }
        members[0] = M::new(
            "a",
            Health::Cooldown {
                until_unix_ms: i64::MAX,
            },
        );
        for _ in 0..5 {
            assert_eq!(
                r.select(&members, &hint).map(|i| members[i].id()),
                Some("b")
            );
        }
    }

    #[test]
    fn empty_or_all_unavailable_pool_returns_none() {
        let p = pool(&[("a", Health::Disabled)]);
        let r = Router::new(Strategy::StrictRoundRobin);
        assert_eq!(r.select(&p, &SessionHint::default()), None);
        assert_eq!(r.select(&[], &SessionHint::default()), None);
    }
}

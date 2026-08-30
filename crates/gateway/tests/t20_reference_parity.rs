//! Coverage map for the OpenCodex / CLIProxyAPI parity work.
//!
//! Behaviour is proven by the tests this manifest names; the manifest itself
//! proves that no reference-backed flow, relay adapter, or catalog provider is
//! left without a named owner and a live GREEN test, or a declared omission
//! stating why it is not shipped. Locators are matched by
//! needle rather than by line so that an unrelated edit above a symbol cannot
//! turn this gate red, and provider rows are checked against a tracked snapshot
//! of the reference registry rather than a sibling checkout.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Deserialize)]
struct Locator {
    path: String,
    needle: String,
}

#[derive(Deserialize)]
struct FlowRow {
    id: String,
    surface: String,
    disposition: String,
    reference: Locator,
    owner: Locator,
    green_test: Locator,
    evidence: String,
}

#[derive(Deserialize)]
struct AdapterRow {
    id: String,
    owner: Locator,
    green_test: Locator,
    coverage: String,
    #[serde(default)]
    gap: Option<String>,
}

#[derive(Deserialize)]
struct ProviderRow {
    id: String,
    adapter: String,
    auth_kind: String,
    coverage: String,
    #[serde(default)]
    green_test: Option<Locator>,
}

#[derive(Deserialize)]
struct Manifest {
    flows: Vec<FlowRow>,
    adapters: Vec<AdapterRow>,
    providers: Vec<ProviderRow>,
}

#[derive(Deserialize)]
struct SnapshotProvider {
    id: String,
    adapter: String,
    #[serde(rename = "authKind")]
    auth_kind: String,
}

#[derive(Deserialize)]
struct Snapshot {
    providers: Vec<SnapshotProvider>,
}

#[derive(Deserialize)]
struct Deviation {
    id: String,
    field: String,
}

#[derive(Deserialize)]
struct Omission {
    id: String,
    reason: String,
}

#[derive(Deserialize)]
struct Deviations {
    deviations: Vec<Deviation>,
    omissions: Vec<Omission>,
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> T {
    let raw =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Assert a locator still points at live source. Returns false when the file is
/// absent, which only the optional reference checkout is allowed to be.
fn locator_resolves(root: &Path, row: &str, kind: &str, locator: &Locator, symbol: bool) -> bool {
    let path = root.join(&locator.path);
    let Ok(source) = std::fs::read_to_string(&path) else {
        return false;
    };
    let found = if symbol {
        source.contains(&format!("fn {}", locator.needle))
    } else {
        source.contains(&locator.needle)
    };
    assert!(
        found,
        "{row} {kind}: {} no longer contains {:?}",
        locator.path, locator.needle
    );
    true
}

fn require_locator(root: &Path, row: &str, kind: &str, locator: &Locator, symbol: bool) {
    assert!(
        locator_resolves(root, row, kind, locator, symbol),
        "{row} {kind}: {} is missing",
        locator.path
    );
}

#[test]
fn every_reference_backed_flow_maps_to_an_owner_green_test_and_evidence() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let manifest: Manifest =
        read_json(&root.join("crates/gateway/tests/data/reference-parity.json"));
    let snapshot: Snapshot =
        read_json(&root.join("docs/reference/opencodex-registry-snapshot.json"));
    let deviations: Deviations =
        read_json(&root.join("docs/reference/provider-parity-deviations.json"));

    let mut unverified_references = Vec::new();
    let mut ids = BTreeSet::new();
    for flow in &manifest.flows {
        assert!(
            ids.insert(flow.id.clone()),
            "duplicate flow row {}",
            flow.id
        );
        assert!(
            matches!(flow.surface.as_str(), "auth" | "proxy" | "boundary"),
            "{} has invalid surface {}",
            flow.id,
            flow.surface
        );
        assert!(
            matches!(flow.disposition.as_str(), "included" | "excluded"),
            "{} has invalid disposition {}",
            flow.id,
            flow.disposition
        );
        // The reference checkout is optional: the tracked snapshot carries the
        // parity proof, so a clone without sibling sources still verifies every
        // in-repo owner and GREEN test.
        if !locator_resolves(&root, &flow.id, "reference", &flow.reference, false) {
            unverified_references.push(flow.reference.path.clone());
        }
        require_locator(&root, &flow.id, "owner", &flow.owner, false);
        require_locator(&root, &flow.id, "green test", &flow.green_test, true);
        let evidence = root.join(&flow.evidence);
        assert!(
            evidence.is_file(),
            "{} evidence is missing: {}",
            flow.id,
            evidence.display()
        );
    }

    let mut adapters = BTreeMap::new();
    for adapter in &manifest.adapters {
        assert!(
            adapters.insert(adapter.id.as_str(), adapter).is_none(),
            "duplicate adapter row {}",
            adapter.id
        );
        assert!(
            matches!(adapter.coverage.as_str(), "full" | "partial"),
            "{} has invalid coverage {}",
            adapter.id,
            adapter.coverage
        );
        // A partial port must say what is missing, so an unfinished adapter can
        // never read as a complete one.
        if adapter.coverage == "partial" {
            let gap = adapter.gap.as_deref().unwrap_or_default();
            assert!(
                !gap.trim().is_empty(),
                "{} is partial without a gap",
                adapter.id
            );
        }
        require_locator(&root, &adapter.id, "owner", &adapter.owner, false);
        require_locator(&root, &adapter.id, "green test", &adapter.green_test, true);
    }

    let declared: BTreeSet<(&str, &str)> = deviations
        .deviations
        .iter()
        .map(|entry| (entry.id.as_str(), entry.field.as_str()))
        .collect();
    let reference: BTreeMap<&str, &SnapshotProvider> = snapshot
        .providers
        .iter()
        .map(|provider| (provider.id.as_str(), provider))
        .collect();

    let mut used_adapters = BTreeSet::new();
    let mut covered = BTreeSet::new();
    for provider in &manifest.providers {
        assert!(
            covered.insert(provider.id.as_str()),
            "duplicate provider row {}",
            provider.id
        );
        let entry = reference
            .get(provider.id.as_str())
            .unwrap_or_else(|| panic!("{} is not in the reference snapshot", provider.id));
        assert_eq!(
            provider.adapter, entry.adapter,
            "{} adapter drifted from the reference snapshot",
            provider.id
        );
        if provider.auth_kind != entry.auth_kind {
            assert!(
                declared.contains(&(provider.id.as_str(), "authKind")),
                "{} auth kind {} differs from the reference {} without a declared deviation",
                provider.id,
                provider.auth_kind,
                entry.auth_kind
            );
        }
        assert!(
            adapters.contains_key(provider.adapter.as_str()),
            "{} uses adapter {} which has no owner row",
            provider.id,
            provider.adapter
        );
        used_adapters.insert(provider.adapter.as_str());
        match provider.coverage.as_str() {
            "dedicated" => {
                let green = provider
                    .green_test
                    .as_ref()
                    .unwrap_or_else(|| panic!("{} is dedicated without a green test", provider.id));
                require_locator(&root, &provider.id, "green test", green, true);
            }
            // Everything else rides its adapter's proven path; claiming a
            // per-provider test here would invent coverage that does not exist.
            "adapter" => assert!(
                provider.green_test.is_none(),
                "{} rides its adapter and must not claim its own green test",
                provider.id
            ),
            other => panic!("{} has invalid coverage {other}", provider.id),
        }
    }

    // A reference provider Quotio deliberately does not ship is accounted for
    // by an omission with a reason, never by a silently missing row.
    let mut omitted = BTreeSet::new();
    for omission in &deviations.omissions {
        assert!(
            reference.contains_key(omission.id.as_str()),
            "omission {} is not a reference provider",
            omission.id
        );
        assert!(
            !omission.reason.trim().is_empty(),
            "omission {} has no reason",
            omission.id
        );
        assert!(
            !covered.contains(omission.id.as_str()),
            "{} is omitted but still has a parity row",
            omission.id
        );
        omitted.insert(omission.id.as_str());
    }

    let expected: BTreeSet<&str> = reference.keys().copied().collect();
    let accounted: BTreeSet<&str> = covered.union(&omitted).copied().collect();
    assert_eq!(
        accounted, expected,
        "every reference provider must have exactly one parity row or a declared omission"
    );
    let owned: BTreeSet<&str> = adapters.keys().copied().collect();
    assert_eq!(
        used_adapters, owned,
        "every adapter row must be used by at least one provider"
    );
    for deviation in &deviations.deviations {
        assert!(
            reference.contains_key(deviation.id.as_str()),
            "deviation {} is not a reference provider",
            deviation.id
        );
    }

    if !unverified_references.is_empty() {
        println!(
            "reference checkout absent: {} locator(s) unverified, snapshot parity still enforced",
            unverified_references.len()
        );
    }
}

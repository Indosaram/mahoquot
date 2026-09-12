import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountsSurface } from "../components/AccountsSurface";
import { mergeAccountsAndCredentials } from "../lib/accounts";
import { AccountStatsSchema, type AuthFileItem } from "../lib/schemas";

describe("Devin per-account model list typed boundary regression", () => {
  it("preserves disjoint per-account models and distinguishes empty from missing across Schema -> merge -> AccountsSurface", () => {
    // 1. Raw admin stats from gateway with distinct Devin accounts
    const rawAccountWork = {
      id: "devin-work",
      provider: "devin",
      health: "healthy",
      ok: 1,
      fails: 0,
      models: ["devin/glm-5-2", "devin/swe-1-7"],
    };

    const rawAccountPersonal = {
      id: "devin-personal",
      provider: "devin",
      health: "healthy",
      ok: 1,
      fails: 0,
      models: ["devin/swe-1-7-medium", "devin/qwen-2-5-coder"],
    };

    const rawAccountEmpty = {
      id: "devin-empty",
      provider: "devin",
      health: "healthy",
      ok: 0,
      fails: 0,
      models: [], // explicit empty entitlement
    };

    const rawAccountMissing = {
      id: "devin-missing",
      provider: "devin",
      health: "healthy",
      ok: 0,
      fails: 0,
      // models omitted / missing: unknown
    };

    // 2. Parse through AccountStatsSchema (verifying typed schema preservation)
    const parsedWork = AccountStatsSchema.parse(rawAccountWork);
    const parsedPersonal = AccountStatsSchema.parse(rawAccountPersonal);
    const parsedEmpty = AccountStatsSchema.parse(rawAccountEmpty);
    const parsedMissing = AccountStatsSchema.parse(rawAccountMissing);

    // Schema level assertions
    expect(parsedWork.models).toEqual(["devin/glm-5-2", "devin/swe-1-7"]);
    expect(parsedPersonal.models).toEqual(["devin/swe-1-7-medium", "devin/qwen-2-5-coder"]);
    expect(parsedEmpty.models).toEqual([]);
    expect(parsedMissing.models).toBeUndefined();

    // 3. Corresponding auth files
    const authFiles: AuthFileItem[] = [
      {
        name: "devin-work.json",
        path: "/auth/devin-work.json",
        auth_index: "devin-work.json",
        label: "Devin Work",
        type: "devin",
        identity_slug: "devin-work",
        disabled: false,
        size: 100,
        unavailable: false,
        runtime_only: false,
      },
      {
        name: "devin-personal.json",
        path: "/auth/devin-personal.json",
        auth_index: "devin-personal.json",
        label: "Devin Personal",
        type: "devin",
        identity_slug: "devin-personal",
        disabled: false,
        size: 100,
        unavailable: false,
        runtime_only: false,
      },
      {
        name: "devin-empty.json",
        path: "/auth/devin-empty.json",
        auth_index: "devin-empty.json",
        label: "Devin Empty",
        type: "devin",
        identity_slug: "devin-empty",
        disabled: false,
        size: 100,
        unavailable: false,
        runtime_only: false,
      },
      {
        name: "devin-missing.json",
        path: "/auth/devin-missing.json",
        auth_index: "devin-missing.json",
        label: "Devin Missing",
        type: "devin",
        identity_slug: "devin-missing",
        disabled: false,
        size: 100,
        unavailable: false,
        runtime_only: false,
      },
    ];

    // 4. Merge through mergeAccountsAndCredentials
    const normalizedAccounts = mergeAccountsAndCredentials(
      [parsedWork, parsedPersonal, parsedEmpty, parsedMissing],
      authFiles,
    );

    // NormalizedAccount level assertions
    const workAcc = normalizedAccounts.find((a) => a.id === "devin-work");
    const personalAcc = normalizedAccounts.find((a) => a.id === "devin-personal");
    const emptyAcc = normalizedAccounts.find((a) => a.id === "devin-empty");
    const missingAcc = normalizedAccounts.find((a) => a.id === "devin-missing");

    expect(workAcc).toBeDefined();
    expect(personalAcc).toBeDefined();
    expect(emptyAcc).toBeDefined();
    expect(missingAcc).toBeDefined();

    expect(workAcc?.models).toEqual(["devin/glm-5-2", "devin/swe-1-7"]);
    expect(personalAcc?.models).toEqual(["devin/swe-1-7-medium", "devin/qwen-2-5-coder"]);
    expect(emptyAcc?.models).toEqual([]);
    expect(missingAcc?.models).toBeUndefined();

    // 5. Render AccountsSurface with global gatewayModels present
    // to prove cards do NOT falsely fall back to the global union
    const globalGatewayModels = [
      { id: "devin/glm-5-2", object: "model", owned_by: "devin" },
      { id: "devin/swe-1-7", object: "model", owned_by: "devin" },
      { id: "devin/swe-1-7-medium", object: "model", owned_by: "devin" },
      { id: "devin/qwen-2-5-coder", object: "model", owned_by: "devin" },
      { id: "devin/global-only-model", object: "model", owned_by: "devin" },
    ];

    render(
      <AccountsSurface
        accounts={normalizedAccounts}
        visibleAccounts={normalizedAccounts}
        providers={["devin"]}
        selectedProvider="devin"
        gatewayModels={globalGatewayModels}
        pending=""
        onSelectProvider={vi.fn()}
        onRunAccountAction={vi.fn()}
        onRefresh={vi.fn()}
        onSetCredentialDisabled={vi.fn()}
        onReauthenticate={vi.fn()}
        onRemoveCredential={vi.fn()}
        onSetConfirmRemove={vi.fn()}
        onMoveCredential={vi.fn()}
        onDropCredential={vi.fn()}
        onSetDragging={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    // Verify all 4 cards rendered
    expect(screen.getByText("Devin Work")).toBeInTheDocument();
    expect(screen.getByText("Devin Personal")).toBeInTheDocument();
    expect(screen.getByText("Devin Empty")).toBeInTheDocument();
    expect(screen.getByText("Devin Missing")).toBeInTheDocument();

    const discoverySections = screen.getAllByTestId("devin-discovery");
    expect(discoverySections).toHaveLength(4);

    // Find cards by their title
    const workCard = screen.getByText("Devin Work").closest(".account-card") as HTMLElement;
    const personalCard = screen.getByText("Devin Personal").closest(".account-card") as HTMLElement;
    const emptyCard = screen.getByText("Devin Empty").closest(".account-card") as HTMLElement;
    const missingCard = screen.getByText("Devin Missing").closest(".account-card") as HTMLElement;

    expect(workCard).toBeInTheDocument();
    expect(personalCard).toBeInTheDocument();
    expect(emptyCard).toBeInTheDocument();
    expect(missingCard).toBeInTheDocument();

    const workDiscovery = within(workCard).getByTestId("devin-discovery");
    const personalDiscovery = within(personalCard).getByTestId("devin-discovery");
    const emptyDiscovery = within(emptyCard).getByTestId("devin-discovery");
    const missingDiscovery = within(missingCard).getByTestId("devin-discovery");

    // Invariant: Card 1 sees ONLY its own models
    expect(workDiscovery).toHaveTextContent("devin/glm-5-2, devin/swe-1-7");
    expect(workDiscovery).not.toHaveTextContent("devin/qwen-2-5-coder");
    expect(workDiscovery).not.toHaveTextContent("devin/swe-1-7-medium");
    expect(workDiscovery).not.toHaveTextContent("devin/global-only-model");

    // Invariant: Card 2 sees ONLY its own models
    expect(personalDiscovery).toHaveTextContent("devin/swe-1-7-medium, devin/qwen-2-5-coder");
    expect(personalDiscovery).not.toHaveTextContent("devin/glm-5-2");
    expect(personalDiscovery).not.toHaveTextContent("devin/swe-1-7,");
    expect(personalDiscovery).not.toHaveTextContent("devin/global-only-model");

    // Invariant: missing and empty differ meaningfully
    // Empty entitlement is known empty, NOT falsely unknown
    expect(emptyDiscovery).not.toHaveTextContent("Unknown");
    expect(emptyDiscovery).toHaveTextContent(/no models|empty|none/i);

    // Missing models remains unknown
    expect(missingDiscovery).toHaveTextContent("Unknown");
    expect(missingDiscovery).not.toHaveTextContent(/no models/i);
  });
});

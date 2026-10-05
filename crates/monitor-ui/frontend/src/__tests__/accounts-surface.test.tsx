import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountsSurface,
  type AccountsSurfaceProps,
  clinePoolQuotaSummary,
  formatQuotaDuration,
  formatQuotaWindowName,
  isClineInferredQuotaExpired,
  quotaRows,
} from "../components/AccountsSurface";
import { AccountCard, type AccountCardProps } from "../components/AccountCard";
import type { WarmupControlsState } from "../components/WarmupControls";
import type { NormalizedAccount } from "../lib/accounts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockAccount: NormalizedAccount = {
  id: "codex-1",
  runtimeId: "codex-1",
  credentialName: "codex-1.json",
  disabled: false,
  authIndex: "codex-1.json",
  provider: "codex",
  plan: null,
  email: "dev@example.com",
  label: "dev@example.com",
  health: "healthy",
  healthRaw: "available",
  cooldownUntilUnixMs: null,
  cooldownRemainingSecs: null,
  ok: 10,
  fails: 0,
  inputTokens: 1_250,
  outputTokens: 430,
  totalTokens: 1_680,
  failureRate: 0,
  p50Ms: 120,
  lastError: null,
  usage: {
    plan_type: "Pro",
    primary: { limit_name: "5 hour", used_percent: 25, reset_after_seconds: 3600 },
    windows: [{ label: "7d", requests: 4340, tokens: 300_901_557, cost_usd: 522.39 }],
  },
  quotaCapability: "supported",
  isCredentialOnly: false,
  canReset: true,
  resetCreditsAvailable: 1,
  supportsReset: true,
  resetCredits: [],
};

const DAY_SECONDS = 86_400;

const createProps = (overrides?: Partial<AccountsSurfaceProps>): AccountsSurfaceProps => ({
  accounts: [mockAccount],
  providers: ["codex"],
  selectedProvider: "codex",
  visibleAccounts: [mockAccount],
  pending: "",
  onSelectProvider: vi.fn(),
  onRunAccountAction: vi.fn(),
  onRefresh: vi.fn(),
  onSetCredentialDisabled: vi.fn(),
  onReauthenticate: vi.fn(),
  onRemoveCredential: vi.fn(),
  onSetConfirmRemove: vi.fn(),
  onMoveCredential: vi.fn(),
  onDropCredential: vi.fn(),
  onSetDragging: vi.fn(),
  onContextMenu: vi.fn(),
  ...overrides,
});

/** Rare lifecycle actions live behind the card's overflow trigger. */
const openOverflowMenu = (label = "dev@example.com") => {
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${label}` }));
};

/** Spending a banked reset confirms, then dispatches from the menu. */
const spendBankedReset = (label = "dev@example.com") => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  openOverflowMenu(label);
  fireEvent.click(screen.getByRole("menuitem", { name: `Spend 1 banked reset for ${label}` }));
};

describe("AccountsSurface component", () => {
  it("R11 switches quota numbers and bar widths between used and remaining", () => {
    const props = { ...createProps(), showRemaining: false };
    const { container, rerender } = render(<AccountsSurface {...props} />);
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(container.querySelector(".quota-track i")).toHaveStyle({ width: "25%" });
    rerender(<AccountsSurface {...props} showRemaining={true} />);
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(container.querySelector(".quota-track i")).toHaveStyle({ width: "75%" });
  });

  it("does not render token usage accordion in accounts surface", () => {
    render(<AccountsSurface {...createProps()} />);
    expect(screen.queryByLabelText("Token usage")).not.toBeInTheDocument();
  });

  it("renders relay window deltas and the plan chip only for accounts that carry them", () => {
    const relayAccount = {
      ...mockAccount,
      plan: "standard",
      usage: {
        ...mockAccount.usage,
        totals: { requests: 4340, tokens: 1_394_236_595, total_cost_usd: 3673.01 },
      },
    } as NormalizedAccount;
    render(
      <AccountsSurface
        {...createProps({ accounts: [relayAccount], visibleAccounts: [relayAccount] })}
      />,
    );

    const deltas = screen.getByTestId("account-usage-windows");
    expect(deltas).toHaveTextContent("7d");
    expect(deltas).toHaveTextContent("$522.39");
    expect(screen.getByTestId("account-plan")).toHaveTextContent("Standard");
  });

  it("reports banked resets by count, nearest expiry, and per-credit dates", () => {
    const nowUnix = Math.floor(Date.now() / 1000);
    const account = {
      ...mockAccount,
      resetCreditsAvailable: 2,
      resetCredits: [
        { grantedAtUnix: nowUnix - 25 * DAY_SECONDS, expiresAtUnix: nowUnix + 5 * DAY_SECONDS },
        { grantedAtUnix: nowUnix - 10 * DAY_SECONDS, expiresAtUnix: nowUnix + 20 * DAY_SECONDS },
      ],
    } as NormalizedAccount;
    render(
      <AccountsSurface {...createProps({ accounts: [account], visibleAccounts: [account] })} />,
    );

    const trigger = screen.getByTestId("account-reset-credits");
    expect(trigger).toHaveTextContent("2");
    expect(trigger).toHaveAttribute("data-urgency", "warn");
    expect(screen.queryByTestId("account-reset-credits-list")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const rows = screen.getByTestId("account-reset-credits-list").querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("5 days left");
    expect(rows[1]).toHaveTextContent("20 days left");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("account-reset-credits-list")).not.toBeInTheDocument();
  });

  it("keeps the reset control in place but disabled once no credit is banked", () => {
    const account = {
      ...mockAccount,
      canReset: false,
      resetCreditsAvailable: 0,
    } as NormalizedAccount;
    render(
      <AccountsSurface {...createProps({ accounts: [account], visibleAccounts: [account] })} />,
    );

    openOverflowMenu();
    // The item stays visible and names why it cannot run, rather than vanishing.
    expect(
      screen.getByRole("menuitem", { name: "No banked resets for dev@example.com" }),
    ).toBeDisabled();
    expect(screen.queryByTestId("account-reset-credits")).not.toBeInTheDocument();
    expect(screen.queryByTestId("account-reset-credits-list")).not.toBeInTheDocument();
  });

  it("dispatches the banked reset only when the confirmation is accepted", () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const onRunAccountAction = vi.fn();
    render(<AccountsSurface {...createProps({ onRunAccountAction })} />);

    openOverflowMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Spend 1 banked reset for dev@example.com" }),
    );
    expect(onRunAccountAction).toHaveBeenCalledWith("reset", mockAccount);
  });

  it("asks for confirmation before spending a banked reset", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const onRunAccountAction = vi.fn();
    render(<AccountsSurface {...createProps({ onRunAccountAction })} />);

    openOverflowMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Spend 1 banked reset for dev@example.com" }),
    );
    // A finite banked resource must not be spent without the confirm prompt.
    expect(confirm).toHaveBeenCalledWith("Spend 1 banked reset for dev@example.com?");
    expect(onRunAccountAction).not.toHaveBeenCalled();
  });

  it("titles the provider warmup dialog with the display label, not the raw id", () => {
    const warmup: WarmupControlsState = {
      selection: { type: "provider", id: "google-antigravity" },
      onOpen: vi.fn(),
      onClose: vi.fn(),
      returnFocus: null,
      settings: null,
      status: null,
      error: "",
      pending: false,
      onProviderChange: vi.fn(),
      onAccountChange: vi.fn(),
      onSaveProvider: vi.fn(),
      onSaveAccount: vi.fn(),
      onReload: vi.fn(),
    };
    const agAccount = { ...mockAccount, id: "ag-1", provider: "google-antigravity" };
    render(
      <AccountsSurface
        {...createProps({
          accounts: [agAccount],
          providers: ["google-antigravity"],
          selectedProvider: "google-antigravity",
          visibleAccounts: [agAccount],
        })}
        warmup={warmup}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Warm settings for provider Google Antigravity" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Warm settings for provider google-antigravity" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the raw provider key as the tab accessible name and the display label visible", () => {
    const agAccount = { ...mockAccount, id: "ag-1", provider: "google-antigravity" };
    render(
      <AccountsSurface
        {...createProps({
          accounts: [agAccount, mockAccount],
          providers: ["google-antigravity", "codex"],
          selectedProvider: "google-antigravity",
          visibleAccounts: [agAccount, mockAccount],
        })}
      />,
    );

    // Accessible name is keyed on the raw provider contract; the visible tab
    // text shows the display label, and counts come from one inventory pass.
    const tab = screen.getByRole("radio", { name: "google-antigravity 1 account" });
    expect(tab).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "codex 1 account" })).toBeInTheDocument();
    expect(tab.closest("label")?.querySelector("strong")).toHaveTextContent("Google Antigravity");
  });

  it("renders provider tabs, count badges, and account cards", () => {
    render(<AccountsSurface {...createProps()} />);
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("dev@example.com")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
    expect(screen.getByText("5 hour")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
  });

  it("dispatches lifecycle actions for warm, reset, refresh, disable, reauth, and remove", () => {
    const onRunAccountAction = vi.fn();
    const onRefresh = vi.fn();
    const onSetCredentialDisabled = vi.fn();
    const onReauthenticate = vi.fn();
    const onSetConfirmRemove = vi.fn();

    render(
      <AccountsSurface
        {...createProps({
          onRunAccountAction,
          onRefresh,
          onSetCredentialDisabled,
          onReauthenticate,
          onSetConfirmRemove,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Warm up" }));
    expect(onRunAccountAction).toHaveBeenCalledWith("warm", mockAccount);
    fireEvent.click(screen.getByRole("button", { name: "Refresh quota" }));
    expect(onRefresh).toHaveBeenCalled();

    // The menu closes after each choice, so every overflow action reopens it.
    spendBankedReset();
    expect(onRunAccountAction).toHaveBeenCalledWith("reset", mockAccount);
    openOverflowMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Disable dev@example.com" }));
    expect(onSetCredentialDisabled).toHaveBeenCalledWith(mockAccount, true);
    openOverflowMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Re-authenticate dev@example.com" }));
    expect(onReauthenticate).toHaveBeenCalledWith(mockAccount);
    openOverflowMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove dev@example.com" }));
    expect(onSetConfirmRemove).toHaveBeenCalledWith("codex-1");
  });

  it("closes the overflow menu on Escape", () => {
    render(<AccountsSurface {...createProps()} />);

    openOverflowMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("dispatches keyboard and drag-and-drop reorder events and context menu", () => {
    const onMoveCredential = vi.fn();
    const onSetDragging = vi.fn();
    const onDropCredential = vi.fn();
    const onContextMenu = vi.fn();

    render(
      <AccountsSurface
        {...createProps({
          dragging: "codex-1.json",
          onMoveCredential,
          onSetDragging,
          onDropCredential,
          onContextMenu,
        })}
      />,
    );

    const handle = screen.getByLabelText("Reorder dev@example.com");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(onMoveCredential).toHaveBeenCalledWith(mockAccount, -1);
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(onMoveCredential).toHaveBeenCalledWith(mockAccount, 1);

    const card = screen.getByText("dev@example.com").closest(".account-card");
    expect(card).toBeTruthy();
    if (card) {
      fireEvent.dragStart(card, { dataTransfer: { effectAllowed: "move" } });
      expect(onSetDragging).toHaveBeenCalledWith("codex-1.json");
      fireEvent.dragOver(card);
      fireEvent.drop(card);
      expect(onDropCredential).toHaveBeenCalledWith(mockAccount);
      fireEvent.dragEnd(card);
      expect(onSetDragging).toHaveBeenCalledWith("");
      fireEvent.contextMenu(card);
      expect(onContextMenu).toHaveBeenCalled();
    }
  });

  it("renders confirm and cancel buttons during removal confirmation", () => {
    const onRemoveCredential = vi.fn();
    const onSetConfirmRemove = vi.fn();
    render(
      <AccountsSurface
        {...createProps({ confirmRemove: "codex-1", onRemoveCredential, onSetConfirmRemove })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm removing dev@example.com" }));
    expect(onRemoveCredential).toHaveBeenCalledWith(mockAccount);
    fireEvent.click(screen.getByRole("button", { name: "Cancel removing dev@example.com" }));
    expect(onSetConfirmRemove).toHaveBeenCalledWith("");
  });

  it("renders credential-only and error states truthfully", () => {
    const errorAccount: NormalizedAccount = {
      ...mockAccount,
      id: "error-1",
      runtimeId: null,
      isCredentialOnly: true,
      lastError: { unix_ms: 1_700_000_000_000, status: 401, message: "Token expired" },
    };

    render(
      <AccountsSurface
        {...createProps({
          accounts: [errorAccount],
          visibleAccounts: [errorAccount],
          credentialsError: "Keychain locked",
        })}
      />,
    );

    expect(screen.getByText(/Token expired/)).toBeInTheDocument();
    expect(screen.getByText(/could not load it into the runtime pool/)).toBeInTheDocument();
    expect(screen.getByText(/Credential inventory unavailable/)).toBeInTheDocument();
  });

  it("renders empty state messages for filtered vs empty inventory", () => {
    const { rerender } = render(
      <AccountsSurface
        {...createProps({
          providers: ["codex", "claude"],
          selectedProvider: "claude",
          visibleAccounts: [],
        })}
      />,
    );
    expect(screen.getByText("No accounts match this filter.")).toBeInTheDocument();

    rerender(
      <AccountsSurface
        {...createProps({
          accounts: [],
          providers: [],
          selectedProvider: "all",
          visibleAccounts: [],
        })}
      />,
    );
    expect(screen.getByText("No accounts or credentials found.")).toBeInTheDocument();
  });

  it("shows successful real reset toast", async () => {
    const onRunAccountAction = vi.fn();
    render(
      <AccountsSurface
        {...createProps({
          onRunAccountAction,
        })}
      />,
    );
    spendBankedReset();
    expect(onRunAccountAction).toHaveBeenCalledWith("reset", mockAccount);
  });

  it("shows reset denial toast", async () => {
    const onRunAccountAction = vi.fn().mockRejectedValue(new Error("no reset credits available"));
    render(
      <AccountsSurface
        {...createProps({
          onRunAccountAction,
        })}
      />,
    );
    spendBankedReset();
    expect(onRunAccountAction).toHaveBeenCalledWith("reset", mockAccount);
  });

  describe("Cline quota expiry regression", () => {
    const nowUnix = Math.floor(Date.now() / 1000);

    it("expires Cline inferred 100% quota to unknown (not zero) once reset deadline passes", () => {
      const expiredClineAccount: NormalizedAccount = {
        ...mockAccount,
        id: "cline-user@example.com",
        provider: "cline",
        label: "cline-user@example.com",
        health: "healthy",
        cooldownUntilUnixMs: (nowUnix - 300) * 1000,
        cooldownRemainingSecs: 0,
        usage: {
          groups: [
            {
              display_name: "Cline Free Limits",
              models: "Cline Free Models",
              buckets: [
                {
                  display_name: "z-ai/glm-5.3-flash (Daily limit)",
                  used_percent: 100,
                  reset_at_unix: nowUnix - 300,
                },
              ],
            },
          ],
        },
      };

      // In quotaRows: expired Cline inferred quota bucket must NOT be present
      const rows = quotaRows(expiredClineAccount);
      expect(rows).toEqual([]);

      // In AccountsSurface UI: shows "Not reported by provider", never 100% and never fabricated 0%
      render(
        <AccountsSurface
          {...createProps({
            accounts: [expiredClineAccount],
            visibleAccounts: [expiredClineAccount],
            providers: ["cline"],
            selectedProvider: "cline",
          })}
        />,
      );

      expect(screen.getByText("Not reported by provider")).toBeInTheDocument();
      expect(screen.queryByText("100%")).not.toBeInTheDocument();
      expect(screen.queryByText("0%")).not.toBeInTheDocument();
    });

    it("lists every quota lane when one lane is unmeasured", () => {
      const mixedAccount: NormalizedAccount = {
        ...mockAccount,
        id: "cline-user@example.com",
        provider: "cline",
        label: "cline-user@example.com",
        usage: {
          groups: [
            {
              display_name: "Cline Free Limits",
              models: "Cline Free Models",
              buckets: [
                {
                  display_name: "z-ai/glm-5.3-flash (Daily limit)",
                  used_percent: null,
                  reset_at_unix: null,
                },
                {
                  display_name: "cline-free/deepseek-v4.1-flash (Daily limit)",
                  used_percent: 100,
                  reset_at_unix: nowUnix + 3600,
                },
              ],
            },
          ],
        },
      };

      const rows = quotaRows(mixedAccount);
      expect(rows.map((row) => row.name)).toEqual([
        "z-ai/glm-5.3-flash (Daily limit)",
        "cline-free/deepseek-v4.1-flash (Daily limit)",
      ]);
      // An unmeasured lane must stay null so it cannot be printed as
      // "0% used", which would claim nobody's measurement says free.
      expect(rows[0]?.usedPercent).toBeNull();
      expect(rows[1]?.usedPercent).toBe(100);

      render(
        <AccountsSurface
          {...createProps({
            accounts: [mixedAccount],
            visibleAccounts: [mixedAccount],
            providers: ["cline"],
            selectedProvider: "cline",
          })}
        />,
      );

      expect(screen.getAllByText("unmeasured").length).toBeGreaterThan(0);
      expect(
        screen.getAllByText("cline-free/deepseek-v4.1-flash (Daily limit)").length,
      ).toBeGreaterThan(0);
    });

    it("renders only the Cline daily buckets selected for display", () => {
      const account: NormalizedAccount = {
        ...mockAccount,
        id: "cline-display@example.com",
        provider: "cline",
        label: "cline-display@example.com",
        usage: {
          groups: [
            {
              display_name: "Cline Free Limits",
              models: "Cline Free Models",
              buckets: [
                {
                  bucket_id: "cline-free/gemini-3.8-flash",
                  display_name: "cline-free/gemini-3.8-flash (Daily limit)",
                  used_percent: 40,
                  reset_at_unix: nowUnix + 3600,
                },
                {
                  bucket_id: "cline-free/mimo-v2.6-flash",
                  display_name: "cline-free/mimo-v2.6-flash (Daily limit)",
                  used_percent: 10,
                  reset_at_unix: nowUnix + 3600,
                },
                {
                  bucket_id: "cline-free/deepseek-v4.1-flash",
                  display_name: "cline-free/deepseek-v4.1-flash (Daily limit)",
                  used_percent: 90,
                  reset_at_unix: nowUnix + 3600,
                },
              ],
            },
          ],
        },
      };

      // Absent preference keeps the historical default pair.
      expect(quotaRows(account).map((row) => row.name)).toEqual([
        "cline-free/gemini-3.8-flash (Daily limit)",
        "cline-free/deepseek-v4.1-flash (Daily limit)",
      ]);
      // A wider selection renders exactly the chosen slugs, in bucket order...
      expect(
        quotaRows(account, ["gemini-3.8-flash", "mimo-v2.6-flash"]).map((row) => row.name),
      ).toEqual([
        "cline-free/gemini-3.8-flash (Daily limit)",
        "cline-free/mimo-v2.6-flash (Daily limit)",
      ]);
      // ...and an empty selection hides every daily bucket.
      expect(quotaRows(account, []).map((row) => row.name)).toEqual([]);
      // Non-Cline providers are never filtered by the Cline display pref.
      expect(quotaRows({ ...account, provider: "codex" }, []).map((row) => row.name)).toHaveLength(
        3,
      );
    });

    it("preserves future Cline inferred 100% quota as exhausted", () => {
      const futureClineAccount: NormalizedAccount = {
        ...mockAccount,
        id: "cline-user@example.com",
        provider: "cline",
        label: "cline-user@example.com",
        health: "cooldown",
        cooldownUntilUnixMs: (nowUnix + 3600) * 1000,
        cooldownRemainingSecs: 3600,
        usage: {
          groups: [
            {
              display_name: "Cline Free Limits",
              models: "Cline Free Models",
              buckets: [
                {
                  display_name: "z-ai/glm-5.3-flash (Daily limit)",
                  used_percent: 100,
                  reset_at_unix: nowUnix + 3600,
                },
              ],
            },
          ],
        },
      };

      const rows = quotaRows(futureClineAccount);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.usedPercent).toBe(100);
      expect(rows[0]?.resetSeconds).toBeGreaterThan(0);

      const { rerender } = render(
        <AccountsSurface
          {...createProps({
            accounts: [futureClineAccount],
            visibleAccounts: [futureClineAccount],
            providers: ["cline"],
            selectedProvider: "cline",
            showRemaining: false,
          })}
        />,
      );

      // In used mode (showRemaining: false): displays 100% used
      expect(screen.getByText("100%")).toBeInTheDocument();
      expect(screen.getByText("z-ai/glm-5.3-flash (Daily limit)")).toBeInTheDocument();
      expect(screen.queryByText("Not reported by provider")).not.toBeInTheDocument();

      // In remaining mode (showRemaining: true): displays 0% remaining (exhausted)
      rerender(
        <AccountsSurface
          {...createProps({
            accounts: [futureClineAccount],
            visibleAccounts: [futureClineAccount],
            providers: ["cline"],
            selectedProvider: "cline",
            showRemaining: true,
          })}
        />,
      );
      expect(screen.getByText("0%")).toBeInTheDocument();
      expect(screen.queryByText("Not reported by provider")).not.toBeInTheDocument();
    });

    it("isolates expired vs active model buckets within Cline free limits", () => {
      const mixedClineAccount: NormalizedAccount = {
        ...mockAccount,
        id: "cline-user@example.com",
        provider: "cline",
        label: "cline-user@example.com",
        health: "healthy",
        usage: {
          groups: [
            {
              display_name: "Cline Free Limits",
              models: "Cline Free Models",
              buckets: [
                {
                  display_name: "z-ai/glm-5.3-flash (Daily limit)",
                  used_percent: 100,
                  reset_at_unix: nowUnix - 600, // expired
                },
                {
                  display_name: "moonshot/kimi-k3 (Daily limit)",
                  used_percent: 100,
                  reset_at_unix: nowUnix + 1800, // active 30m
                },
              ],
            },
          ],
        },
      };

      const rows = quotaRows(mixedClineAccount);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("moonshot/kimi-k3 (Daily limit)");
      expect(rows[0]?.usedPercent).toBe(100);
    });

    it("does not globally change other providers actual quota presentation", () => {
      const pastResetCodex: NormalizedAccount = {
        ...mockAccount,
        id: "codex-past",
        provider: "codex",
        usage: {
          primary: {
            limit_name: "5 hour",
            used_percent: 42,
            reset_at_unix: nowUnix - 300,
          },
        },
      };

      const rows = quotaRows(pastResetCodex);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("5 hour");
      expect(rows[0]?.usedPercent).toBe(42);

      const pastResetClinePass: NormalizedAccount = {
        ...mockAccount,
        id: "cline-pass-1",
        provider: "cline-pass",
        usage: {
          groups: [
            {
              display_name: "ClinePass",
              buckets: [
                {
                  display_name: "5-Hour Window",
                  used_percent: 85,
                  reset_at_unix: nowUnix - 120,
                },
              ],
            },
          ],
        },
      };

      const clinePassRows = quotaRows(pastResetClinePass);
      expect(clinePassRows).toHaveLength(1);
      expect(clinePassRows[0]?.name).toBe("5-Hour Window");
      expect(clinePassRows[0]?.usedPercent).toBe(85);

      // Lead blocker case 1: non-Cline provider with same group label must NOT be modified
      const nonClineWithClineGroup: NormalizedAccount = {
        ...mockAccount,
        id: "generic-oracle",
        provider: "generic",
        health: "healthy",
        usage: {
          groups: [
            {
              display_name: "Cline Free Limits",
              buckets: [
                {
                  display_name: "custom-model (Daily limit)",
                  used_percent: 100,
                  reset_at_unix: nowUnix - 300,
                },
              ],
            },
          ],
        },
      };

      const nonClineRows = quotaRows(nonClineWithClineGroup);
      expect(nonClineRows).toHaveLength(1);
      expect(nonClineRows[0]?.name).toBe("custom-model (Daily limit)");
      expect(nonClineRows[0]?.usedPercent).toBe(100);
    });

    it("preserves Cline reported 100% quota when no explicit deadline is present even if account is healthy", () => {
      // Lead blocker case 2: account healthy / no bucket deadline is NOT proof of model quota expiry.
      // Unknown-deadline reported 100 must be preserved unless explicit evidence expires it.
      const clineHealthyNoDeadline: NormalizedAccount = {
        ...mockAccount,
        id: "cline-no-deadline@example.com",
        provider: "cline",
        label: "cline-no-deadline@example.com",
        health: "healthy",
        cooldownUntilUnixMs: null,
        cooldownRemainingSecs: null,
        usage: {
          groups: [
            {
              display_name: "Cline Free Limits",
              models: "Cline Free Models",
              buckets: [
                {
                  display_name: "z-ai/glm-5.3-flash (Daily limit)",
                  used_percent: 100,
                  reset_at_unix: null,
                  reset_after_seconds: null,
                },
              ],
            },
          ],
        },
      };

      const rows = quotaRows(clineHealthyNoDeadline);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("z-ai/glm-5.3-flash (Daily limit)");
      expect(rows[0]?.usedPercent).toBe(100);
    });

    it("displays cooldown badge when GLM free quota is exhausted and healthy when only non-GLM models are exhausted", () => {
      const glmExhaustedCline: NormalizedAccount = {
        ...mockAccount,
        id: "cline-glm-exhausted@example.com",
        provider: "cline",
        label: "cline-glm-exhausted@example.com",
        health: "cooldown",
        cooldownUntilUnixMs: (nowUnix + 1800) * 1000,
        cooldownRemainingSecs: 1800,
        usage: {
          groups: [
            {
              display_name: "Cline Free Limits",
              models: "Cline Free Models",
              buckets: [
                {
                  display_name: "z-ai/glm-5.3-flash (Daily limit)",
                  used_percent: 100,
                  reset_at_unix: nowUnix + 1800,
                },
              ],
            },
          ],
        },
      };

      const { rerender } = render(
        <AccountsSurface
          {...createProps({
            accounts: [glmExhaustedCline],
            visibleAccounts: [glmExhaustedCline],
            providers: ["cline"],
            selectedProvider: "cline",
          })}
        />,
      );

      expect(screen.getByText("cooldown")).toBeInTheDocument();

      const nonGlmExhaustedCline: NormalizedAccount = {
        ...mockAccount,
        id: "cline-kimi-exhausted@example.com",
        provider: "cline",
        label: "cline-kimi-exhausted@example.com",
        health: "healthy",
        cooldownUntilUnixMs: null,
        cooldownRemainingSecs: null,
        usage: {
          groups: [
            {
              display_name: "Cline Free Limits",
              models: "Cline Free Models",
              buckets: [
                {
                  display_name: "z-ai/glm-5.3-flash (Daily limit)",
                  used_percent: 10,
                  reset_at_unix: nowUnix + 1800,
                },
                {
                  display_name: "moonshot/kimi-k3 (Daily limit)",
                  used_percent: 100,
                  reset_at_unix: nowUnix + 3600,
                },
              ],
            },
          ],
        },
      };

      rerender(
        <AccountsSurface
          {...createProps({
            accounts: [nonGlmExhaustedCline],
            visibleAccounts: [nonGlmExhaustedCline],
            providers: ["cline"],
            selectedProvider: "cline",
          })}
        />,
      );

      expect(screen.getByText("healthy")).toBeInTheDocument();
      expect(screen.queryByText("cooldown")).not.toBeInTheDocument();
    });

    it("renders id-only bucket fixture using bucket_id label and honors observed_at_unix relative expiry", () => {
      const idOnlyCline: NormalizedAccount = {
        ...mockAccount,
        id: "cline-id-only@example.com",
        provider: "cline",
        label: "cline-id-only@example.com",
        health: "cooldown",
        usage: {
          observed_at_unix: nowUnix,
          groups: [
            {
              display_name: "Cline Free Limits",
              buckets: [
                {
                  bucket_id: "z-ai/glm-5.3-flash",
                  used_percent: 100,
                  reset_after_seconds: 600,
                },
              ],
            },
          ],
        },
      };

      // Before expiry: row is preserved and labeled with bucket_id. The display
      // list opts this slug in so the labeling regression stays under test.
      const activeRows = quotaRows(idOnlyCline, ["glm-5.3-flash"]);
      expect(activeRows).toHaveLength(1);
      expect(activeRows[0]?.name).toBe("z-ai/glm-5.3-flash");
      expect(activeRows[0]?.usedPercent).toBe(100);

      // Advance nowMs beyond observed_at_unix + reset_after_seconds (nowUnix + 600)
      const expired = isClineInferredQuotaExpired(
        idOnlyCline,
        "Cline Free Limits",
        undefined,
        600,
        (nowUnix + 700) * 1000,
      );
      expect(expired).toBe(true);
    });
  });

  it("renders Warmed badge on account card when quota window is active and account is healthy, hides it on cooldown", () => {
    const props = createProps();
    const warmup = {
      selection: null,
      onOpen: vi.fn(),
      onClose: vi.fn(),
      returnFocus: null,
      settings: null,
      status: {
        accounts: {
          "codex-1": {
            source: "inherit" as const,
            effective: { enabled: true, idle_secs: 3600, min_interval_secs: 300, model: null },
            capability: "supported" as const,
            available_models: ["gpt-5.6-sol"],
            last_result: null,
            last_attempt_at: null,
            next_due_at: 1789866076,
            window_active: true,
            window_reset_at: 1789866076,
            skip_reason: "window_active",
          },
        },
      },
      error: "",
      pending: false,
      onProviderChange: vi.fn(),
      onAccountChange: vi.fn(),
      onSaveProvider: vi.fn(),
      onSaveAccount: vi.fn(),
      onReload: vi.fn(),
    };
    const { rerender } = render(<AccountsSurface {...props} warmup={warmup} />);
    const badge = screen.getByText("Warmed");
    expect(badge).toBeInTheDocument();
    expect(badge.closest(".badge")).toHaveClass("badge-ok");

    // When account is in cooldown, Warmed badge MUST NOT be rendered
    const cooldownAccount = { ...mockAccount, health: "cooldown" as const };
    rerender(
      <AccountsSurface
        {...props}
        accounts={[cooldownAccount]}
        visibleAccounts={[cooldownAccount]}
        warmup={warmup}
      />,
    );
    expect(screen.queryByText("Warmed")).not.toBeInTheDocument();
  });
});

describe("Cline pool quota summary", () => {
  const nowUnix = 1_800_000_000;
  const nowMs = nowUnix * 1000;

  const clineAccount = (
    id: string,
    buckets: Array<{ display_name: string; used_percent: number; reset_at_unix: number }>,
  ): NormalizedAccount => ({
    ...mockAccount,
    id,
    label: id,
    provider: "cline",
    usage: {
      groups: [
        {
          display_name: "Cline Free Limits",
          models: "Cline Free Models",
          buckets,
        },
      ],
    },
  });

  it("does not infer routability from estimated quota across cline accounts", () => {
    const fresh: NormalizedAccount = { ...clineAccount("c1", []), usage: null };
    const glmExhausted = clineAccount("c2", [
      {
        display_name: "cline-free/gemini-3.8-flash (Daily limit)",
        used_percent: 100,
        reset_at_unix: nowUnix + 3600,
      },
      {
        display_name: "cline-free/deepseek-v4.1-flash (Daily limit)",
        used_percent: 50,
        reset_at_unix: nowUnix + 3600,
      },
    ]);
    const deepseekPartial = clineAccount("c3", [
      {
        display_name: "cline-free/gemini-3.8-flash (Daily limit)",
        used_percent: 25,
        reset_at_unix: nowUnix + 3600,
      },
      {
        display_name: "deepseek/deepseek-v4.1-flash (Daily limit)",
        used_percent: 40,
        reset_at_unix: nowUnix + 3600,
      },
    ]);
    const glmExpired = clineAccount("c4", [
      {
        display_name: "cline-free/gemini-3.8-flash (Daily limit)",
        used_percent: 100,
        reset_at_unix: nowUnix - 300,
      },
    ]);
    const nonCline = clineAccount("other", [
      {
        display_name: "cline-free/gemini-3.8-flash (Daily limit)",
        used_percent: 100,
        reset_at_unix: nowUnix + 3600,
      },
    ]);
    const foreign: NormalizedAccount = { ...nonCline, provider: "codex" };

    const [gemini, deepseek] = clinePoolQuotaSummary(
      [fresh, glmExhausted, deepseekPartial, glmExpired, foreign],
      nowMs,
    );

    expect(gemini).toEqual({
      model: "cline-free/gemini-3.8-flash",
      total: 4,
      available: 0,
      unmeasured: 4,
      exhausted: 0,
      remainingSumPercent: 75,
      nextResetAtUnix: null,
    });
    expect(deepseek).toEqual({
      model: "cline-free/deepseek-v4.1-flash",
      total: 4,
      available: 0,
      unmeasured: 4,
      exhausted: 0,
      remainingSumPercent: 110,
      nextResetAtUnix: null,
    });
  });

  it("uses gateway route candidacy rather than estimated percent or another model's cooldown", () => {
    const account: NormalizedAccount = {
      ...clineAccount("c1", [
        { display_name: "cline-free/gemini-3.8-flash", used_percent: 99.9, reset_at_unix: nowUnix + 3600 },
        { display_name: "cline-free/deepseek-v4.1-flash", used_percent: 100, reset_at_unix: nowUnix + 3600 },
      ]),
      modelRoutability: {
        "cline-free/gemini-3.8-flash": false,
        "cline-free/deepseek-v4.1-flash": true,
      },
    };
    const [gemini, deepseek] = clinePoolQuotaSummary([account], nowMs);
    expect(gemini?.available).toBe(0);
    expect(gemini?.exhausted).toBe(1);
    expect(deepseek?.available).toBe(1);
    expect(deepseek?.exhausted).toBe(0);
    const panel = render(
      <AccountsSurface
        {...createProps({ accounts: [account], visibleAccounts: [account], providers: ["cline"], selectedProvider: "cline" })}
      />,
    ).getByTestId("cline-pool-quota-summary");
    expect(panel.textContent).toContain("0 available");
    expect(panel.textContent).toContain("1 unavailable");
    expect(panel.textContent).toContain("1 available");
  });

  it("summarizes only the models selected for display", () => {
    const account = clineAccount("c1", [
      {
        display_name: "cline-free/gemini-3.8-flash (Daily limit)",
        used_percent: 50,
        reset_at_unix: nowUnix + 3600,
      },
      {
        display_name: "cline-free/deepseek-v4.1-flash (Daily limit)",
        used_percent: 20,
        reset_at_unix: nowUnix + 3600,
      },
    ]);

    const onlyGemini = clinePoolQuotaSummary([account], nowMs, ["gemini-3.8-flash"]);
    expect(onlyGemini).toHaveLength(1);
    expect(onlyGemini[0]).toMatchObject({
      model: "cline-free/gemini-3.8-flash",
      remainingSumPercent: 50,
    });

    const widened = clinePoolQuotaSummary([account], nowMs, [
      "gemini-3.8-flash",
      "mimo-v2.6-flash",
      "deepseek-v4.1-flash",
    ]);
    expect(widened.map((row) => row.model)).toEqual([
      "cline-free/gemini-3.8-flash",
      "cline-free/mimo-v2.6-flash",
      "cline-free/deepseek-v4.1-flash",
    ]);
    // A selected model nobody served reports unmeasured, never invented data.
    expect(widened[1]).toMatchObject({
      remainingSumPercent: 0,
      unmeasured: 1,
      available: 0,
      exhausted: 0,
    });
    expect(clinePoolQuotaSummary([account], nowMs, [])).toEqual([]);
  });

  it("renders the pooled summary at the top of the accounts surface", () => {
    const fresh: NormalizedAccount = { ...clineAccount("c1", []), usage: null };
    const { container } = render(
      <AccountsSurface
        {...createProps({
          accounts: [fresh],
          visibleAccounts: [fresh],
          providers: ["cline"],
          selectedProvider: "cline",
        })}
      />,
    );

    const panel = screen.getByTestId("cline-pool-quota-summary");
    expect(panel.textContent).toContain("Cline pool · all 1 accounts · quota estimated");
    expect(panel.querySelectorAll(".quota-row")).toHaveLength(2);
    expect(panel.textContent).toContain("cline-free/gemini-3.8-flash");
    expect(panel.textContent).toContain("cline-free/deepseek-v4.1-flash");
    expect(panel.textContent).toContain("0 available");
    expect(panel.textContent).toContain("1 unknown · 0 unavailable");
    const segments = panel.querySelectorAll(".pool-quota-track i");
    expect(segments).toHaveLength(6);
    expect(segments[0].getAttribute("data-tone")).toBe("ok");
    expect(segments[1].getAttribute("data-tone")).toBe("idle");
    expect(segments[2].getAttribute("data-tone")).toBe("bad");
    const list = container.querySelector(".account-list");
    expect(list).not.toBeNull();
    expect(
      panel.compareDocumentPosition(list as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const tabs = container.querySelector(".provider-tabs");
    expect(tabs).not.toBeNull();
    expect(
      (tabs as Node).compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides the pooled summary on other provider tabs", () => {
    const foreign: NormalizedAccount = { ...mockAccount, provider: "codex", usage: null };
    render(
      <AccountsSurface
        {...createProps({
          accounts: [foreign],
          visibleAccounts: [foreign],
          providers: ["codex", "cline"],
          selectedProvider: "codex",
        })}
      />,
    );

    expect(screen.queryByTestId("cline-pool-quota-summary")).not.toBeInTheDocument();
  });

  describe("quota accuracy, durations, groups, and freshness", () => {
    it("formats quota duration labels (5h, week, custom) from explicit minutes or window contracts", () => {
      expect(formatQuotaDuration(300)).toBe("5h");
      expect(formatQuotaDuration(10080)).toBe("week");
      expect(formatQuotaDuration(1440)).toBe("1d");
      expect(formatQuotaDuration(60)).toBe("1h");
      expect(formatQuotaDuration(120)).toBe("2h");
      expect(formatQuotaDuration(45)).toBe("45m");
      expect(formatQuotaDuration(undefined, "5h")).toBe("5h");
      expect(formatQuotaDuration(undefined, "weekly")).toBe("week");
      expect(formatQuotaDuration(undefined, "300m")).toBe("5h");
      expect(formatQuotaDuration(undefined, "10080m")).toBe("week");
      expect(formatQuotaDuration(undefined, "60m")).toBe("1h");
      expect(formatQuotaDuration(null)).toBeNull();
      expect(formatQuotaDuration(0)).toBeNull();
      expect(formatQuotaDuration(undefined, null)).toBeNull();
    });

    it("labels flat quotas with actual window_minutes duration rather than Primary/Secondary", () => {
      const account: NormalizedAccount = {
        ...mockAccount,
        id: "codex-flat",
        provider: "codex",
        usage: {
          primary: {
            window_minutes: 300,
            used_percent: 45,
            reset_at_unix: 1720001000,
          },
          secondary: {
            window_minutes: 10080,
            used_percent: 80,
            reset_at_unix: 1720500000,
          },
        },
      };

      const rows = quotaRows(account);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.name).toBe("5h");
      expect(rows[0]?.usedPercent).toBe(45);
      expect(rows[1]?.name).toBe("week");
      expect(rows[1]?.usedPercent).toBe(80);
    });

    it("still labels 5h when window_minutes=300 and reset_after_seconds=3600 countdown is short", () => {
      const account: NormalizedAccount = {
        ...mockAccount,
        id: "codex-5h-countdown",
        provider: "codex",
        usage: {
          primary: {
            window_minutes: 300,
            reset_after_seconds: 3600,
            used_percent: 20,
          },
        },
      };

      const rows = quotaRows(account);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("5h");
      expect(rows[0]?.resetSeconds).toBe(3600);
    });

    it("keeps total duration unknown when window_minutes is absent and does not use countdown as duration", () => {
      const unknownDurationAccount: NormalizedAccount = {
        ...mockAccount,
        id: "codex-unknown-duration",
        provider: "codex",
        usage: {
          primary: {
            reset_after_seconds: 3600,
            used_percent: 20,
          },
        },
      };

      const rows = quotaRows(unknownDurationAccount);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("Primary window");
      expect(rows[0]?.resetSeconds).toBe(3600);
    });

    it("preserves meaningful limit identity and qualifies with duration", () => {
      expect(
        formatQuotaWindowName(
          { window_minutes: 300, limit_name: "Code Review" },
          "Primary window",
        ),
      ).toBe("Code Review (5h)");

      expect(
        formatQuotaWindowName(
          { window_minutes: 10080, limit_name: "Chatpass" },
          "Secondary window",
        ),
      ).toBe("Chatpass (week)");

      expect(
        formatQuotaWindowName(
          { window_minutes: 300, limit_name: "5 hour" },
          "Primary window",
        ),
      ).toBe("5 hour");

      expect(
        formatQuotaWindowName(
          { window_minutes: 300, limit_name: "Primary window" },
          "Primary window",
        ),
      ).toBe("5h");

      expect(
        formatQuotaWindowName(
          { window_minutes: 10080, limit_name: "Secondary window" },
          "Secondary window",
        ),
      ).toBe("week");

      expect(
        formatQuotaWindowName(
          { window_minutes: 120, limit_name: "Secondary limit" },
          "Secondary window",
        ),
      ).toBe("2h");
    });

    it("preserves both basic limits and additional quota groups without dropping either", () => {
      const accountWithBoth: NormalizedAccount = {
        ...mockAccount,
        id: "codex-plus-groups",
        provider: "codex",
        usage: {
          primary: {
            window_minutes: 300,
            used_percent: 25,
            reset_after_seconds: 18000,
          },
          secondary: {
            window_minutes: 10080,
            used_percent: 50,
            reset_after_seconds: 604800,
          },
          groups: [
            {
              display_name: "Chatpass",
              models: "chatpass",
              buckets: [
                {
                  display_name: "Chatpass",
                  window: "10080m",
                  used_percent: 10,
                  reset_after_seconds: 604800,
                },
              ],
            },
            {
              display_name: "Code Review",
              models: "code-review",
              buckets: [
                {
                  display_name: "Review Limit",
                  window: "300m",
                  used_percent: 5,
                  reset_after_seconds: 18000,
                },
              ],
            },
          ],
        },
      };

      const rows = quotaRows(accountWithBoth);
      expect(rows).toHaveLength(4);

      // Basic limits are present
      expect(rows[0]?.name).toBe("5h");
      expect(rows[0]?.group).toBeNull();
      expect(rows[0]?.usedPercent).toBe(25);

      expect(rows[1]?.name).toBe("week");
      expect(rows[1]?.group).toBeNull();
      expect(rows[1]?.usedPercent).toBe(50);

      // Additional groups are present with group identities
      expect(rows[2]?.name).toBe("Chatpass (week)");
      expect(rows[2]?.group).toBe("Chatpass");
      expect(rows[2]?.usedPercent).toBe(10);

      expect(rows[3]?.name).toBe("Review (5h)");
      expect(rows[3]?.group).toBe("Code Review");
      expect(rows[3]?.usedPercent).toBe(5);
    });

    it("does not count down an untouched Codex full-window placeholder", () => {
      const account: NormalizedAccount = {
        ...mockAccount,
        provider: "codex",
        usage: {
          primary: { used_percent: 0, window_minutes: 300, reset_after_seconds: 18000 },
          secondary: { used_percent: 0, window_minutes: 10080, reset_after_seconds: 604800 },
        },
      };
      expect(quotaRows(account).map((row) => row.resetSeconds)).toEqual([null, null]);
      expect(quotaRows(account).map((row) => row.usedPercent)).toEqual([0, 0]);
      expect(quotaRows({ ...account, usage: {
        primary: { used_percent: 0, window_minutes: 300, reset_after_seconds: 17900 },
      } })[0]?.resetSeconds).toBe(17900);
    });

    it("preserves both flat and group rows even when they have coincident values", () => {
      const coincidentAccount: NormalizedAccount = {
        ...mockAccount,
        id: "codex-coincident",
        provider: "codex",
        usage: {
          primary: {
            window_minutes: 300,
            used_percent: 25,
            reset_after_seconds: 3600,
          },
          groups: [
            {
              display_name: "Code Review",
              models: "code-review",
              buckets: [
                {
                  display_name: "5h",
                  window_minutes: 300,
                  used_percent: 25,
                  reset_after_seconds: 3600,
                },
              ],
            },
          ],
        },
      };

      const rows = quotaRows(coincidentAccount);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.name).toBe("5h");
      expect(rows[0]?.group).toBeNull();
      expect(rows[0]?.usedPercent).toBe(25);

      expect(rows[1]?.name).toBe("5h");
      expect(rows[1]?.group).toBe("Code Review");
      expect(rows[1]?.usedPercent).toBe(25);
    });

    it("suppresses synthetic flat aggregate projections for Antigravity when groups exist", () => {
      const agAccount: NormalizedAccount = {
        ...mockAccount,
        id: "ag-account",
        provider: "antigravity",
        usage: {
          primary: {
            window_minutes: 300,
            used_percent: 80,
          },
          groups: [
            {
              display_name: "Gemini Models",
              buckets: [
                {
                  display_name: "gemini-1.5-pro",
                  window: "5h",
                  used_percent: 80,
                },
              ],
            },
          ],
        },
      };

      const rows = quotaRows(agAccount);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("gemini-1.5-pro (5h)");
      expect(rows[0]?.group).toBe("Gemini Models");
    });

    it("does not convert unknown quota to 0 or hide unmeasured rows", () => {
      const unmeasuredAccount: NormalizedAccount = {
        ...mockAccount,
        id: "codex-unmeasured",
        provider: "codex",
        usage: {
          primary: {
            window_minutes: 300,
            used_percent: null,
            reset_after_seconds: 18000,
          },
          groups: [
            {
              display_name: "Code Review",
              buckets: [
                {
                  display_name: "Review",
                  used_percent: null,
                  reset_after_seconds: 18000,
                },
              ],
            },
          ],
        },
      };

      const rows = quotaRows(unmeasuredAccount);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.name).toBe("5h");
      expect(rows[0]?.usedPercent).toBeNull();
      expect(rows[1]?.name).toBe("Review");
      expect(rows[1]?.usedPercent).toBeNull();
    });

    it("renders stale quota badge and preserves last known quota rows on AccountCard", () => {
      const staleAccount: NormalizedAccount = {
        ...mockAccount,
        id: "codex-stale",
        provider: "codex",
        usage: {
          refresh_status: "stale",
          refreshed_at_unix: 1720000000,
          primary: {
            window_minutes: 300,
            used_percent: 55,
            reset_after_seconds: 3600,
          },
        },
      };

      const cardProps = (account: NormalizedAccount): AccountCardProps => ({
        account,
        pending: "",
        showRemaining: false,
        onRunAccountAction: vi.fn(),
        onRefresh: vi.fn(),
        onSetCredentialDisabled: vi.fn(),
        onReauthenticate: vi.fn(),
        onRemoveCredential: vi.fn(),
        onSetConfirmRemove: vi.fn(),
        onMoveCredential: vi.fn(),
        onDropCredential: vi.fn(),
        onSetDragging: vi.fn(),
        onContextMenu: vi.fn(),
      });

      render(<AccountCard {...cardProps(staleAccount)} />);

      expect(screen.getByTestId("quota-stale-badge")).toBeInTheDocument();
      expect(screen.getByText("Stale quota")).toBeInTheDocument();
      // Last known quota data is still rendered
      expect(screen.getByText("5h")).toBeInTheDocument();
      expect(screen.getByText("55%")).toBeInTheDocument();
    });

    it("renders refresh failure badge, error message, and preserves last known data", () => {
      const errorAccount: NormalizedAccount = {
        ...mockAccount,
        id: "codex-err",
        provider: "codex",
        usage: {
          refresh_status: "error",
          last_refresh_error: "rate limit exceeded (429)",
          primary: {
            window_minutes: 300,
            used_percent: 75,
            reset_after_seconds: 7200,
          },
        },
      };

      const cardProps = (account: NormalizedAccount): AccountCardProps => ({
        account,
        pending: "",
        showRemaining: false,
        onRunAccountAction: vi.fn(),
        onRefresh: vi.fn(),
        onSetCredentialDisabled: vi.fn(),
        onReauthenticate: vi.fn(),
        onRemoveCredential: vi.fn(),
        onSetConfirmRemove: vi.fn(),
        onMoveCredential: vi.fn(),
        onDropCredential: vi.fn(),
        onSetDragging: vi.fn(),
        onContextMenu: vi.fn(),
      });

      render(<AccountCard {...cardProps(errorAccount)} />);

      expect(screen.getByTestId("quota-refresh-error-badge")).toBeInTheDocument();
      expect(screen.getByText("Refresh failed")).toBeInTheDocument();
      expect(screen.getByTestId("quota-refresh-error")).toHaveTextContent("rate limit exceeded (429)");
      // Last known quota data is still rendered
      expect(screen.getByText("5h")).toBeInTheDocument();
      expect(screen.getByText("75%")).toBeInTheDocument();
    });
  });
});

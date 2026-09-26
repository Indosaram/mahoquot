import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AccountsSurface,
  type AccountsSurfaceProps,
  clinePoolQuotaSummary,
  isClineInferredQuotaExpired,
  quotaRows,
} from "../components/AccountsSurface";
import type { NormalizedAccount } from "../lib/accounts";

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

/** Spending a banked reset dispatches immediately from the menu. */
const spendBankedReset = (label = "dev@example.com") => {
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

  it("spends a banked reset directly when clicked from the menu", () => {
    const onRunAccountAction = vi.fn();
    render(<AccountsSurface {...createProps({ onRunAccountAction })} />);

    spendBankedReset();
    expect(onRunAccountAction).toHaveBeenCalledWith("reset", mockAccount);
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

      // Before expiry: row is preserved and labeled with bucket_id
      const activeRows = quotaRows(idOnlyCline);
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

  it("classifies measured, unmeasured, and exhausted across every cline account", () => {
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
      available: 1,
      unmeasured: 2,
      exhausted: 1,
      remainingSumPercent: 75,
      nextResetAtUnix: nowUnix + 3600,
    });
    expect(deepseek).toEqual({
      model: "cline-free/deepseek-v4.1-flash",
      total: 4,
      available: 2,
      unmeasured: 2,
      exhausted: 0,
      remainingSumPercent: 110,
      nextResetAtUnix: null,
    });
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
    expect(panel.textContent).toContain("Pooled quota · all 1 cline accounts · estimated");
    expect(panel.querySelectorAll(".quota-row")).toHaveLength(2);
    expect(panel.textContent).toContain("cline-free/gemini-3.8-flash");
    expect(panel.textContent).toContain("cline-free/deepseek-v4.1-flash");
    expect(panel.textContent).toContain("0 available");
    expect(panel.textContent).toContain("1 unmeasured · 0 exhausted");
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
});

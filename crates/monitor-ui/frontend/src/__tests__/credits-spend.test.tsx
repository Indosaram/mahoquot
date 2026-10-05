import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CreditBalanceRow,
} from "../components/CreditsSpendControls";
import {
  AccountsSurface,
  type AccountsSurfaceProps,
  type CreditSpendProps,
} from "../components/AccountsSurface";
import {
  creditBalanceLabel,
  formatCredits,
  interpretCreditBalance,
} from "../lib/credits";
import type { NormalizedAccount } from "../lib/accounts";
import type { Usage } from "../lib/schemas";

const codexAccount = (id: string, label = id): NormalizedAccount => ({
  id,
  runtimeId: id,
  credentialName: `${id}.json`,
  disabled: false,
  authIndex: `${id}.json`,
  provider: "codex",
  plan: null,
  email: label,
  label,
  health: "healthy",
  healthRaw: "available",
  cooldownUntilUnixMs: null,
  cooldownRemainingSecs: null,
  ok: 10,
  fails: 0,
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  failureRate: 0,
  p50Ms: 100,
  lastError: null,
  usage: { plan_type: "Pro" },
  quotaCapability: "supported",
  isCredentialOnly: false,
  canReset: false,
  resetCreditsAvailable: 0,
  supportsReset: false,
  resetCredits: [],
});

const surfaceProps = (
  accounts: readonly NormalizedAccount[],
  overrides?: Partial<AccountsSurfaceProps>,
): AccountsSurfaceProps => ({
  accounts,
  providers: [...new Set(accounts.map((account) => account.provider))],
  selectedProvider: accounts[0]?.provider,
  visibleAccounts: accounts,
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

const creditProps = (
  flags: CreditSpendProps["flags"],
  overrides?: Partial<CreditSpendProps>,
): CreditSpendProps => ({
  flags,
  pending: "",
  onToggleAccount: vi.fn(),
  ...overrides,
});

describe("credit balance display", () => {
  it("renders an exact balance as credits, never dollars", () => {
    const usage: Usage = { credits_balance: 1234.5, has_credits: true };
    const { container } = render(<CreditBalanceRow usage={usage} />);
    expect(screen.getByTestId("account-credit-value")).toHaveTextContent("1,234.5 credits");
    expect(screen.getByTestId("account-credit-balance")).toHaveAttribute("data-state", "value");
    expect(container.textContent).not.toContain("$");
  });

  it("renders a measured zero as zero, distinct from unknown", () => {
    render(<CreditBalanceRow usage={{ credits_balance: 0, has_credits: true }} />);
    expect(screen.getByTestId("account-credit-value")).toHaveTextContent("0 credits");
    expect(screen.getByTestId("account-credit-balance")).toHaveAttribute("data-state", "value");
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  it("renders a no-credits answer when the gateway affirmatively reported none", () => {
    render(<CreditBalanceRow usage={{ has_credits: false }} />);
    render(<CreditBalanceRow usage={{ credits_balance: null, has_credits: false }} />);
    const values = screen.getAllByTestId("account-credit-value");
    expect(values).toHaveLength(2);
    for (const value of values) expect(value).toHaveTextContent("No credits");
    expect(screen.getAllByTestId("account-credit-balance")[0]).toHaveAttribute(
      "data-state",
      "none",
    );
  });

  it("renders an unreported balance as unknown, never zero", () => {
    render(<CreditBalanceRow usage={{ credits_balance: null }} />);
    expect(screen.getByTestId("account-credit-value")).toHaveTextContent("Unknown");
    expect(screen.getByTestId("account-credit-balance")).toHaveAttribute("data-state", "unknown");
    expect(screen.queryByText(/0 credits/)).not.toBeInTheDocument();
  });

  it("renders unlimited without an amount", () => {
    render(<CreditBalanceRow usage={{ credits_unlimited: true, credits_balance: null }} />);
    expect(screen.getByTestId("account-credit-value")).toHaveTextContent("Unlimited");
    expect(screen.getByTestId("account-credit-balance")).toHaveAttribute(
      "data-state",
      "unlimited",
    );
  });

  it("marks overage while keeping the reported amount in credits", () => {
    render(
      <CreditBalanceRow usage={{ credits_balance: 12.5, overage_limit_reached: true }} />,
    );
    expect(screen.getByTestId("account-credit-value")).toHaveTextContent(
      "12.5 credits · overage limit reached",
    );
    expect(screen.getByTestId("account-credit-balance")).toHaveAttribute("data-state", "overage");
  });

  it("hides the row when the gateway reported no credit detail at all", () => {
    const { container } = render(<CreditBalanceRow usage={{ plan_type: "Pro" }} />);
    expect(container.querySelector('[data-testid="account-credit-balance"]')).toBeNull();
  });

  it("keeps unknown distinct through the label helper", () => {
    expect(creditBalanceLabel(interpretCreditBalance(undefined))).toBe("Unknown");
    expect(creditBalanceLabel(interpretCreditBalance({ credits_balance: 0 }))).toBe(
      "0 credits",
    );
    expect(formatCredits(1234.5)).toBe("1,234.5 credits");
  });
});

describe("account menu credit controls", () => {
  const open = (id: string) => {
    fireEvent.click(screen.getByRole("button", { name: `More actions for ${id}` }));
    return screen.getByRole("menuitemcheckbox", { name: `Use credits after limit for ${id}` });
  };

  it("keeps settings out of cards and exposes the current value in the menu", () => {
    render(<AccountsSurface {...surfaceProps([codexAccount("codex-1")])} credits={creditProps({})} />);
    expect(screen.queryByTestId("global-credits-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("account-credits-toggle")).not.toBeInTheDocument();
    expect(open("codex-1")).toHaveAttribute("aria-checked", "false");
  });

  it.each([false, true])("requests the opposite value when enabled is %s", (enabled) => {
    const account = codexAccount("codex-1");
    const onToggleAccount = vi.fn();
    render(<AccountsSurface {...surfaceProps([account])} credits={creditProps({ "codex-1": enabled }, { onToggleAccount })} />);
    fireEvent.click(open(account.id));
    expect(onToggleAccount).toHaveBeenCalledWith(account, !enabled);
  });

  it("disables only the pending account menu setting", () => {
    const onToggleAccount = vi.fn();
    render(<AccountsSurface {...surfaceProps([codexAccount("codex-1"), codexAccount("codex-2")])} credits={creditProps({}, { pending: "credits:codex-1", onToggleAccount })} />);
    const pending = open("codex-1");
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    fireEvent.click(pending);
    expect(onToggleAccount).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(open("codex-2")).toBeEnabled();
  });

  it("omits the setting for unsupported providers", () => {
    render(<AccountsSurface {...surfaceProps([{ ...codexAccount("ag-1"), provider: "antigravity" }])} credits={creditProps({})} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for ag-1" }));
    expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument();
  });

  it("omits the setting when the gateway policy is unavailable", () => {
    render(<AccountsSurface {...surfaceProps([codexAccount("codex-1")])} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for codex-1" }));
    expect(screen.queryByRole("menuitemcheckbox")).not.toBeInTheDocument();
  });
});

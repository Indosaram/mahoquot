import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type AccountCreditsControl,
  AccountCreditsToggle,
  CreditBalanceRow,
  GlobalCreditsToggle,
} from "../components/CreditsSpendControls";
import {
  AccountsSurface,
  type AccountsSurfaceProps,
  type CreditSpendProps,
} from "../components/AccountsSurface";
import {
  creditBalanceLabel,
  creditSpendGlobalState,
  creditSpendSummary,
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
  onToggleAll: vi.fn(),
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

  it("renders an unreported balance as unknown, never zero", () => {
    render(<CreditBalanceRow usage={{ credits_balance: null, has_credits: false }} />);
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

describe("per-account credits toggle", () => {
  const control = (overrides?: Partial<AccountCreditsControl>): AccountCreditsControl => ({
    enabled: false,
    pending: false,
    onToggle: vi.fn(),
    ...overrides,
  });

  it("defaults to off and requests the opposite value on click", () => {
    const onToggle = vi.fn();
    render(
      <AccountCreditsToggle accountLabel="dev@example.com" {...control({ onToggle })} />,
    );
    const toggle = screen.getByRole("switch", {
      name: "Use credits after limit for dev@example.com",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("stays disabled and busy while the mutation is pending", () => {
    const onToggle = vi.fn();
    render(
      <AccountCreditsToggle accountLabel="dev@example.com" {...control({ pending: true, onToggle })} />,
    );
    const toggle = screen.getByRole("switch");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-busy", "true");
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("states the policy is proxy-local and not provider billing", () => {
    render(<AccountCreditsToggle accountLabel="dev@example.com" {...control()} />);
    expect(screen.getByText(/proxy-local routing policy/i)).toBeInTheDocument();
    expect(screen.getByText(/never your provider account billing/i)).toBeInTheDocument();
  });
});

describe("global credits toggle", () => {
  it("derives mixed state and requests all-on from a partial opt-in", () => {
    const summary = creditSpendSummary(["a", "b", "c"], { a: true, b: undefined, c: false });
    expect(summary).toEqual({ enabled: 1, total: 3 });
    expect(creditSpendGlobalState(summary)).toBe("mixed");

    const onToggle = vi.fn();
    render(
      <GlobalCreditsToggle
        summary={summary}
        state={creditSpendGlobalState(summary)}
        pending={false}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByTestId("global-credits-state")).toHaveTextContent("some on");
    const toggle = screen.getByRole("switch", {
      name: "Use credits after limit for all accounts",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("reads all-on only when every account opted in, and clears all on click", () => {
    const summary = creditSpendSummary(["a", "b"], { a: true, b: true });
    expect(creditSpendGlobalState(summary)).toBe("on");
    const onToggle = vi.fn();
    render(
      <GlobalCreditsToggle summary={summary} state="on" pending={false} onToggle={onToggle} />,
    );
    expect(screen.getByTestId("global-credits-state")).toHaveTextContent("all on");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("is off and inert when no account exists", () => {
    const onToggle = vi.fn();
    render(
      <GlobalCreditsToggle
        summary={{ enabled: 0, total: 0 }}
        state="off"
        pending={false}
        onToggle={onToggle}
      />,
    );
    const toggle = screen.getByRole("switch");
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("is inert while the bulk mutation is pending", () => {
    const onToggle = vi.fn();
    render(
      <GlobalCreditsToggle
        summary={{ enabled: 1, total: 2 }}
        state="mixed"
        pending
        onToggle={onToggle}
      />,
    );
    const toggle = screen.getByRole("switch");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-busy", "true");
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("AccountsSurface credit controls", () => {
  it("shows the global switch and per-account switches for codex only", () => {
    const antigravity = { ...codexAccount("ag-1"), provider: "antigravity" };
    render(
      <AccountsSurface
        {...surfaceProps([codexAccount("codex-1"), antigravity])}
        credits={creditProps({})}
      />,
    );
    expect(screen.getByTestId("global-credits-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("global-credits-state")).toHaveTextContent("off");
    expect(screen.getAllByTestId("account-credits-toggle")).toHaveLength(1);
    expect(screen.queryByRole("switch", { name: /ag-1/ })).not.toBeInTheDocument();
  });

  it("scopes pending to the mutating card so sibling toggles stay live", () => {
    const first = codexAccount("codex-1");
    const second = codexAccount("codex-2");
    render(
      <AccountsSurface
        {...surfaceProps([first, second])}
        credits={creditProps({}, { pending: "credits:codex-1" })}
      />,
    );
    expect(
      screen.getByRole("switch", { name: "Use credits after limit for codex-1" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Use credits after limit for codex-2" }),
    ).toBeEnabled();
  });

  it("omits every credit control when the gateway does not expose the policy", () => {
    render(<AccountsSurface {...surfaceProps([codexAccount("codex-1")])} />);
    expect(screen.queryByTestId("global-credits-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("account-credits-toggle")).not.toBeInTheDocument();
  });

  it("routes per-account and bulk toggles to the surface owner", () => {
    const first = codexAccount("codex-1");
    const second = codexAccount("codex-2");
    const onToggleAccount = vi.fn();
    const onToggleAll = vi.fn();
    render(
      <AccountsSurface
        {...surfaceProps([first, second])}
        credits={creditProps(
          { "codex-1": true },
          { onToggleAccount, onToggleAll },
        )}
      />,
    );
    fireEvent.click(
      screen.getByRole("switch", { name: "Use credits after limit for codex-2" }),
    );
    expect(onToggleAccount).toHaveBeenCalledWith(second, true);

    fireEvent.click(
      screen.getByRole("switch", { name: "Use credits after limit for all accounts" }),
    );
    expect(onToggleAll).toHaveBeenCalledWith(true);
  });
});

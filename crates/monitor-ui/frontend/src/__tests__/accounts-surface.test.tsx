import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountsSurface, type AccountsSurfaceProps } from "../components/AccountsSurface";
import type { NormalizedAccount } from "../lib/accounts";

const mockAccount: NormalizedAccount = {
  id: "codex-1",
  runtimeId: "codex-1",
  credentialName: "codex-1.json",
  disabled: false,
  authIndex: "codex-1.json",
  provider: "codex",
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
  },
  quotaCapability: "supported",
  isCredentialOnly: false,
  canReset: true,
  resetCreditsAvailable: 1,
};

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

describe("AccountsSurface component", () => {
  it("folds token usage and reveals input, output, and total on expand", () => {
    render(<AccountsSurface {...createProps()} />);

    const usage = screen.getByLabelText("Token usage");
    expect(usage).toHaveTextContent("1.7K");
    expect(usage).not.toHaveTextContent("1.3K");

    fireEvent.click(screen.getByRole("button", { name: /Tokens/ }));
    expect(usage).toHaveTextContent("1.3K");
    expect(usage).toHaveTextContent("430");
    expect(usage).toHaveTextContent("1.7K");

    fireEvent.click(screen.getByRole("button", { name: /Tokens/ }));
    expect(usage).not.toHaveTextContent("1.3K");
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
    fireEvent.click(screen.getByRole("button", { name: "Reset window" }));
    expect(onRunAccountAction).toHaveBeenCalledWith("reset", mockAccount);
    fireEvent.click(screen.getByRole("button", { name: "Disable dev@example.com" }));
    expect(onSetCredentialDisabled).toHaveBeenCalledWith(mockAccount, true);
    fireEvent.click(screen.getByRole("button", { name: "Re-authenticate dev@example.com" }));
    expect(onReauthenticate).toHaveBeenCalledWith(mockAccount);
    fireEvent.click(screen.getByRole("button", { name: "Remove dev@example.com" }));
    expect(onSetConfirmRemove).toHaveBeenCalledWith("codex-1");
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
});

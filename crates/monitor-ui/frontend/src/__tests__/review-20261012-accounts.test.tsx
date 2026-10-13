import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountCard, type AccountCardProps } from "../components/AccountCard";
import { AccountsSurface, type AccountsSurfaceProps } from "../components/AccountsSurface";
import { SharedKeysCard } from "../components/SharedKeysCard";
import type { NormalizedAccount } from "../lib/accounts";
import type { ScopedApiKey } from "../lib/schemas";

afterEach(cleanup);

const account: NormalizedAccount = {
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
  ok: 1,
  fails: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  failureRate: 0,
  p50Ms: 0,
  lastError: null,
  usage: null,
  quotaCapability: "supported",
  isCredentialOnly: false,
  canReset: false,
  resetCreditsAvailable: 0,
  supportsReset: false,
  resetCredits: [],
};

const cardProps = (overrides: Partial<AccountCardProps> = {}): AccountCardProps => ({
  account,
  pending: "",
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

describe("AccountCard error rows only for actionable failures", () => {
  it.each([
    [401, "Token expired"],
    [403, "Forbidden"],
    [0, "authentication required: re-login"],
  ])("shows lastError status %i %s", (status, message) => {
    render(
      <AccountCard
        {...cardProps({ account: { ...account, lastError: { unix_ms: 1, status, message } } })}
      />,
    );
    expect(screen.getByRole("button", { name: "Dismiss error" })).toBeInTheDocument();
  });

  it.each([
    [429, "Too many requests"],
    [503, "upstream unavailable"],
    [500, ""],
    [0, "request timed out"],
    [0, "rate limit exceeded"],
  ])("suppresses lastError status %i %s", (status, message) => {
    render(
      <AccountCard
        {...cardProps({ account: { ...account, lastError: { unix_ms: 1, status, message } } })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Dismiss error" })).toBeNull();
  });

  it("suppresses the quota refresh error row when rate limited but keeps the badge", () => {
    render(
      <AccountCard
        {...cardProps({
          account: {
            ...account,
            usage: { refresh_status: "rate_limited", last_refresh_error: "HTTP 400 limit" },
          },
        })}
      />,
    );
    expect(screen.queryByTestId("quota-refresh-error")).toBeNull();
    expect(screen.getByTestId("quota-rate-limited-badge")).toBeInTheDocument();
  });

  it.each(["rate limit exceeded (429)", "upstream 503 Service Unavailable", "request timed out"])(
    "suppresses the quota refresh error row for transient error %s",
    (message) => {
      render(
        <AccountCard
          {...cardProps({
            account: {
              ...account,
              usage: { refresh_status: "error", last_refresh_error: message },
            },
          })}
        />,
      );
      expect(screen.queryByTestId("quota-refresh-error")).toBeNull();
    },
  );

  it("keeps the quota refresh error row for an auth failure", () => {
    render(
      <AccountCard
        {...cardProps({
          account: {
            ...account,
            usage: { refresh_status: "error", last_refresh_error: "unauthorized (401)" },
          },
        })}
      />,
    );
    expect(screen.getByTestId("quota-refresh-error")).toBeInTheDocument();
  });
});

describe("AccountCard overflow menu keyboard model", () => {
  const openMenu = async () => {
    const user = userEvent.setup();
    render(<AccountCard {...cardProps()} />);
    const trigger = screen.getByRole("button", { name: "More actions for dev@example.com" });
    await user.click(trigger);
    return { user, trigger, items: screen.getAllByRole("menuitem") };
  };

  it("focuses the first item on open and cycles with arrows, Home and End", async () => {
    const { user, items } = await openMenu();
    expect(items.length).toBeGreaterThan(1);
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(items.at(-1)).toHaveFocus();
    await user.keyboard("{Home}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{End}");
    expect(items.at(-1)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
  });

  it("returns focus to the trigger on Escape", async () => {
    const { user, trigger, items } = await openMenu();
    expect(items[0]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the trigger after activating an item", async () => {
    const onSetConfirmRemove = vi.fn();
    const user = userEvent.setup();
    render(<AccountCard {...cardProps({ onSetConfirmRemove })} />);
    const trigger = screen.getByRole("button", { name: "More actions for dev@example.com" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Remove dev@example.com" }));
    expect(onSetConfirmRemove).toHaveBeenCalledWith("codex-1");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe("AccountsSurface provider tabs semantics", () => {
  const surfaceProps = (): AccountsSurfaceProps =>
    ({
      accounts: [account],
      visibleAccounts: [account],
      providers: ["codex", "google-antigravity"],
      selectedProvider: "codex",
      pending: "",
      dragging: "",
      confirmRemove: "",
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
    }) as unknown as AccountsSurfaceProps;

  it("exposes the provider tabs as a named radiogroup with display-label names", () => {
    render(<AccountsSurface {...surfaceProps()} />);
    const group = screen.getByRole("radiogroup", { name: "Providers" });
    expect(within(group).getByRole("radio", { name: "Codex 1 account" })).toBeChecked();
    expect(
      within(group).getByRole("radio", { name: "Google Antigravity 0 accounts" }),
    ).toBeInTheDocument();
  });
});

const key: ScopedApiKey = {
  id: "shk_1",
  name: "Partner",
  key_prefix: "mq-sh-1234...",
  key_identifier: "ident_1",
  allowed_providers: ["openai"],
  allowed_accounts: [],
  allowed_models: [],
  token_limit: 1_000_000,
  token_used: 250_000,
  is_active: true,
  is_exhausted: false,
  created_at_ms: 1_700_000_000_000,
  expires_at_ms: null,
  raw_key: "mq-sh-secret-value",
};

const renderKeys = (overrides: Partial<React.ComponentProps<typeof SharedKeysCard>> = {}) => {
  const props = {
    scopedKeys: [key],
    availableModels: [],
    availableAccounts: [{ id: "acc_1", provider: "codex" }],
    baseUrl: "http://127.0.0.1:18801",
    onCreateKey: vi.fn(),
    onPatchKey: vi.fn().mockResolvedValue(undefined),
    onDeleteKey: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } satisfies React.ComponentProps<typeof SharedKeysCard>;
  render(<SharedKeysCard {...props} />);
  return props;
};

describe("SharedKeysCard dialogs and secrets", () => {
  it("keeps the one-time issued key panel open on Escape", async () => {
    const user = userEvent.setup();
    const onCreateKey = vi.fn().mockResolvedValue({ api_key: "mq-sh-once", key });
    renderKeys({ onCreateKey });
    await user.click(screen.getByRole("button", { name: /Issue key/i }));
    await user.type(screen.getByPlaceholderText("Name"), "Fresh");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    const panel = await screen.findByRole("dialog", { name: "Shared key created" });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Shared key created" })).toBe(panel);
    await user.click(within(panel).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Shared key created" })).toBeNull();
  });

  it("moves focus into the drawer, traps Tab, and restores focus on close", async () => {
    const user = userEvent.setup();
    renderKeys();
    const opener = screen.getByRole("button", { name: /Issue key/i });
    await user.click(opener);
    const drawer = screen.getByRole("dialog", { name: "Issue scoped remote key" });
    expect(within(drawer).getByPlaceholderText("Name")).toHaveFocus();

    const focusables = Array.from(
      drawer.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"),
    );
    const last = focusables.at(-1) as HTMLElement;
    const first = focusables[0] as HTMLElement;
    last.focus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();

    await user.click(within(drawer).getByRole("button", { name: "Cancel" }));
    expect(opener).toHaveFocus();
  });

  it("masks the edit API key value behind a reveal toggle", async () => {
    const user = userEvent.setup();
    renderKeys();
    await user.click(screen.getByRole("button", { name: "Edit Partner" }));
    const drawer = screen.getByRole("dialog", { name: "Edit Partner" });
    const input = within(drawer).getByPlaceholderText("Set or regenerate secret key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("mq-sh-secret-value");
    await user.click(within(drawer).getByRole("button", { name: "Show API key value" }));
    expect(input).toHaveAttribute("type", "text");
    await user.click(within(drawer).getByRole("button", { name: "Hide API key value" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("disables Add quota with a field error for an invalid amount", async () => {
    const user = userEvent.setup();
    const props = renderKeys();
    await user.click(screen.getByRole("button", { name: "Top up Partner" }));
    const dialog = screen.getByRole("dialog", { name: "Top up Partner" });
    const amount = within(dialog).getByRole("spinbutton");
    const add = within(dialog).getByRole("button", { name: "Add quota" });
    expect(add).toBeEnabled();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.clear(amount);
    expect(add).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/greater than 0/);
    fireEvent.change(amount, { target: { value: "0" } });
    expect(add).toBeDisabled();
    await user.click(add);
    expect(props.onPatchKey).not.toHaveBeenCalled();
  });

  it("does not make the usage meter a Tab stop", () => {
    renderKeys();
    const meter = screen.getByRole("meter", { name: "Partner token usage" });
    expect(meter).not.toHaveAttribute("tabindex");
  });

  it("checks the canonical chip for a stored provider alias in the edit drawer", async () => {
    const user = userEvent.setup();
    const props = renderKeys();
    await user.click(screen.getByRole("button", { name: "Edit Partner" }));
    const drawer = screen.getByRole("dialog", { name: "Edit Partner" });
    const providers = within(drawer).getByRole("region", { name: "Allowed providers" });
    const checked = within(providers)
      .getAllByRole("checkbox")
      .filter((box) => (box as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAccessibleName("codex");
    await user.click(within(drawer).getByRole("button", { name: "Save changes" }));
    expect(props.onPatchKey).toHaveBeenCalledWith(
      "shk_1",
      expect.objectContaining({ allowed_providers: ["codex"] }),
    );
  });
});

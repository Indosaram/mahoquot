import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedKeysCard } from "../components/SharedKeysCard";
import type { GatewayModelEntry, ScopedApiKey } from "../lib/schemas";

afterEach(cleanup);

const activeKey: ScopedApiKey = {
  id: "shk_1",
  name: "Research Partner",
  key_prefix: "mq-sh-1234...",
  key_identifier: "ident_1",
  allowed_providers: ["claude"],
  allowed_accounts: ["acc_1"],
  allowed_models: ["claude-3-5-sonnet"],
  token_limit: 1_000_000,
  token_used: 250_000,
  is_active: true,
  is_exhausted: false,
  created_at_ms: 1_700_000_000_000,
  expires_at_ms: null,
};

const models: GatewayModelEntry[] = [
  { id: "claude-3-5-sonnet", object: "model", owned_by: "claude" },
  { id: "gpt-4o", object: "model", owned_by: "codex" },
];

const accounts = [
  { id: "acc_1", provider: "claude" },
  { id: "acc_2", provider: "codex" },
];

const renderCard = (overrides: Partial<React.ComponentProps<typeof SharedKeysCard>> = {}) => {
  const props = {
    scopedKeys: [activeKey],
    availableModels: models,
    availableAccounts: accounts,
    baseUrl: "http://127.0.0.1:18801",
    onCreateKey: vi.fn(),
    onPatchKey: vi.fn().mockResolvedValue(undefined),
    onDeleteKey: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } satisfies React.ComponentProps<typeof SharedKeysCard>;
  render(<SharedKeysCard {...props} />);
  return props;
};

describe("SharedKeysCard", () => {
  it("R12 omits unlimited top ups without restricting a million-token key and preserves finite top ups", async () => {
    const user = userEvent.setup();
    const { onPatchKey } = renderCard({
      scopedKeys: [
        activeKey,
        {
          ...activeKey,
          id: "unlimited",
          name: "Unlimited Partner",
          token_limit: 0,
          token_used: 1_000_000,
        },
      ],
    });

    expect(screen.queryByRole("button", { name: "Top up Unlimited Partner" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Unlimited Partner" })).toBeEnabled();
    expect(onPatchKey).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Top up Research Partner" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Top up Research Partner" })).getByRole("button", {
        name: "Add quota",
      }),
    );
    expect(onPatchKey).toHaveBeenCalledTimes(1);
    expect(onPatchKey).toHaveBeenCalledWith("shk_1", { token_limit: 1_500_000 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders issued scoped keys with usage progress and scope summaries", () => {
    renderCard();

    expect(screen.getByText("Shared API keys")).toBeInTheDocument();
    expect(screen.getByText("Research Partner")).toBeInTheDocument();
    expect(screen.getByText("mq-sh-1234...")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("250,000 / 1,000,000 tokens")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();

    const progress = screen.getByRole("progressbar", { name: "Research Partner token usage" });
    expect(progress).toHaveAttribute("aria-valuenow", "25");

    const scopes = screen.getByText("Providers").closest("dl");
    if (!scopes) throw new Error("scope list missing");
    expect(within(scopes).getByText("claude")).toBeInTheDocument();
    expect(within(scopes).getByText("acc_1")).toBeInTheDocument();
    expect(within(scopes).getByText("claude-3-5-sonnet")).toBeInTheDocument();
  });

  it("renders unrestricted scopes as All and unlimited budgets without a progress bar", () => {
    renderCard({
      scopedKeys: [
        {
          ...activeKey,
          id: "shk_open",
          name: "Open Key",
          allowed_providers: [],
          allowed_accounts: [],
          allowed_models: [],
          token_limit: 0,
          token_used: 4_200,
        },
      ],
    });

    expect(screen.getAllByText("All")).toHaveLength(3);
    expect(screen.getByText("4,200 tokens used")).toBeInTheDocument();
    expect(screen.getByText("Unlimited")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("marks exhausted and paused keys with distinct status badges", () => {
    renderCard({
      scopedKeys: [
        { ...activeKey, id: "a", name: "Spent", token_used: 1_000_000, is_exhausted: true },
        { ...activeKey, id: "b", name: "Halted", is_active: false },
      ],
    });

    expect(screen.getByText("Exhausted")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("shows an empty state when no keys are issued", () => {
    renderCard({ scopedKeys: [] });
    expect(screen.getByText(/No shared keys issued yet/i)).toBeInTheDocument();
  });

  it("creates a key with selected scopes and a preset token limit, then reveals the raw key", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const onCreateKey = vi.fn().mockResolvedValue({
      api_key: "mq-sh-new-secret-xyz",
      key: { ...activeKey, id: "shk_new", name: "New Student Key", token_limit: 2_000_000 },
    });

    renderCard({ onCreateKey });

    await user.click(screen.getByRole("button", { name: /Issue key/i }));
    const drawer = screen.getByRole("dialog", { name: "Issue scoped remote key" });

    await user.type(within(drawer).getByPlaceholderText("Name"), "New Student Key");

    const providers = within(drawer).getByRole("region", { name: "Allowed providers" });
    await user.click(within(providers).getByRole("button", { name: "Select all" }));

    const accountScope = within(drawer).getByRole("region", { name: "Allowed accounts" });
    await user.click(within(accountScope).getByRole("checkbox", { name: /acc_2/ }));

    const modelScope = within(drawer).getByRole("region", { name: "Allowed models" });
    await user.click(within(modelScope).getByRole("checkbox", { name: "gpt-4o" }));

    await user.click(within(drawer).getByRole("button", { name: "2M" }));
    await user.click(within(drawer).getByRole("button", { name: "Create key" }));

    await waitFor(() => expect(onCreateKey).toHaveBeenCalledTimes(1));
    expect(onCreateKey).toHaveBeenCalledWith({
      name: "New Student Key",
      allowed_providers: ["claude", "codex"],
      allowed_accounts: ["acc_2"],
      allowed_models: ["gpt-4o"],
      token_limit: 2_000_000,
    });

    const success = await screen.findByRole("dialog", { name: "Shared key created" });
    expect(within(success).getByText("mq-sh-new-secret-xyz")).toBeInTheDocument();
    expect(within(success).getByText("http://127.0.0.1:18801/v1")).toBeInTheDocument();
    expect(
      within(success).getByText("Authorization: Bearer mq-sh-new-secret-xyz"),
    ).toBeInTheDocument();

    await user.click(within(success).getByRole("button", { name: "Copy shared API key" }));
    expect(writeText).toHaveBeenCalledWith("mq-sh-new-secret-xyz");
    expect(await within(success).findByText("Copied")).toBeInTheDocument();
  });

  it("prefers the public tunnel origin for the shared endpoint instructions", async () => {
    const user = userEvent.setup();
    const onCreateKey = vi.fn().mockResolvedValue({
      api_key: "mq-sh-tunnel",
      key: { ...activeKey, id: "shk_t", name: "Tunnel Key" },
    });

    renderCard({ onCreateKey, tunnelUrl: "https://demo.trycloudflare.com/" });

    await user.click(screen.getByRole("button", { name: /Issue key/i }));
    const drawer = screen.getByRole("dialog", { name: "Issue scoped remote key" });
    await user.type(within(drawer).getByPlaceholderText("Name"), "Tunnel Key");
    await user.click(within(drawer).getByRole("button", { name: "Create key" }));

    const success = await screen.findByRole("dialog", { name: "Shared key created" });
    expect(within(success).getByText("https://demo.trycloudflare.com/v1")).toBeInTheDocument();
  });

  it("sends an unrestricted payload when no scope chips are selected", async () => {
    const user = userEvent.setup();
    const onCreateKey = vi.fn().mockResolvedValue({
      api_key: "mq-sh-open",
      key: { ...activeKey, id: "shk_open" },
    });

    renderCard({ onCreateKey });

    await user.click(screen.getByRole("button", { name: /Issue key/i }));
    const drawer = screen.getByRole("dialog", { name: "Issue scoped remote key" });
    await user.type(within(drawer).getByPlaceholderText("Name"), "Wide Open");
    await user.click(within(drawer).getByRole("button", { name: "Create key" }));

    await waitFor(() => expect(onCreateKey).toHaveBeenCalledTimes(1));
    expect(onCreateKey).toHaveBeenCalledWith({
      name: "Wide Open",
      allowed_providers: [],
      allowed_accounts: [],
      allowed_models: [],
      token_limit: 1_000_000,
    });
  });

  it("lets a custom limit override the selected preset", async () => {
    const user = userEvent.setup();
    const onCreateKey = vi.fn().mockResolvedValue({
      api_key: "mq-sh-custom",
      key: { ...activeKey, id: "shk_custom" },
    });

    renderCard({ onCreateKey });

    await user.click(screen.getByRole("button", { name: /Issue key/i }));
    const drawer = screen.getByRole("dialog", { name: "Issue scoped remote key" });
    await user.type(within(drawer).getByPlaceholderText("Name"), "Custom Budget");
    await user.click(within(drawer).getByRole("button", { name: "500K" }));
    await user.type(within(drawer).getByPlaceholderText("Custom token limit"), "750000");
    await user.click(within(drawer).getByRole("button", { name: "Create key" }));

    await waitFor(() => expect(onCreateKey).toHaveBeenCalledTimes(1));
    expect(onCreateKey.mock.calls[0][0]).toMatchObject({ token_limit: 750_000 });
  });

  it("blocks creation until a name is entered", async () => {
    const user = userEvent.setup();
    const onCreateKey = vi.fn();
    renderCard({ onCreateKey });

    await user.click(screen.getByRole("button", { name: /Issue key/i }));
    const drawer = screen.getByRole("dialog", { name: "Issue scoped remote key" });
    const submit = within(drawer).getByRole("button", { name: "Create key" });
    expect(submit).toBeDisabled();

    await user.type(within(drawer).getByPlaceholderText("Name"), "Named");
    expect(submit).toBeEnabled();
    expect(onCreateKey).not.toHaveBeenCalled();
  });

  it("filters visible accounts and models to match selected providers", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: /Issue key/i }));
    const drawer = screen.getByRole("dialog", { name: "Issue scoped remote key" });

    const accountScope = within(drawer).getByRole("region", { name: "Allowed accounts" });
    expect(within(accountScope).getByText(/acc_1 · claude/)).toBeInTheDocument();
    expect(within(accountScope).getByText(/acc_2 · codex/)).toBeInTheDocument();

    const providers = within(drawer).getByRole("region", { name: "Allowed providers" });
    await user.click(within(providers).getByRole("checkbox", { name: "claude" }));

    expect(within(accountScope).getByText(/acc_1 · claude/)).toBeInTheDocument();
    expect(within(accountScope).queryByText(/acc_2 · codex/)).toBeNull();

    const modelScope = within(drawer).getByRole("region", { name: "Allowed models" });
    expect(within(modelScope).getByText("claude-3-5-sonnet")).toBeInTheDocument();
    expect(within(modelScope).queryByText("gpt-4o")).toBeNull();
  });

  it("opens edit drawer and saves modified scopes and token budget", async () => {
    const user = userEvent.setup();
    const onPatchKey = vi.fn().mockResolvedValue(undefined);
    renderCard({ onPatchKey });

    await user.click(screen.getByRole("button", { name: "Edit Research Partner" }));
    const drawer = screen.getByRole("dialog", { name: "Edit Research Partner" });
    expect(drawer).toBeInTheDocument();

    const nameInput = within(drawer).getByPlaceholderText("Name");
    expect(nameInput).toHaveValue("Research Partner");
    await user.clear(nameInput);
    await user.type(nameInput, "Updated Partner Key");

    await user.click(within(drawer).getByRole("button", { name: "5M" }));

    await user.click(within(drawer).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onPatchKey).toHaveBeenCalledTimes(1));
    expect(onPatchKey).toHaveBeenCalledWith("shk_1", {
      name: "Updated Partner Key",
      allowed_providers: ["claude"],
      allowed_accounts: ["acc_1"],
      allowed_models: ["claude-3-5-sonnet"],
      token_limit: 5_000_000,
    });
  });

  it("closes the issue drawer on Escape", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: /Issue key/i }));
    expect(screen.getByRole("dialog", { name: "Issue scoped remote key" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Issue scoped remote key" })).toBeNull(),
    );
  });

  it("toggles pause state, tops up the limit, and revokes keys", async () => {
    const user = userEvent.setup();
    const onPatchKey = vi.fn().mockResolvedValue(undefined);
    const onDeleteKey = vi.fn().mockResolvedValue(undefined);
    renderCard({ onPatchKey, onDeleteKey });

    await user.click(screen.getByRole("button", { name: "Pause Research Partner" }));
    expect(onPatchKey).toHaveBeenCalledWith("shk_1", { is_active: false });

    await user.click(screen.getByRole("button", { name: "Top up Research Partner" }));
    const topUp = screen.getByRole("dialog", { name: "Top up Research Partner" });
    expect(within(topUp).getByText("250,000 / 1,000,000 tokens used")).toBeInTheDocument();
    await user.click(within(topUp).getByRole("button", { name: "Add quota" }));
    expect(onPatchKey).toHaveBeenCalledWith("shk_1", { token_limit: 1_500_000 });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Top up Research Partner" })).toBeNull(),
    );

    await user.click(screen.getByRole("button", { name: "Revoke Research Partner" }));
    expect(onDeleteKey).toHaveBeenCalledWith("shk_1");
  });

  it("refreshes the key list when a refresh handler is supplied", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    renderCard({ onRefresh });

    await user.click(screen.getByRole("button", { name: "Refresh shared keys" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the issue drawer open with the gateway's reason when creation fails", async () => {
    const user = userEvent.setup();
    const onCreateKey = vi
      .fn()
      .mockRejectedValue(new Error("gateway refused: name already in use"));
    renderCard({ onCreateKey });

    await user.click(screen.getByRole("button", { name: /Issue key/i }));
    const drawer = screen.getByRole("dialog", { name: "Issue scoped remote key" });
    const nameInput = within(drawer).getByPlaceholderText("Name");
    await user.type(nameInput, "Duplicate Key");
    await user.click(within(drawer).getByRole("button", { name: "Create key" }));

    await waitFor(() => expect(onCreateKey).toHaveBeenCalledTimes(1));
    const alert = await within(drawer).findByRole("alert");
    expect(alert).toHaveTextContent("gateway refused: name already in use");
    expect(within(drawer).getByRole("button", { name: "Create key" })).toBeEnabled();
    expect(screen.queryByText(/mq-sh-new/)).toBeNull();

    await user.type(nameInput, "!");
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });

  it("reports a rejected edit without closing the drawer or losing the entered values", async () => {
    const user = userEvent.setup();
    const onPatchKey = vi.fn().mockRejectedValue(new Error("gateway refused: key was revoked"));
    renderCard({ onPatchKey });

    await user.click(screen.getByRole("button", { name: "Edit Research Partner" }));
    const drawer = screen.getByRole("dialog", { name: "Edit Research Partner" });
    const nameInput = within(drawer).getByPlaceholderText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Partner");
    await user.click(within(drawer).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onPatchKey).toHaveBeenCalledTimes(1));
    const alert = await within(drawer).findByRole("alert");
    expect(alert).toHaveTextContent("gateway refused: key was revoked");
    expect(within(drawer).getByPlaceholderText("Name")).toHaveValue("Renamed Partner");
    expect(within(drawer).getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});

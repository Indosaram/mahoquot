import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountsSurface, type AccountsSurfaceProps } from "../components/AccountsSurface";
import { ContextMenu, useContextMenu } from "../components/ContextMenu";
import { DurableLogs } from "../components/DurableLogs";
import { ModalLayer } from "../components/layout";
import { NotchSurface } from "../components/NotchSurface";
import { SharedKeysCard } from "../components/SharedKeysCard";
import { TrayPanel } from "../components/TrayPanel";
import { UiSection } from "../qa/UiSection";
import type { NormalizedAccount } from "../lib/accounts";
import type { HistoryEventsResponse, ScopedApiKey } from "../lib/schemas";

afterEach(cleanup);

const account: NormalizedAccount = {
  id: "codex-1", runtimeId: "codex-1", credentialName: "codex-1.json", disabled: false,
  authIndex: "codex-1.json", provider: "codex", plan: null, email: "one@example.test",
  label: "one@example.test", health: "healthy", healthRaw: "available", cooldownUntilUnixMs: null,
  cooldownRemainingSecs: null, ok: 1, fails: 0, inputTokens: 0, outputTokens: 0,
  totalTokens: 0, failureRate: 0, p50Ms: 0, lastError: null, usage: null,
  quotaCapability: "supported", isCredentialOnly: false, canReset: false,
  resetCreditsAvailable: 0, supportsReset: false, resetCredits: [],
};
const key: ScopedApiKey = {
  id: "key-1", name: "Partner", key_prefix: "mq-sh-test", key_identifier: "test",
  allowed_providers: [], allowed_accounts: [], allowed_models: [], token_limit: 1000,
  token_used: 100, is_active: true, is_exhausted: false, created_at_ms: 1,
  expires_at_ms: null, raw_key: "mq-sh-fake-secret",
};
const inventory: AccountsSurfaceProps = {
  accounts: [], providers: [], visibleAccounts: [], pending: "",
  onSelectProvider: vi.fn(), onRunAccountAction: vi.fn(), onRefresh: vi.fn(),
  onSetCredentialDisabled: vi.fn(), onReauthenticate: vi.fn(), onRemoveCredential: vi.fn(),
  onSetConfirmRemove: vi.fn(), onMoveCredential: vi.fn(), onDropCredential: vi.fn(),
  onSetDragging: vi.fn(), onContextMenu: vi.fn(),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const emptyHistory: HistoryEventsResponse = {
  events: [], "next-cursor": null,
  totals: { requests: 0, "successful-requests": 0, "failed-requests": 0,
    "input-tokens": 0, "output-tokens": 0, "cached-input-tokens": 0,
    "cache-write-tokens": 0, "reasoning-tokens": 0, "total-tokens": 0,
    "estimated-cost-usd": 0 },
};

describe("component accessibility contracts", () => {
  it("enters, traps and restores a named modal opened by keyboard", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button>{open &&
        <ModalLayer aria-labelledby="title" onClose={() => setOpen(false)}>
          <h2 id="title">Editor</h2><input aria-label="Value" /><button onClick={() => setOpen(false)}>Close</button>
        </ModalLayer>}</>;
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    const opener = screen.getByRole("button", { name: "Open" });
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Editor" });
    expect(within(dialog).getByRole("textbox")).toHaveFocus();
    expect(opener.inert).toBe(true);
    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button")).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("textbox")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
    expect(opener.inert).not.toBe(true);
  });

  it("associates all shared-key labels including nested secret and numeric controls", async () => {
    const user = userEvent.setup();
    render(<SharedKeysCard scopedKeys={[key]} availableModels={[]} availableAccounts={[]}
      baseUrl="http://127.0.0.1:18847" onCreateKey={vi.fn()} onPatchKey={vi.fn()} onDeleteKey={vi.fn()} />);
    for (const [opener, labels] of [
      ["Issue key", ["Key name", "Custom limit"]],
      ["Top up Partner", ["Add tokens"]],
      ["Edit Partner", ["Key name", "API Key value", "Custom limit"]],
    ] as const) {
      await user.click(screen.getByRole("button", { name: opener }));
      const dialog = screen.getByRole("dialog");
      for (const label of labels) {
        const input = within(dialog).getByLabelText(label);
        expect(input).toHaveAccessibleName(label);
        const hint = input.getAttribute("aria-describedby");
        expect(hint && document.getElementById(hint)).toBeTruthy();
        await user.click(within(dialog).getByText(label, { selector: "label" }));
        expect(input).toHaveFocus();
      }
      if (opener === "Top up Partner") expect(within(dialog).getByRole("spinbutton", { name: "Add tokens" })).toBeTruthy();
      await user.keyboard("{Escape}");
    }
  });

  it("associates the QA field label and hint", async () => {
    const user = userEvent.setup();
    render(<UiSection />);
    const input = screen.getByRole("textbox", { name: "Cluster Name" });
    await user.click(screen.getByText("Cluster Name", { selector: "label" }));
    expect(input).toHaveFocus();
    expect(document.getElementById(input.getAttribute("aria-describedby")!)).toBeTruthy();
  });

  it("names equal-quota providers uniquely and dismisses associated tooltips", async () => {
    const user = userEvent.setup();
    render(<NotchSurface accounts={[account, { ...account, id: "claude-1", provider: "claude" }]}
      loadState="online" showRemaining notchExpanded nativeCursor={null} />);
    const codex = screen.getByRole("button", { name: "Codex no quota data" });
    const claude = screen.getByRole("button", { name: "Claude no quota data" });
    await user.tab();
    expect(codex).toHaveFocus();
    expect(document.getElementById(codex.getAttribute("aria-describedby")!)).toHaveAttribute("aria-hidden", "false");
    await user.keyboard("{Escape}");
    expect(codex).not.toHaveAttribute("aria-describedby");
    await user.tab();
    expect(claude).toHaveFocus();
    expect(codex).not.toHaveAttribute("aria-describedby");
  });

  it("keyboard-opens provider actions and supports navigation, activation and restoration", async () => {
    const models = vi.fn();
    function Harness() {
      const { menu, openMenu, closeMenu } = useContextMenu();
      return <><AccountsSurface {...inventory} accounts={[account]} providers={["codex"]}
        selectedProvider="codex" onProviderContextMenu={(event) => openMenu(event, [
          { label: "Refresh", run: vi.fn() }, { label: "Models", run: models },
        ])} /><ContextMenu menu={menu} onClose={closeMenu} /></>;
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    const opener = screen.getByRole("radio");
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menuitem", { name: "Refresh" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Models" })).toHaveFocus();
    await user.keyboard("{Home}{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Models" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(models).toHaveBeenCalledTimes(1);
    expect(opener).toHaveFocus();
    await user.keyboard("{Shift>}{F10}{/Shift}{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("distinguishes inventory pending, unavailable, empty and retained data", () => {
    const view = render(<AccountsSurface {...inventory} inventoryState="loading" />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    view.rerender(<AccountsSurface {...inventory} inventoryState="error" />);
    expect(screen.getByRole("status")).toHaveAttribute("data-inventory-state", "error");
    view.rerender(<AccountsSurface {...inventory} inventoryState="ready" />);
    expect(screen.getByRole("status")).toHaveAttribute("data-inventory-state", "ready");
    view.rerender(<AccountsSurface {...inventory} accounts={[account]} visibleAccounts={[account]} inventoryState="loading" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(account.email!)).toBeTruthy();
  });

  it("settles deferred history without false initial empty and recovers from failure", async () => {
    const first = deferred<HistoryEventsResponse>();
    const second = deferred<HistoryEventsResponse>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<DurableLogs records={[]} loadHistory={load} />);
    expect(screen.getByRole("region", { name: "Request history" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("region", { name: "Request totals" })).toBeNull();
    await act(async () => { first.reject(new Error("fixture-unavailable")); await first.promise.catch(() => undefined); });
    expect(screen.getByText("fixture-unavailable")).toBeTruthy();
    view.rerender(<DurableLogs records={[]} loadHistory={load} liveTick={1} />);
    await act(async () => { second.resolve(emptyHistory); await second.promise; });
    expect(screen.queryByText("fixture-unavailable")).toBeNull();
    expect(screen.getByRole("region", { name: "Request history" })).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("region", { name: "Request totals" })).toBeTruthy();
  });

  it("uses exclusive log tabs and reports proxy failure only inline", () => {
    const view = render(<DurableLogs records={[]} logsError="proxy-fixture-failure" />);
    const proxy = screen.getByRole("tab", { name: "Proxy Logs" });
    fireEvent.click(proxy);
    expect(proxy).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("log")).getByText("proxy-fixture-failure")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(<DurableLogs records={[]} />);
    expect(screen.queryByText("proxy-fixture-failure")).toBeNull();
  });

  it("exposes mutually exclusive tray filters", async () => {
    const user = userEvent.setup();
    render(<TrayPanel accounts={[account]} proxyUrl="http://127.0.0.1:18847" online
      gatewayLifecycle="running" fetchedAgoSecs={0} refreshing={false} showRemaining
      onRefresh={vi.fn()} onOpenConsole={vi.fn()} onQuit={vi.fn()} onStartGateway={vi.fn()} onStopGateway={vi.fn()} />);
    const group = within(screen.getByRole("tablist", { name: "Provider filter" }));
    expect(group.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
    await user.click(group.getByRole("tab", { name: "Codex" }));
    expect(group.getByRole("tab", { name: "Codex" })).toHaveAttribute("aria-selected", "true");
    expect(group.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "false");
  });
});

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as native from "../lib/native";

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;
const file = (name: string, provider = "codex") => ({
  name: `${name}.json`,
  label: `${name}@example.test`,
  email: `${name}@example.test`,
  type: provider,
});
const files = [file("a"), file("b"), file("c"), file("d")];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const gateway = (route?: Route, inventory = files) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      const routed = route?.(url, init);
      if (routed) return routed;
      if (url.pathname === "/admin/stats") return Response.json({ accounts: [], history: [] });
      if (url.pathname.endsWith("/auth-files")) return Response.json({ files: inventory });
      if (url.pathname.endsWith("/warmup/settings"))
        return Response.json({ accounts: {}, providers: {} });
      if (url.pathname.endsWith("/warmup/status")) return Response.json({ accounts: {} });
      if (url.pathname.endsWith("/logs")) return Response.json({ records: [] });
      return Response.json({ ok: true });
    }),
  );
};
const mount = async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<App />);
  });
  return view;
};
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};
const accountOrder = () =>
  [...document.querySelectorAll(".account-id strong")].map((element) => element.textContent);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("mahoquot.base", "http://127.0.0.1:18841");
  window.history.replaceState({}, "", "/?surface=accounts");
  vi.spyOn(native, "migrateLegacyDesktopSecret").mockResolvedValue({
    value: "",
    remove_legacy: false,
    reconnect: false,
  });
  vi.spyOn(native, "readDesktopSecret").mockResolvedValue(null);
  vi.spyOn(native, "openExternalUrl").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("FE1 behavior-preserving App optimizations", () => {
  it.each([
    { saved: ["b.json", "a.json", "b.json"], expected: ["c", "d", "b", "a"] },
    { saved: [], expected: ["b", "a", "c", "d"] },
  ])(
    "preserves first duplicate, missing-name, stable-sort and empty-ack ranks: $saved",
    async ({ saved, expected }) => {
      const bodies: string[] = [];
      gateway((url, init) => {
        if (url.pathname.endsWith("/auth-files/order") && init?.method === "PUT") {
          bodies.push(String(init.body));
          return Response.json({ names: saved });
        }
      });
      await mount();
      expect(accountOrder()).toEqual(["a", "b", "c", "d"].map((name) => `${name}@example.test`));
      await act(async () => {
        fireEvent.keyDown(screen.getByRole("button", { name: "Reorder a@example.test" }), {
          key: "ArrowDown",
        });
      });
      expect(bodies).toEqual([JSON.stringify({ names: ["b.json", "a.json", "c.json", "d.json"] })]);
      expect(accountOrder()).toEqual(expected.map((name) => `${name}@example.test`));
    },
  );

  it("preserves provider badge counts through search and account replacement", async () => {
    let inventory = [file("a"), file("b"), file("c", "claude")];
    gateway((url) =>
      url.pathname.endsWith("/auth-files") ? Response.json({ files: inventory }) : undefined,
    );
    await mount();
    await click("Add account");
    await click("Coding plan");
    const count = (name: string) =>
      screen.getByRole("button", { name }).querySelector(".provider-option-count")?.textContent;
    expect(count("Codex")).toBe("2");
    expect(count("Claude")).toBe("1");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search providers"), { target: { value: "Codex" } });
    });
    expect(count("Codex")).toBe("2");
    await click("Close onboarding");
    inventory = [file("a")];
    await click("Refresh snapshot");
    await click("Add account");
    await click("Coding plan");
    expect(count("Codex")).toBe("1");
    expect(count("Claude")).toBeUndefined();
  });

  it("still reorders Claude subscriptions at a reset boundary on an unrelated render", async () => {
    let now = 10_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    gateway(
      (url) =>
        url.pathname === "/admin/stats"
          ? Response.json({
              accounts: [
                {
                  id: "a@example.test",
                  provider: "claude",
                  usage: { secondary: { used_percent: 0, reset_at_unix: 10_001 } },
                },
                {
                  id: "b@example.test",
                  provider: "claude",
                  usage: { secondary: { used_percent: 0, reset_at_unix: 10_100 } },
                },
              ],
              history: [],
            })
          : undefined,
      [file("a", "claude"), file("b", "claude")],
    );
    await mount();
    expect(accountOrder()).toEqual(["a@example.test", "b@example.test"]);
    now = 10_002_000;
    await click("Add account");
    expect(accountOrder()).toEqual(["b@example.test", "a@example.test"]);
  });

  it("applies overlapping terminal outcomes once across successive sessions", async () => {
    vi.useFakeTimers();
    const interval = vi.spyOn(window, "setInterval");
    let starts = 0;
    let statusReads = 0;
    let usageRefreshes = 0;
    let firstRead = deferred<Response>();
    let secondRead = deferred<Response>();
    let secondStarted = deferred<void>();
    gateway((url) => {
      if (url.pathname.endsWith("/usage/refresh")) {
        usageRefreshes += 1;
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/codex-auth-url"))
        return Response.json({
          url: "http://127.0.0.1:18844/approve",
          state: `state-${++starts}`,
        });
      if (url.pathname.endsWith("/get-auth-status")) {
        statusReads += 1;
        if (statusReads % 2 === 1) return firstRead.promise;
        secondStarted.resolve();
        return secondRead.promise;
      }
    });
    await mount();
    for (const attempt of [1, 2]) {
      await click("Add account");
      await click("Coding plan");
      await click("Codex");
      await click("Sign in with OpenAI");
      await click("Check authorization status");
      const registration = interval.mock.calls.filter(([, timeout]) => timeout === 3000).at(-1);
      const poll = registration?.[0];
      if (typeof poll !== "function") throw new Error("authorization poller was not registered");
      const pollComplete = deferred<void>();
      act(() => {
        void Promise.resolve(poll()).then(() => pollComplete.resolve());
      });
      await secondStarted.promise;
      expect(statusReads).toBe(attempt * 2);
      await act(async () => {
        firstRead.resolve(Response.json({ status: "ok", provider: "codex" }));
        await firstRead.promise;
      });
      await act(async () => {
        secondRead.resolve(Response.json({ status: "ok", provider: "codex" }));
        await secondRead.promise;
        await pollComplete.promise;
      });
      expect(screen.queryByRole("dialog", { name: "Add Account" })).toBeNull();
      expect(screen.getAllByText(/authorization completed/)).toHaveLength(1);
      expect(usageRefreshes).toBe(attempt);
      firstRead = deferred<Response>();
      secondRead = deferred<Response>();
      secondStarted = deferred<void>();
    }
  });
});

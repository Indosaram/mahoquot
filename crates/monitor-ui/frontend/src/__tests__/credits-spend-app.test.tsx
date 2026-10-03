import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../App";

interface FetchOptions {
  readonly statsAccounts: readonly unknown[];
  readonly creditIds: readonly string[];
  /** null makes the policy GET fail, simulating a gateway without the endpoint. */
  readonly creditIdsOrFail: readonly string[] | null;
  readonly onPut?: (body: Record<string, unknown>) => Promise<Response>;
}

interface RecordedPut {
  readonly body: Record<string, unknown>;
}

/**
 * Routes every gateway call App makes. Unknown endpoints answer `{ok:true}`
 * (the same shape the existing app suite relies on), so no test can reach a
 * real network path.
 */
const installFetch = (options: FetchOptions): { readonly puts: RecordedPut[] } => {
  const puts: RecordedPut[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
      if (url.includes("/v0/management/accounts/credits")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          puts.push({ body });
          if (options.onPut) return await options.onPut(body);
          return json({
            ok: true,
            id: body.id,
            credits_after_limit: body.credits_after_limit,
            creditsAfterLimit: body.credits_after_limit,
            all: body.all,
            ids: body.all === true ? options.creditIds : [],
          });
        }
        if (options.creditIdsOrFail === null) {
          return new Response("not found", { status: 404 });
        }
        return json({ ids: [...options.creditIdsOrFail] });
      }
      if (url.includes("/admin/stats")) {
        return json({
          uptime_secs: 10,
          in_flight: 0,
          served: 5,
          failed_over: 0,
          refreshed: 1,
          ttft: { p50_ms: 1, p90_ms: 2, p99_ms: 3, samples: 5 },
          accounts: options.statsAccounts,
        });
      }
      if (url.includes("auth-files")) return json({ files: [] });
      if (url.includes("/logs")) {
        return json({ records: [], "request-count": 0, "proxy-count": 0 });
      }
      if (url.includes("config.yaml")) {
        return new Response("port: 18801\n", {
          headers: { "Content-Type": "application/yaml" },
        });
      }
      return json({ ok: true });
    }),
  );
  return { puts };
};

const codexStats = (
  overrides?: Partial<Record<string, unknown>>,
): readonly unknown[] => [
  {
    id: "zero@example.com",
    provider: "codex",
    health: { status: "available" },
    ok: 5,
    fails: 0,
    usage: {
      plan_type: "Pro",
      credits_balance: 0,
      has_credits: true,
      totals: { requests: 8, tokens: 1500, total_cost_usd: 1.25 },
    },
    ...overrides,
  },
  {
    id: "unknown@example.com",
    provider: "codex",
    health: { status: "available" },
    ok: 3,
    fails: 0,
    usage: {
      plan_type: "Pro",
      credits_balance: null,
      has_credits: false,
      totals: { requests: 3, tokens: 400, total_cost_usd: 0.5 },
    },
    ...overrides,
  },
];

const openAccounts = async () => {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
};

const accountSwitch = (id: string) => {
  const existing = screen.queryByRole("menuitemcheckbox", { name: `Use credits after limit for ${id}` });
  if (existing) return existing;
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${id}` }));
  return screen.getByRole("menuitemcheckbox", { name: `Use credits after limit for ${id}` });
};

describe("codex credit policy in the operations console", () => {
  it("defaults every control off when no account opted in", async () => {
    installFetch({ statsAccounts: codexStats(), creditIds: [], creditIdsOrFail: [] });
    await openAccounts();

    expect(screen.queryByTestId("global-credits-toggle")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(accountSwitch("zero@example.com")).toHaveAttribute("aria-checked", "false");
      expect(accountSwitch("unknown@example.com")).toHaveAttribute("aria-checked", "false");
    });
  });

  it("shows a measured zero as zero credits and an unreported balance as unknown", async () => {
    installFetch({ statsAccounts: codexStats(), creditIds: [], creditIdsOrFail: [] });
    await openAccounts();

    const values = await screen.findAllByTestId("account-credit-value");
    expect(values).toHaveLength(2);
    expect(values[0]).toHaveTextContent("0 credits");
    expect(values[1]).toHaveTextContent("Unknown");
    for (const value of values) {
      expect(value.textContent ?? "").not.toContain("$");
      expect(value.textContent ?? "").not.toContain("Unknown0");
    }
    expect(values[1]?.textContent).not.toContain("0 credits");
  });

  it("reads each account flag independently", async () => {
    installFetch({
      statsAccounts: codexStats(),
      creditIds: ["zero@example.com"],
      creditIdsOrFail: ["zero@example.com"],
    });
    await openAccounts();

    expect(screen.queryByTestId("global-credits-toggle")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(accountSwitch("zero@example.com")).toHaveAttribute("aria-checked", "true");
      expect(accountSwitch("unknown@example.com")).toHaveAttribute("aria-checked", "false");
    });
  });

  it("keeps the prior toggle and shows the error when the write fails", async () => {
    const { puts } = installFetch({
      statsAccounts: codexStats(),
      creditIds: ["zero@example.com"],
      creditIdsOrFail: ["zero@example.com"],
      onPut: async () =>
        new Response(
          JSON.stringify({ error: { code: "settings_save_failed", message: "disk full" } }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
    });
    await openAccounts();

    const toggle = await waitFor(() => accountSwitch("zero@example.com"));
    await waitFor(() => expect(accountSwitch("zero@example.com")).toHaveAttribute("aria-checked", "true"));

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(await screen.findByText("Action failed: disk full")).toBeInTheDocument();
    expect(puts).toEqual([{ body: { id: "zero@example.com", credits_after_limit: false } }]);
    expect(accountSwitch("zero@example.com")).toHaveAttribute("aria-checked", "true");
    expect(accountSwitch("zero@example.com")).not.toHaveAttribute("aria-busy");
    expect(screen.queryByText(/Credits after limit (on|off)/)).not.toBeInTheDocument();
  });

  it("holds the switch until the gateway acks, then commits success", async () => {
    let release: ((response: Response) => void) | undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    installFetch({
      statsAccounts: codexStats(),
      creditIds: ["zero@example.com"],
      creditIdsOrFail: ["zero@example.com"],
      onPut: () => gate,
    });
    await openAccounts();

    const toggle = await waitFor(() => accountSwitch("zero@example.com"));
    await waitFor(() => expect(accountSwitch("zero@example.com")).toHaveAttribute("aria-checked", "true"));

    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      expect(accountSwitch("zero@example.com")).toHaveAttribute("aria-busy", "true");
      expect(accountSwitch("zero@example.com")).toBeDisabled();
    });
    // No success surface while the mutation is still in flight.
    expect(screen.queryByText(/Credits after limit (on|off)/)).not.toBeInTheDocument();
    expect(accountSwitch("zero@example.com")).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      release?.(
        new Response(
          JSON.stringify({
            ok: true,
            id: "zero@example.com",
            credits_after_limit: false,
            creditsAfterLimit: false,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
      await gate;
    });

    await waitFor(() => expect(accountSwitch("zero@example.com")).toHaveAttribute("aria-checked", "false"));
    expect(accountSwitch("zero@example.com")).not.toHaveAttribute("aria-busy");
    expect(
      await screen.findByText("Credits after limit off for zero@example.com."),
    ).toBeInTheDocument();
  });

  it("renders no credit controls when the gateway does not expose the policy", async () => {
    installFetch({ statsAccounts: codexStats(), creditIds: [], creditIdsOrFail: null });
    await openAccounts();

    await waitFor(() => {
      expect(screen.getAllByTestId("account-usage-totals")).toHaveLength(2);
    });
    expect(screen.queryByTestId("global-credits-toggle")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: /Use credits after limit/ })).not.toBeInTheDocument();
  });

  it("keeps the acked value while a pre-ack stats snapshot still claims the old flag", async () => {
    installFetch({
      statsAccounts: [
        {
          id: "zero@example.com",
          provider: "codex",
          health: { status: "available" },
          ok: 5,
          fails: 0,
          credits_after_limit: true,
          usage: { plan_type: "Pro", credits_balance: 5, has_credits: true },
        },
        {
          id: "unknown@example.com",
          provider: "codex",
          health: { status: "available" },
          ok: 3,
          fails: 0,
          credits_after_limit: false,
          usage: { plan_type: "Pro", credits_balance: null, has_credits: false },
        },
      ],
      creditIds: ["zero@example.com"],
      creditIdsOrFail: ["zero@example.com"],
    });
    await openAccounts();

    const toggle = await waitFor(() => accountSwitch("zero@example.com"));
    await waitFor(() => expect(accountSwitch("zero@example.com")).toHaveAttribute("aria-checked", "true"));

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(
      await screen.findByText("Credits after limit off for zero@example.com."),
    ).toBeInTheDocument();
    expect(accountSwitch("zero@example.com")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("global-credits-toggle")).not.toBeInTheDocument();
  });
});

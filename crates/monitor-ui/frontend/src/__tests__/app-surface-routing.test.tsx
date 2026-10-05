import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";

const stats = {
  uptime_secs: 3600,
  in_flight: 0,
  served: 0,
  failed_over: 0,
  refreshed: 0,
  ttft: null,
  accounts: [],
};

describe("initial surface routing", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...stats, files: [] }))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem("mahoquot.theme");
    document.documentElement.removeAttribute("data-theme");
    window.history.pushState({}, "", "/");
  });

  it("lands the ?surface=agents deep link on the Settings page that renders the agents section", async () => {
    window.history.pushState({}, "", "/management.html?surface=agents");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Gateway URL")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "CLI agents" })).toBeInTheDocument();
  });

  it("pins the notch window to dark so its hard-coded tooltip colours stay readable", async () => {
    localStorage.setItem("mahoquot.theme", "light");
    window.history.pushState({}, "", "/management.html?surface=notch");
    const { container } = render(<App />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(container.querySelector(".notch-surface")).toBeInTheDocument();
  });
});

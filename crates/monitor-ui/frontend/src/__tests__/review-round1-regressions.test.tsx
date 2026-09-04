import App from "@/App";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// V12 (F-front-app-state-1): the migration writes API-key state, so one run
// per keystroke clobbers what the operator is typing into the key field.
const installTauriMock = (onMigrate: () => void) => {
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke: vi.fn(async (command: string) => {
        if (command === "gateway_status") return "running";
        if (command === "migrate_legacy_secret") {
          onMigrate();
          return { value: "test-relay-key", remove_legacy: false };
        }
        if (command === "read_secret") return { value: null };
        if (command === "tunnel_status") {
          return {
            installed: false,
            enabled: false,
            running: false,
            public_url: null,
            error: null,
          };
        }
        if (command === "list_codex_instances") return [];
        if (command === "native_settings_state") {
          return {
            login_start_enabled: false,
            notifications: "available",
            action: null,
            gateway_running: true,
            notch: "compact",
          };
        }
        return null;
      }),
    },
  });
};

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("review round 1 regressions", () => {
  it("does not re-run the legacy secret migration on every Gateway URL keystroke", async () => {
    let migrations = 0;
    installTauriMock(() => {
      migrations += 1;
    });

    render(<App />);
    const settingsNav = (await screen.findAllByText("Settings")).at(0);
    if (!settingsNav) throw new Error("Settings navigation missing");
    fireEvent.click(settingsNav);

    const urlInput = await screen.findByLabelText("Gateway URL");
    await waitFor(() => expect(migrations).toBeGreaterThan(0));
    const afterMount = migrations;

    for (const value of [
      "http://127.0.0.1:1880",
      "http://127.0.0.1:18801",
      "http://127.0.0.1:18801/",
    ]) {
      fireEvent.change(urlInput, { target: { value } });
    }
    await waitFor(() => expect(urlInput).toHaveValue("http://127.0.0.1:18801/"));

    expect(
      migrations - afterMount,
      "migration re-ran while the operator was still typing",
    ).toBe(0);
  });

  it("reports entrance completion from every cartesian canvas painter", async () => {
    // The DOM-marker gate (dot.tsx reads ctx.entranceDone) only opens when a
    // canvas painter calls markEntranceDone. jsdom never makes these canvases
    // "ready", so the RAF body is unreachable in a render test; assert the
    // contract on the painters themselves instead.
    const painters = ["cartesian-canvas.tsx", "bar-canvas.tsx"];
    const missing: string[] = [];
    for (const painter of painters) {
      const source = await import(
        /* @vite-ignore */ `../components/dither-kit/${painter}?raw`
      ).then((mod: { default: string }) => mod.default);
      if (!source.includes("markEntranceDone()")) missing.push(painter);
    }
    expect(missing, "canvas painters that never open the entrance gate").toEqual([]);
  });
});

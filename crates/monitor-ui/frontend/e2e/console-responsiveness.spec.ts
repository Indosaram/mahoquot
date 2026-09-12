import { expect, test } from "@playwright/test";

// Exercise the actual single-file artifact (run with --browser=chromium or
// --browser=webkit). Native event-loop hangs are covered by native_event_loop.rs.
for (const pendingNative of [false, true]) {
  test(`navigation stays responsive with gateway offline and native IPC ${pendingNative ? "pending" : "absent"}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((pending) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("mahoquot.base", "http://127.0.0.1:9");
      if (pending) {
        class NativeWindow {
          label = "main";
          async listen(_event: string, _handler: (event: { payload: boolean }) => void) {
            if (this.label !== "main") throw new Error("wrong native window receiver");
            return () => {};
          }
          async onFocusChanged(handler: (event: { payload: boolean }) => void) {
            const focus = await this.listen("tauri://focus", handler);
            const blur = await this.listen("tauri://blur", handler);
            return () => { focus(); blur(); };
          }
        }
        Object.defineProperty(window, "__TAURI__", {
          value: { window: { getCurrentWindow: () => new NativeWindow() } },
        });
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          value: { invoke: () => new Promise(() => {}) },
        });
      }
    }, pendingNative);
    await page.route("**/admin/**", (route) => route.abort("connectionrefused"));
    await page.route("**/v0/**", (route) => route.abort("connectionrefused"));
    await page.route("**/v1/**", (route) => route.abort("connectionrefused"));
    await page.goto("/management.html");

    for (const surface of ["Overview", "Accounts", "Logs", "Settings", "Accounts"]) {
      await page.getByRole("button", { name: surface, exact: true }).click();
      await expect(page.getByRole("heading", { name: surface, exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "Add account", exact: true }).click();
    await expect(page.getByRole("button", { name: "Coding plan", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Coding plan", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

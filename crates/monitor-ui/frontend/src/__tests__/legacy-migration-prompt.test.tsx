import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyMigrationPrompt } from "../components/LegacyMigrationPrompt";
import type { LegacyMigrationStatus } from "../lib/native";

const status = vi.fn<() => Promise<LegacyMigrationStatus | null>>();
const resolve = vi.fn<(importAccounts: boolean) => Promise<"running" | "stopped">>();

vi.mock("../lib/native", () => ({
  getLegacyMigrationStatus: () => status(),
  resolveLegacyMigration: (importAccounts: boolean) => resolve(importAccounts),
}));

const pendingStatus = (count: number): LegacyMigrationStatus => ({
  importable_count: count,
  legacy_dir: "/home/u/.cli-proxy-api",
  app_dir: "/home/u/.mahoquot/auth",
});

describe("LegacyMigrationPrompt", () => {
  beforeEach(() => {
    status.mockReset();
    resolve.mockReset();
    resolve.mockResolvedValue("running");
  });

  it("stays out of the way when there is nothing to migrate", async () => {
    status.mockResolvedValue(null);
    render(<LegacyMigrationPrompt />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(screen.queryByTestId("legacy-migration-prompt")).not.toBeInTheDocument();
  });

  it("offers the choice with the discovered credential count", async () => {
    status.mockResolvedValue(pendingStatus(9));
    render(<LegacyMigrationPrompt />);
    expect(await screen.findByTestId("legacy-migration-prompt")).toBeInTheDocument();
    expect(screen.getByText(/9 credential files/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import accounts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep legacy folder" })).toBeInTheDocument();
  });

  it("uses the singular when one credential was found", async () => {
    status.mockResolvedValue(pendingStatus(1));
    render(<LegacyMigrationPrompt />);
    expect(await screen.findByText(/1 credential file /)).toBeInTheDocument();
  });

  it("imports and disappears once the gateway comes up", async () => {
    status.mockResolvedValue(pendingStatus(9));
    render(<LegacyMigrationPrompt />);
    fireEvent.click(await screen.findByRole("button", { name: "Import accounts" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(screen.queryByTestId("legacy-migration-prompt")).not.toBeInTheDocument(),
    );
  });

  it("passes a decline through without importing", async () => {
    status.mockResolvedValue(pendingStatus(9));
    render(<LegacyMigrationPrompt />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep legacy folder" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(false));
  });
});

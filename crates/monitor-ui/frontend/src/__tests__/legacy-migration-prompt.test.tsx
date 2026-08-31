import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyMigrationDialog } from "../components/LegacyMigrationPrompt";
import type { LegacyMigrationStatus } from "../lib/native";

const status = vi.fn<() => Promise<LegacyMigrationStatus | null>>();
const resolve = vi.fn<(importAccounts: boolean) => Promise<string>>();

vi.mock("../lib/native", () => ({
  getLegacyMigrationStatus: () => status(),
  resolveLegacyMigration: (importAccounts: boolean) => resolve(importAccounts),
}));

const pendingStatus = (count: number): LegacyMigrationStatus => ({
  importable_count: count,
  legacy_dir: "/home/u/.cli-proxy-api",
  app_dir: "/home/u/.mahoquot/auth",
});

describe("LegacyMigrationDialog", () => {
  beforeEach(() => {
    status.mockReset();
    resolve.mockReset();
    resolve.mockResolvedValue("/home/u/.mahoquot/auth");
  });

  it("renders nothing while closed or when nothing is pending", async () => {
    status.mockResolvedValue(null);
    const onResolved = vi.fn();
    const { rerender } = render(<LegacyMigrationDialog open onResolved={onResolved} />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(screen.queryByTestId("legacy-migration-dialog")).not.toBeInTheDocument();

    rerender(<LegacyMigrationDialog open={false} onResolved={onResolved} />);
    status.mockResolvedValue(pendingStatus(9));
    rerender(<LegacyMigrationDialog open onResolved={onResolved} />);
    await waitFor(() => expect(screen.queryByTestId("legacy-migration-dialog")).not.toBeNull());
    expect(screen.queryByTestId("legacy-migration-dialog")).toBeInTheDocument();
  });

  it("offers the choice with the discovered credential count", async () => {
    status.mockResolvedValue(pendingStatus(9));
    render(<LegacyMigrationDialog open onResolved={vi.fn()} />);
    expect(await screen.findByTestId("legacy-migration-dialog")).toBeInTheDocument();
    expect(screen.getByText(/9 credential files/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import accounts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep legacy folder" })).toBeInTheDocument();
  });

  it("uses the singular when one credential was found", async () => {
    status.mockResolvedValue(pendingStatus(1));
    render(<LegacyMigrationDialog open onResolved={vi.fn()} />);
    expect(await screen.findByText(/1 credential file /)).toBeInTheDocument();
  });

  it("imports and hands control back", async () => {
    status.mockResolvedValue(pendingStatus(9));
    const onResolved = vi.fn();
    render(<LegacyMigrationDialog open onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole("button", { name: "Import accounts" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(true));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  it("passes a decline through without importing", async () => {
    status.mockResolvedValue(pendingStatus(9));
    const onResolved = vi.fn();
    render(<LegacyMigrationDialog open onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep legacy folder" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(false));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });
});

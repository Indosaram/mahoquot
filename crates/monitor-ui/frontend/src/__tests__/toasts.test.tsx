import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastStack, toastTone, useToasts } from "../components/Toasts";

const Harness = ({ messages }: { readonly messages: readonly string[] }) => {
  const { toasts, pushToast, dismissToast } = useToasts();
  return (
    <div>
      <button type="button" onClick={() => messages.forEach(pushToast)}>
        push
      </button>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("toast stack", () => {
  it("classifies failure messages as errors and everything else as info", () => {
    expect(toastTone("Action failed: network down")).toBe("error");
    expect(toastTone("Proxy settings saved and applied.")).toBe("info");
  });

  it("renders pushed messages in a polite live region", () => {
    render(<Harness messages={["Credential removed from the runtime pool."]} />);
    fireEvent.click(screen.getByRole("button", { name: "push" }));

    const region = screen.getByRole("status");
    expect(region).toHaveClass("toast-stack");
    expect(screen.getByText("Credential removed from the runtime pool.")).toBeInTheDocument();
  });

  it("auto-dismisses info toasts after 4.5 seconds", () => {
    render(<Harness messages={["API key copied."]} />);
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    expect(screen.getByText("API key copied.")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(4_499));
    expect(screen.getByText("API key copied.")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("API key copied.")).not.toBeInTheDocument();
  });

  it("keeps error toasts longer than info toasts", () => {
    render(<Harness messages={["Action failed: gateway unreachable"]} />);
    fireEvent.click(screen.getByRole("button", { name: "push" }));

    act(() => vi.advanceTimersByTime(4_500));
    expect(screen.getByText("Action failed: gateway unreachable")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(3_500));
    expect(screen.queryByText("Action failed: gateway unreachable")).not.toBeInTheDocument();
  });

  it("dismisses a toast when clicked", () => {
    render(<Harness messages={["Account order saved."]} />);
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    fireEvent.click(screen.getByText("Account order saved."));
    expect(screen.queryByText("Account order saved.")).not.toBeInTheDocument();
  });

  it("caps the stack at the newest four toasts", () => {
    render(<Harness messages={["one", "two", "three", "four", "five", "Action failed: six"]} />);
    fireEvent.click(screen.getByRole("button", { name: "push" }));

    expect(screen.queryByText("one")).not.toBeInTheDocument();
    expect(screen.queryByText("two")).not.toBeInTheDocument();
    for (const message of ["three", "four", "five", "Action failed: six"]) {
      expect(screen.getByText(message)).toBeInTheDocument();
    }
  });

  it("ignores empty messages", () => {
    render(<Harness messages={[""]} />);
    fireEvent.click(screen.getByRole("button", { name: "push" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

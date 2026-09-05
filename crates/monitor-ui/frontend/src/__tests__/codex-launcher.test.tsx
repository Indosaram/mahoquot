import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodexInstancesCard } from "../components/CodexInstancesCard";

describe("Codex multi-instance launcher", () => {
  it("launches explicit account model and reasoning selections and stops instances", async () => {
    const onLaunchCodex = vi.fn().mockResolvedValue(undefined);
    const onStopCodex = vi.fn().mockResolvedValue(undefined);
    render(
      <CodexInstancesCard
        accounts={[
          { id: "codex-a", label: "a@example.com" },
          { id: "codex-b", label: "b@example.com" },
        ]}
        instances={[
          {
            instance_id: "existing",
            account_id: "codex-b",
            pid: 42,
            codex_home: "/isolated/existing",
            state: "running",
          },
        ]}
        busy={false}
        onLaunch={onLaunchCodex}
        onStop={onStopCodex}
      />,
    );

    expect(screen.getByText("Codex instances")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Codex account"), { target: { value: "codex-a" } });
    fireEvent.change(screen.getByLabelText("Codex model"), {
      target: { value: "gpt-5.6-codex" },
    });
    fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch Codex instance" }));
    expect(onLaunchCodex).toHaveBeenCalledWith({
      account_id: "codex-a",
      model: "gpt-5.6-codex",
      reasoning_effort: "high",
      instance_id: expect.stringMatching(
        /^codex-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop existing" }));
    expect(onStopCodex).toHaveBeenCalledWith("existing");
    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    expect(screen.queryByText("b@example.com")).not.toBeInTheDocument();
  });
});

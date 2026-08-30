import type React from "react";
import { Badge, Button, Card, Field, Input } from "../components/ui";
import { LONG_LABEL_40, UNBROKEN_TOKEN_256 } from "./constants";

export const StateMatrixSection: React.FC = () => {
  return (
    <section className="mb-10" data-testid="section-state-matrix">
      <h2 className="text-lg font-semibold mb-4 text-[var(--fg)]">3. Explicit State Matrix</h2>
      <div className="space-y-4">
        {/* Default */}
        <Card
          data-testid="state-default"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)]"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mb-1">State: default</div>
          <div className="flex items-center gap-3">
            <Button>Standard Button</Button>
            <Input placeholder="Standard Input" defaultValue="Nominal text" />
            <Badge tone="ok">Available</Badge>
          </div>
        </Card>

        {/* Empty */}
        <Card
          data-testid="state-empty"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)] text-center py-6"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mb-1">State: empty</div>
          <p className="text-sm text-[var(--fg-dim)]">No records discovered in this partition.</p>
          <div className="mt-2">
            <Badge tone="neutral">0 items</Badge>
          </div>
        </Card>

        {/* 40+ Char Label */}
        <Card
          data-testid="state-long-label"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)]"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mb-1">State: 40+ char label</div>
          <Field label={LONG_LABEL_40} hint="Long configuration key label stress test">
            <Input defaultValue={LONG_LABEL_40} />
          </Field>
        </Card>

        {/* 256-Char Unbroken Token */}
        <Card
          data-testid="state-unbroken-token"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)] overflow-hidden"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mb-1">
            State: 256-char unbroken token
          </div>
          <div className="p-2 bg-[var(--panel-2)] rounded font-mono text-xs break-all text-[var(--accent)]">
            {UNBROKEN_TOKEN_256}
          </div>
        </Card>

        {/* Disabled */}
        <Card
          data-testid="state-disabled"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)]"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mb-1">State: disabled</div>
          <div className="flex items-center gap-3">
            <Button disabled>Disabled Action</Button>
            <Input disabled defaultValue="Locked value" />
            <Badge tone="neutral">Disabled</Badge>
          </div>
        </Card>

        {/* Hover Target */}
        <Card
          data-testid="state-hover-target"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)]"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mb-1">State: hover-target</div>
          <Button
            className="hover:bg-[var(--panel-3)] transition-colors"
            data-testid="hover-target-button"
          >
            Hover Me Target
          </Button>
        </Card>

        {/* Focus Visible Target */}
        <Card
          data-testid="state-focus-target"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)]"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mb-1">
            State: focus-visible target
          </div>
          <div className="flex gap-3">
            <Button data-testid="focus-target-button">Focus Target Button</Button>
            <Input data-testid="focus-target-input" placeholder="Focus target input" />
          </div>
        </Card>
      </div>
    </section>
  );
};

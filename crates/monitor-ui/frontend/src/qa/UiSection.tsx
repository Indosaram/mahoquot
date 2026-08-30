import type React from "react";
import { useState } from "react";
import { Badge, Button, Card, Field, Input } from "../components/ui";

export const UiSection: React.FC = () => {
  const [clickCount, setClickCount] = useState(0);
  const [inputValue, setInputValue] = useState("");

  return (
    <section className="mb-10" data-testid="section-ui-primitives">
      <h2 className="text-lg font-semibold mb-4 text-[var(--fg)]">2. UI Primitives</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card
          data-testid="primitive-card"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)]"
        >
          <h3 className="text-sm font-semibold mb-2">Card & Buttons</h3>
          <div className="flex flex-wrap gap-2 items-center">
            <Button data-testid="primitive-button" onClick={() => setClickCount((c) => c + 1)}>
              Action Button ({clickCount})
            </Button>
            <Button disabled>Disabled Button</Button>
          </div>
        </Card>

        <Card className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)]">
          <h3 className="text-sm font-semibold mb-2">Input & Badges</h3>
          <div className="space-y-3">
            <Input
              data-testid="primitive-input"
              placeholder="Enter text..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
            <div className="flex gap-2">
              <span data-testid="primitive-badge">
                <Badge tone="ok">OK</Badge>
              </span>
              <Badge tone="warn">WARN</Badge>
              <Badge tone="bad">BAD</Badge>
              <Badge tone="neutral">NEUTRAL</Badge>
            </div>
          </div>
        </Card>

        <Card className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)] md:col-span-2">
          <h3 className="text-sm font-semibold mb-2">Field Component</h3>
          <div data-testid="primitive-field">
            <Field label="Cluster Name" hint="Used for internal gateway telemetry">
              <Input placeholder="us-east-cluster" />
            </Field>
          </div>
        </Card>
      </div>
    </section>
  );
};

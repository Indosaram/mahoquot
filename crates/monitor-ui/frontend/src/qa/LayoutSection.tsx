import type React from "react";
import { useState } from "react";
import {
  AppShell,
  Cluster,
  ContentLimiter,
  IntrinsicGrid,
  OverlayLayer,
  Stack,
  WrapRow,
} from "../components/layout";
import { Badge, Button } from "../components/ui";

export const LayoutSection: React.FC = () => {
  const [overlayOpen, setOverlayOpen] = useState(false);

  return (
    <section className="mb-10" data-testid="section-layout-primitives">
      <h2 className="text-lg font-semibold mb-4 text-[var(--fg)]">1. Layout Primitives</h2>
      <div className="space-y-6">
        <AppShell
          data-testid="primitive-app-shell"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)]"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mb-2">AppShell</div>
          <div className="text-sm text-[var(--fg-dim)]">AppShell root wrapper fixture</div>
        </AppShell>

        <Stack
          data-testid="primitive-stack"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)]"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mb-2">Stack</div>
          <div className="p-2 bg-[var(--panel-2)] rounded text-xs">Stack Item 1</div>
          <div className="p-2 bg-[var(--panel-2)] rounded text-xs mt-2">Stack Item 2</div>
        </Stack>

        <Cluster
          data-testid="primitive-cluster"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)] flex gap-2 items-center"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mr-2">Cluster:</div>
          <Badge tone="ok">Cluster Item A</Badge>
          <Badge tone="warn">Cluster Item B</Badge>
          <Badge tone="bad">Cluster Item C</Badge>
        </Cluster>

        <WrapRow
          data-testid="primitive-wrap-row"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)] flex flex-wrap gap-2"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] w-full mb-1">WrapRow:</div>
          <Badge tone="neutral">Tag 1</Badge>
          <Badge tone="neutral">Tag 2</Badge>
          <Badge tone="neutral">Tag 3</Badge>
          <Badge tone="accent">Tag 4</Badge>
        </WrapRow>

        <IntrinsicGrid
          data-testid="primitive-intrinsic-grid"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)] grid gap-4 grid-cols-1 md:grid-cols-2"
        >
          <div className="p-3 bg-[var(--panel-2)] rounded border border-[var(--line-soft)] text-xs">
            Grid Cell 1
          </div>
          <div className="p-3 bg-[var(--panel-2)] rounded border border-[var(--line-soft)] text-xs">
            Grid Cell 2
          </div>
        </IntrinsicGrid>

        <ContentLimiter
          data-testid="primitive-content-limiter"
          className="p-4 border border-[var(--line)] rounded-lg bg-[var(--panel)] max-w-xl"
        >
          <div className="text-xs font-mono text-[var(--fg-faint)] mb-1">ContentLimiter</div>
          <p className="text-sm text-[var(--fg-dim)]">
            Bounded content width container for reading length control.
          </p>
        </ContentLimiter>

        <OverlayLayer
          data-testid="primitive-overlay-layer"
          className="p-4 border border-dashed border-[var(--accent)] rounded-lg bg-[var(--panel-2)]"
        >
          <div className="text-xs font-mono text-[var(--accent)] mb-2">OverlayLayer</div>
          <div className="flex items-center gap-3">
            <Button onClick={() => setOverlayOpen(!overlayOpen)}>Toggle Overlay Modal</Button>
            {overlayOpen && (
              <div
                data-testid="active-overlay-panel"
                className="p-3 bg-[var(--panel)] border border-[var(--line)] rounded shadow-lg text-xs"
              >
                Overlay Dialog Active
              </div>
            )}
          </div>
        </OverlayLayer>
      </div>
    </section>
  );
};

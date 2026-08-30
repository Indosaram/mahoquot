import type React from "react";
import { LayoutSection } from "./LayoutSection";
import { StateMatrixSection } from "./StateMatrixSection";
import { UiSection } from "./UiSection";

export const PrimitiveShowcase: React.FC = () => {
  return (
    <div
      className="qa-showcase p-6 bg-[var(--bg)] text-[var(--fg)] min-h-screen"
      data-testid="primitive-showcase"
    >
      <header className="mb-8 border-b border-[var(--line)] pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Mahoquot Primitive Showcase</h1>
            <p className="text-sm text-[var(--fg-dim)] mt-1">
              Isolated QA harness for spatial primitives and interaction states
            </p>
          </div>
          <div
            data-testid="reduced-motion-marker"
            className="text-xs px-2 py-1 rounded bg-[var(--panel-3)] text-[var(--fg-dim)]"
          >
            motion: standard
          </div>
        </div>
      </header>

      <LayoutSection />
      <UiSection />
      <StateMatrixSection />
    </div>
  );
};

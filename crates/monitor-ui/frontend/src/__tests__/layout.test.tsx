import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AppShell,
  Cluster,
  ContentLimiter,
  IntrinsicGrid,
  OverlayLayer,
  Stack,
  WrapRow,
} from "../components/layout";

describe("layout primitives", () => {
  describe("AppShell", () => {
    it("renders children and forwards DOM attributes", () => {
      // Given: AppShell props with child content and test attributes
      const testId = "test-app-shell";

      // When: AppShell is rendered into the DOM
      render(
        <AppShell data-testid={testId} aria-label="Console Shell">
          <main>Workspace Content</main>
        </AppShell>,
      );

      // Then: the container and its children are present with forwarded attributes
      const shell = screen.getByTestId(testId);
      expect(shell).toBeInTheDocument();
      expect(shell).toHaveAttribute("aria-label", "Console Shell");
      expect(screen.getByText("Workspace Content")).toBeInTheDocument();
    });

    it("merges custom className with default primitive class", () => {
      // Given: AppShell with a custom className
      const testId = "custom-app-shell";

      // When: AppShell is rendered with custom classes
      render(<AppShell data-testid={testId} className="custom-shell-override" />);

      // Then: class list contains both the base primitive class and the custom class
      const shell = screen.getByTestId(testId);
      expect(shell).toHaveClass("app-shell");
      expect(shell).toHaveClass("custom-shell-override");
    });
  });

  describe("Stack", () => {
    it("renders children and forwards DOM attributes", () => {
      // Given: Stack props with items and test identifier
      const testId = "test-stack";

      // When: Stack is rendered with children
      render(
        <Stack data-testid={testId}>
          <div>Stack Item 1</div>
          <div>Stack Item 2</div>
        </Stack>,
      );

      // Then: the stack element and all children are rendered
      const stack = screen.getByTestId(testId);
      expect(stack).toBeInTheDocument();
      expect(screen.getByText("Stack Item 1")).toBeInTheDocument();
      expect(screen.getByText("Stack Item 2")).toBeInTheDocument();
    });

    it("merges custom className with default primitive class", () => {
      // Given: Stack with custom className
      const testId = "custom-stack";

      // When: Stack is rendered with custom classes
      render(<Stack data-testid={testId} className="gap-4 custom-stack" />);

      // Then: base primitive class and custom class are both present
      const stack = screen.getByTestId(testId);
      expect(stack).toHaveClass("layout-stack");
      expect(stack).toHaveClass("gap-4");
      expect(stack).toHaveClass("custom-stack");
    });
  });

  describe("Cluster", () => {
    it("renders inline children and forwards DOM attributes", () => {
      // Given: Cluster props with badge children and accessibility attribute
      const testId = "test-cluster";

      // When: Cluster is rendered
      render(
        <Cluster data-testid={testId} aria-label="Status badges">
          <span>Badge A</span>
          <span>Badge B</span>
        </Cluster>,
      );

      // Then: cluster container forwards attributes and renders items
      const cluster = screen.getByTestId(testId);
      expect(cluster).toBeInTheDocument();
      expect(cluster).toHaveAttribute("aria-label", "Status badges");
      expect(screen.getByText("Badge A")).toBeInTheDocument();
      expect(screen.getByText("Badge B")).toBeInTheDocument();
    });

    it("merges custom className with default primitive class", () => {
      // Given: Cluster with custom className
      const testId = "custom-cluster";

      // When: Cluster is rendered
      render(<Cluster data-testid={testId} className="items-center" />);

      // Then: base primitive class and custom class are merged
      const cluster = screen.getByTestId(testId);
      expect(cluster).toHaveClass("layout-cluster");
      expect(cluster).toHaveClass("items-center");
    });
  });

  describe("WrapRow", () => {
    it("renders wrap-safe children and forwards DOM attributes", () => {
      // Given: WrapRow props with actions and test identifier
      const testId = "test-wrap-row";

      // When: WrapRow is rendered
      render(
        <WrapRow data-testid={testId}>
          <button type="button">Action 1</button>
          <button type="button">Action 2</button>
        </WrapRow>,
      );

      // Then: WrapRow container and its actions are rendered
      const wrapRow = screen.getByTestId(testId);
      expect(wrapRow).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Action 1" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Action 2" })).toBeInTheDocument();
    });

    it("merges custom className with default primitive class", () => {
      // Given: WrapRow with custom className
      const testId = "custom-wrap-row";

      // When: WrapRow is rendered
      render(<WrapRow data-testid={testId} className="justify-between" />);

      // Then: base primitive class and custom class are merged
      const wrapRow = screen.getByTestId(testId);
      expect(wrapRow).toHaveClass("layout-wrap-row");
      expect(wrapRow).toHaveClass("justify-between");
    });
  });

  describe("IntrinsicGrid", () => {
    it("renders grid items and forwards DOM attributes", () => {
      // Given: IntrinsicGrid props with grid cards
      const testId = "test-intrinsic-grid";

      // When: IntrinsicGrid is rendered
      render(
        <IntrinsicGrid data-testid={testId}>
          <article>Card 1</article>
          <article>Card 2</article>
        </IntrinsicGrid>,
      );

      // Then: IntrinsicGrid container and cards are rendered
      const grid = screen.getByTestId(testId);
      expect(grid).toBeInTheDocument();
      expect(screen.getByText("Card 1")).toBeInTheDocument();
      expect(screen.getByText("Card 2")).toBeInTheDocument();
    });

    it("merges custom className with default primitive class", () => {
      // Given: IntrinsicGrid with custom className
      const testId = "custom-intrinsic-grid";

      // When: IntrinsicGrid is rendered
      render(<IntrinsicGrid data-testid={testId} className="account-grid" />);

      // Then: base primitive class and custom class are merged
      const grid = screen.getByTestId(testId);
      expect(grid).toHaveClass("layout-intrinsic-grid");
      expect(grid).toHaveClass("account-grid");
    });
  });

  describe("ContentLimiter", () => {
    it("renders children within width boundary and forwards DOM attributes", () => {
      // Given: ContentLimiter props with section content
      const testId = "test-content-limiter";

      // When: ContentLimiter is rendered
      render(
        <ContentLimiter data-testid={testId}>
          <section>Constrained Workspace</section>
        </ContentLimiter>,
      );

      // Then: ContentLimiter container and section are rendered
      const limiter = screen.getByTestId(testId);
      expect(limiter).toBeInTheDocument();
      expect(screen.getByText("Constrained Workspace")).toBeInTheDocument();
    });

    it("merges custom className with default primitive class", () => {
      // Given: ContentLimiter with custom className
      const testId = "custom-content-limiter";

      // When: ContentLimiter is rendered
      render(<ContentLimiter data-testid={testId} className="settings-limiter" />);

      // Then: base primitive class and custom class are merged
      const limiter = screen.getByTestId(testId);
      expect(limiter).toHaveClass("layout-content-limiter");
      expect(limiter).toHaveClass("settings-limiter");
    });
  });

  describe("OverlayLayer", () => {
    it("renders overlay children and forwards DOM attributes", () => {
      // Given: OverlayLayer props with modal dialogue content
      const testId = "test-overlay-layer";

      // When: OverlayLayer is rendered
      render(
        <OverlayLayer data-testid={testId} aria-modal="true" aria-label="Account Drawer">
          <div>Drawer Content</div>
        </OverlayLayer>,
      );

      // Then: OverlayLayer container has dialog attributes and child content
      const overlay = screen.getByTestId(testId);
      expect(overlay).toBeInTheDocument();
      expect(overlay).toHaveAttribute("aria-modal", "true");
      expect(overlay).toHaveAttribute("aria-label", "Account Drawer");
      expect(screen.getByText("Drawer Content")).toBeInTheDocument();
    });

    it("merges custom className with default primitive class", () => {
      // Given: OverlayLayer with custom className
      const testId = "custom-overlay-layer";

      // When: OverlayLayer is rendered
      render(<OverlayLayer data-testid={testId} className="drawer-open-state" />);

      // Then: base primitive class and custom class are merged
      const overlay = screen.getByTestId(testId);
      expect(overlay).toHaveClass("layout-overlay-layer");
      expect(overlay).toHaveClass("drawer-open-state");
    });
  });

  describe("state-free primitive composition", () => {
    it("composes primitives hierarchically without state or lifecycle side effects", () => {
      // Given: a full composite tree of layout primitives
      const shellId = "composite-shell";
      const stackId = "composite-stack";
      const limiterId = "composite-limiter";
      const gridId = "composite-grid";
      const clusterId = "composite-cluster";
      const wrapRowId = "composite-wrap-row";

      // When: the composite tree is rendered
      render(
        <AppShell data-testid={shellId}>
          <Stack data-testid={stackId}>
            <ContentLimiter data-testid={limiterId}>
              <Cluster data-testid={clusterId}>
                <span>Header Pill</span>
              </Cluster>
              <IntrinsicGrid data-testid={gridId}>
                <div>Grid Cell 1</div>
                <div>Grid Cell 2</div>
              </IntrinsicGrid>
              <WrapRow data-testid={wrapRowId}>
                <button type="button">Primary CTA</button>
              </WrapRow>
            </ContentLimiter>
          </Stack>
        </AppShell>,
      );

      // Then: each primitive in the hierarchy renders its expected base class and preserves children
      expect(screen.getByTestId(shellId)).toHaveClass("app-shell");
      expect(screen.getByTestId(stackId)).toHaveClass("layout-stack");
      expect(screen.getByTestId(limiterId)).toHaveClass("layout-content-limiter");
      expect(screen.getByTestId(clusterId)).toHaveClass("layout-cluster");
      expect(screen.getByTestId(gridId)).toHaveClass("layout-intrinsic-grid");
      expect(screen.getByTestId(wrapRowId)).toHaveClass("layout-wrap-row");
      expect(screen.getByText("Header Pill")).toBeInTheDocument();
      expect(screen.getByText("Grid Cell 1")).toBeInTheDocument();
      expect(screen.getByText("Grid Cell 2")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Primary CTA" })).toBeInTheDocument();
    });
  });
});

import "@testing-library/jest-dom";

// jsdom does not implement canvas 2D contexts, and the dither-kit paint loops
// call getContext during effects — an unimplemented throw there cascades as
// unhandled errors into whichever test happens to be running. A universal
// self-returning stub keeps every context method chain a harmless no-op.
type AnyRecord = Record<string | symbol, unknown>;
function makeCanvas2dStub(): AnyRecord {
  const stub: AnyRecord = new Proxy(
    function stub() {
      return stub;
    } as unknown as AnyRecord,
    {
      get: (_target, prop) => {
        if (prop === Symbol.toPrimitive) return () => 0;
        if (prop === "width" || prop === "height") return 0;
        return stub;
      },
      set: () => true,
      apply: () => stub,
    },
  );
  return stub;
}
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function getContextStub() {
    return makeCanvas2dStub();
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

// The dither-kit charts measure themselves through ResizeObserver, which jsdom
// also does not implement; without a stub every effect that mounts a chart
// throws ReferenceError before the test can assert anything.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof globalThis.ResizeObserver;
}

// jsdom ships no EventSource, so the live log stream subscription would throw
// before a Logs assertion could run. The stub records nothing; tests that care
// about streamed rows drive the component's liveTick prop directly.
if (typeof globalThis.EventSource === "undefined") {
  class EventSourceStub {
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    close() {}
  }
  globalThis.EventSource = EventSourceStub as unknown as typeof globalThis.EventSource;
}

// Mock localStorage if missing or incomplete
const storageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, "localStorage", {
  value: storageMock,
});

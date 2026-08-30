import "@testing-library/jest-dom";

// jsdom does not implement canvas 2D contexts, and the dither-kit paint loops
// call getContext during effects — an unimplemented throw there cascades as
// unhandled errors into whichever test happens to be running. A universal
// self-returning stub keeps every context method chain a harmless no-op.
type AnyRecord = Record<string | symbol, unknown>;
function makeCanvas2dStub(): AnyRecord {
  const stub: AnyRecord = new Proxy(function stub() { return stub; } as unknown as AnyRecord, {
    get: (_target, prop) => {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "width" || prop === "height") return 0;
      return stub;
    },
    set: () => true,
    apply: () => stub,
  });
  return stub;
}
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function getContextStub() {
    return makeCanvas2dStub();
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
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

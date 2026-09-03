import "@testing-library/jest-dom/vitest";
import fc from "fast-check";
import { afterEach, vi } from "vitest";

const configuredSeed = process.env.FC_SEED;
if (configuredSeed !== "random") {
  const seed = configuredSeed ? Number.parseInt(configuredSeed, 10) : 439;
  if (Number.isFinite(seed)) fc.configureGlobal({ seed });
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class IntersectionObserver {
    private readonly callback: (entries: IntersectionObserverEntry[]) => void;

    constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
      this.callback = callback;
    }

    observe(target: Element) {
      this.callback([
        { isIntersecting: true, target } as unknown as IntersectionObserverEntry,
      ]);
    }

    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value: vi.fn(() => null),
  });
}

const rangePrototype = globalThis.Range?.prototype;
if (rangePrototype && typeof rangePrototype.getClientRects !== "function") {
  Object.defineProperty(rangePrototype, "getClientRects", {
    configurable: true,
    value: () => [] as DOMRect[],
  });
}

afterEach(() => {
  const pendingTimers = (() => {
    try {
      return vi.getTimerCount();
    } catch (_error) {
      return 0;
    }
  })();
  if (pendingTimers > 0) {
    vi.clearAllTimers();
    throw new Error(`test left ${pendingTimers} fake timer(s) pending`);
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

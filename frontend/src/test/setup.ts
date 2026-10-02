import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// The `IS_REACT_ACT_ENVIRONMENT` flag lives in actEnvironment.ts, which Vitest
// loads before this file — see the comment there for why the file it lives in
// must contain no imports.

// jsdom implements neither observer, and several components use them for
// reveal-on-scroll and copy-button affordances. Without these the first render
// throws before any assertion runs, which looks like a broken component rather
// than a missing browser API.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

if (!('IntersectionObserver' in globalThis)) {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    NoopObserver;
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = NoopObserver;
}

afterEach(() => {
  cleanup();
});

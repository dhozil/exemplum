// Listed first in `setupFiles`, and deliberately free of imports.
//
// ES module imports are hoisted above everything else in a module, so a flag set
// in the same file that imports @testing-library/react runs *after* React's act
// module has been evaluated and cached "this environment does not support act".
// The symptom is act() printing "the current testing environment is not
// configured to support act" and every async click warning that an update was
// not wrapped — noise that teaches you to ignore warnings you need to read.
//
// With no imports here, this assignment is the first thing that runs in the
// jsdom environment, and setup.ts finds the flag already set.
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean };
g.IS_REACT_ACT_ENVIRONMENT = true;
if (typeof window !== 'undefined') {
  (window as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

export {};

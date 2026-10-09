import { describe, expect, it } from 'vitest';

import { EXPLORER_URL, explorerAddress, explorerTx } from '../config';

/**
 * Explorer links have to point somewhere that answers.
 *
 * The genlayer-js `studionet` chain definition carries
 * `https://genlayer-explorer.vercel.app` as its explorer, and that host returns
 * 503 on every path — checked three times, on the root and on both lookup paths.
 * Falling back to it produced links that were dead on arrival while looking
 * perfectly correct: a valid-looking https URL, a real tx hash, and nothing at
 * the end of it.
 *
 * So the URL is explicit, and the SDK value is never used as a default. These
 * cannot check reachability — a test suite that depends on a third-party host is
 * a suite that fails for reasons unrelated to the change — so they check the
 * things that would produce the same dead link again: an empty base, a leftover
 * slash producing `//tx/`, and a silent return to the SDK default.
 */

describe('explorer links', () => {
  it('resolves to an https URL', () => {
    expect(EXPLORER_URL).toMatch(/^https:\/\//);
  });

  it('is not empty, which would make every link a bare path', () => {
    expect(EXPLORER_URL.length).toBeGreaterThan(0);
  });

  /* The SDK's studionet explorer is 503 on every path. If this ever starts using
     it again, links go dead without a single line changing. */
  it('does not fall back to the SDK explorer that answers 503', () => {
    expect(EXPLORER_URL).not.toContain('genlayer-explorer.vercel.app');
  });

  it('has no trailing slash, so joins do not double up', () => {
    expect(EXPLORER_URL.endsWith('/')).toBe(false);
  });

  it('builds a transaction link', () => {
    const hash = '0x' + 'ab'.repeat(32);
    expect(explorerTx(hash)).toBe(`${EXPLORER_URL}/tx/${hash}`);
    expect(explorerTx(hash)).not.toContain('//tx/');
  });

  it('builds an address link', () => {
    const addr = '0x2Cd0344Fc2C1480b7CD1FeD55e0F8C84EDeEEbB1';
    expect(explorerAddress(addr)).toBe(`${EXPLORER_URL}/address/${addr}`);
    expect(explorerAddress(addr)).not.toContain('//address/');
  });
});
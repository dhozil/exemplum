import { describe, expect, it } from 'vitest';
import { cooldownEnd, formatGen, parseGen } from '../lib/format';

/**
 * GEN amounts are u256 on chain and arrive as `bigint` after JSON parsing. Every
 * display and parse path has to survive the magnitudes real escrows use, and the
 * original reason `parseGen` does string arithmetic rather than `Number` was a
 * 1,000 GEN escrow being read wrong.
 */
describe('formatGen', () => {
  it('renders whole GEN', () => {
    expect(formatGen(10n ** 18n)).toContain('1');
    expect(formatGen(0n)).toContain('0');
  });

  it('groups thousands', () => {
    expect(formatGen(1000n * 10n ** 18n)).toContain('1,000');
  });

  it('does not lose precision on large amounts', () => {
    // 1234.567891234567891 GEN — more significant digits than a double holds.
    const wei = 1234567891234567891n * 10n ** 12n;
    const out = formatGen(wei);
    expect(out).toContain('1,234');
    expect(out).toContain('5678');
  });

  it('accepts a number as well as a bigint', () => {
    // 1 wei is below the display precision, so it rounds away to 0 GEN. What
    // matters is that a plain `number` input is handled rather than producing
    // `NaN` or throwing.
    expect(formatGen(1)).toContain('GEN');
    expect(formatGen(2 * 10 ** 18)).toContain('2');
  });

  it('rounds sub-precision amounts away rather than showing noise', () => {
    // A 1-wei remainder must not render as a long tail of zeros.
    expect(formatGen(1n)).toBe('0 GEN');
  });

  it('renders a negative amount with its sign', () => {
    expect(formatGen(-(10n ** 18n)).startsWith('-')).toBe(true);
  });
});

describe('parseGen', () => {
  it('round-trips a normal amount', () => {
    const parsed = parseGen('2.5');
    expect(parsed.error).toBeNull();
    expect(parsed.wei).toBe(25n * 10n ** 17n);
  });

  it('handles an amount larger than a double can represent', () => {
    const parsed = parseGen('1000000');
    expect(parsed.error).toBeNull();
    expect(parsed.wei).toBe(10n ** 24n);
  });

  it('rejects nonsense with a message rather than NaN', () => {
    for (const bad of ['', 'abc', '1.2.3', '--1', '1e5']) {
      const parsed = parseGen(bad);
      expect(parsed.error, `"${bad}" should be rejected`).toBeTruthy();
      expect(parsed.wei).toBeNull();
    }
  });

  it('refuses a negative amount', () => {
    // A negative top-up is not a thing, and silently allowing one would let the
    // UI offer a button the contract must reject.
    expect(parseGen('-1').error).toBeTruthy();
  });
});

describe('cooldownEnd', () => {
  const HOUR = 3600 * 1000;

  it('returns an hour past the last evaluation', () => {
    const at = '2026-06-01T12:00:00Z';
    expect(cooldownEnd(at)).toBe(new Date(at).getTime() + HOUR);
  });

  /* A record that has never been re-evaluated has no last_evaluated_at. The
     contract applies no cooldown in that case, so returning null here is what
     keeps the first dispute from being blocked by the button. */
  it('returns null for a record that was never re-evaluated', () => {
    expect(cooldownEnd(undefined)).toBeNull();
    expect(cooldownEnd('')).toBeNull();
  });

  it('returns null for unparseable input rather than NaN', () => {
    expect(cooldownEnd('not a date')).toBeNull();
  });

  it('honours a different window, so the contract value is the only magic number', () => {
    const at = '2026-06-01T12:00:00Z';
    expect(cooldownEnd(at, 60)).toBe(new Date(at).getTime() + 60000);
  });
});

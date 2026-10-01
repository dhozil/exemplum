import { describe, expect, it } from 'vitest';
import { parseRevisionLedger } from '../lib/types';

const row = (revision: number, quote = 'v1.3.0') => ({
  revision,
  at: `2026-09-30T09:5${revision}:00.000000Z`,
  verdict: 'confirmed',
  confidence: 'high',
  corroboration: 2,
  contradiction: 0,
  unavailable: 0,
  sources: [
    {
      source: 'https://registry.npmjs.org/left-pad/latest',
      verdict: 'confirmed',
      confidence: 'high',
      evidence_quote: quote,
      reasoning: 'matched',
      content_hash: 'a'.repeat(64),
    },
  ],
});

/**
 * `parseRevisionLedger` sits directly in the render path of the record page. If
 * it throws on a shape it did not expect, the whole page dies — so every
 * degradation path is asserted here rather than left to chance.
 */
describe('parseRevisionLedger', () => {
  it('parses a well-formed ledger', () => {
    const parsed = parseRevisionLedger(JSON.stringify([row(0), row(1, 'withdrawn')]));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].revision).toBe(0);
    expect(parsed[1].sources[0].evidence_quote).toBe('withdrawn');
  });

  it('returns nothing for a record that has never been re-evaluated', () => {
    expect(parseRevisionLedger(undefined)).toEqual([]);
    expect(parseRevisionLedger('')).toEqual([]);
  });

  it('survives malformed JSON rather than taking the page down', () => {
    expect(parseRevisionLedger('not json at all')).toEqual([]);
    expect(parseRevisionLedger('{')).toEqual([]);
    expect(parseRevisionLedger('[unclosed')).toEqual([]);
  });

  it('rejects a payload that is not an array', () => {
    // A contract bug could change the field's type; that must not crash a page.
    expect(parseRevisionLedger('{"revision": 0}')).toEqual([]);
    expect(parseRevisionLedger('null')).toEqual([]);
    expect(parseRevisionLedger('42')).toEqual([]);
  });

  it('drops entries that are not shaped like a row, keeping the good ones', () => {
    const raw = JSON.stringify([row(0), null, 'nonsense', { nope: true }, row(1)]);
    const parsed = parseRevisionLedger(raw);
    expect(parsed.map((r) => r.revision)).toEqual([0, 1]);
  });

  it('rejects a row whose revision is not a number', () => {
    // Without this, `{revision: "0"}` would flow into a React key and sort.
    const parsed = parseRevisionLedger(JSON.stringify([{ revision: '0' }]));
    expect(parsed).toEqual([]);
  });

  it('keeps a revision of zero, which is falsy but valid', () => {
    const parsed = parseRevisionLedger(JSON.stringify([row(0)]));
    expect(parsed).toHaveLength(1);
  });
});

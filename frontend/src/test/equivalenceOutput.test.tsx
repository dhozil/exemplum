import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EquivalenceOutput } from '../components/EquivalenceOutput';
import type { NotarizationRecord } from '../lib/types';

/**
 * The equivalence principle output has to be readable, not merely present.
 *
 * It used to be one row of a key/value list between "challenges" and "content
 * hashes". It was there the whole time, and someone asking "why did this come out
 * confirmed?" had no way to find it without already knowing it existed. These
 * check that it is legible and that it does not overstate what the protocol
 * verified.
 */

const BASE = {
  claim: 'The npm package react has version 18.2.0',
  current_verdict: 'confirmed' as const,
  current_confidence: 75,
  reasoning: 'Both sources report 18.2.0 in the version field.',
  sources: ['https://registry.npmjs.org/react/18.2.0', 'https://registry.npmjs.org/react/latest'],
  per_source: [
    {
      source: 'https://registry.npmjs.org/react/18.2.0',
      verdict: 'confirmed' as const,
      confidence: 80,
      evidence_quote: '"version":"18.2.0"',
      content_hash: 'abc123',
      reasoning: 'version field reads 18.2.0',
    },
    {
      source: 'https://registry.npmjs.org/react/latest',
      verdict: 'confirmed' as const,
      confidence: 70,
      evidence_quote: '"version":"18.2.0"',
      content_hash: 'def456',
      reasoning: 'latest also resolves to 18.2.0',
    },
  ],
} as unknown as Pick<
  NotarizationRecord,
  'claim' | 'current_verdict' | 'current_confidence' | 'reasoning' | 'sources' | 'per_source'
>;

describe('EquivalenceOutput', () => {
  it('leads with the verdict, so stopping early still answers the question', () => {
    render(<EquivalenceOutput record={BASE} />);
    // Both sources agree, so "confirmed" appears on the verdict and on each
    // judgement. Asserting one match would fail on a correct render.
    expect(screen.getAllByText('confirmed').length).toBeGreaterThan(1);
  });

  it('shows the claim that was decided', () => {
    render(<EquivalenceOutput record={BASE} />);
    expect(screen.getByText(/react has version 18\.2\.0/)).toBeInTheDocument();
  });

  it('shows the committee reasoning, not just the verdict', () => {
    render(<EquivalenceOutput record={BASE} />);
    expect(screen.getByText(/Both sources report 18\.2\.0/)).toBeInTheDocument();
  });

  it('names itself as the equivalence principle output', () => {
    render(<EquivalenceOutput record={BASE} />);
    expect(screen.getByText(/equivalence principle output/i)).toBeInTheDocument();
  });

  /* Validators agree on verdict, confidence and quote — never on the wording of
     the reasoning. Rendering it as though the protocol checked the prose would be
     the one thing more dishonest than omitting it. */
  it('says the reasoning was not itself verified', () => {
    render(<EquivalenceOutput record={BASE} />);
    expect(screen.getByText(/not on this\s+wording|not something the protocol verified/i)).toBeInTheDocument();
  });

  it('reports how many sources were actually read', () => {
    render(<EquivalenceOutput record={BASE} />);
    expect(screen.getByText(/2 of 2 sources read/i)).toBeInTheDocument();
  });

  it('counts an unavailable source as not read', () => {
    const withDead = {
      ...BASE,
      per_source: [
        BASE.per_source[0],
        { ...BASE.per_source[1], verdict: 'unavailable' as const, reasoning: 'fetch failed' },
      ],
    };
    render(<EquivalenceOutput record={withDead} />);
    expect(screen.getByText(/1 of 2 sources read/i)).toBeInTheDocument();
  });

  it('shows each judgement with its quote', () => {
    render(<EquivalenceOutput record={BASE} />);
    // Both sources cited the same line, so it appears once per judgement.
    expect(screen.getAllByText('"version":"18.2.0"').length).toBe(2);
  });

  it('says so when a round recorded no reasoning, rather than showing nothing', () => {
    render(<EquivalenceOutput record={{ ...BASE, reasoning: '' }} />);
    expect(screen.getByText(/no written reason/i)).toBeInTheDocument();
  });

  it('handles a refuted verdict just as legibly', () => {
    render(<EquivalenceOutput record={{ ...BASE, current_verdict: 'refuted' as const }} />);
    expect(screen.getByText('refuted')).toBeInTheDocument();
  });

  it('can be rendered without the per-source evidence, for a compact panel', () => {
    render(<EquivalenceOutput record={BASE} showEvidence={false} />);
    expect(screen.queryByText('"version":"18.2.0"')).not.toBeInTheDocument();
  });

  it('accepts a custom heading so a caller can say which record it is', () => {
    render(<EquivalenceOutput record={BASE} heading="What the committee concluded — record #7" />);
    expect(screen.getByText(/record #7/)).toBeInTheDocument();
  });
});

describe('EquivalenceOutput does not crash on thin data', () => {
  it('renders a record with no sources', () => {
    render(<EquivalenceOutput record={{ ...BASE, sources: [], per_source: [] }} />);
    expect(screen.getByText(/no sources were attached/i)).toBeInTheDocument();
  });

  it('renders a record with no per-source results', () => {
    render(<EquivalenceOutput record={{ ...BASE, per_source: undefined as never }} />);
    // The whole point of the panel survives a thin record: verdict and reasoning
    // are still readable without a per-source breakdown.
    expect(screen.getByText(/Both sources report 18\.2\.0/)).toBeInTheDocument();
  });
});
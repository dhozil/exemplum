/** Presentation helpers. Kept separate so the contracts stay the only source
 *  of truth for meaning; these functions only decide how it is spelled. */

import { CHAIN_NAME, CURRENCY_SYMBOL } from '../config';

export function shortAddress(value: string, lead = 6, tail = 4): string {
  if (!value) return '';
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function shortHash(value: string, lead = 10, tail = 6): string {
  if (!value) return '';
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(d);
}

export function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(d);
}

/** "in 6 days" / "2 hours ago" — deadlines matter more as distances. */
export function relativeTo(iso: string): string {
  if (!iso) return '';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '';

  const diffMs = target - Date.now();
  const future = diffMs >= 0;
  const abs = Math.abs(diffMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (abs < minute) return 'just now';
  if (abs < hour) {
    value = Math.round(abs / minute);
    unit = 'minute';
  } else if (abs < day) {
    value = Math.round(abs / hour);
    unit = 'hour';
  } else {
    value = Math.round(abs / day);
    unit = 'day';
  }

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  return rtf.format(future ? value : -value, unit);
}

export function isPast(iso: string): boolean {
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t <= Date.now();
}

/** GEN amounts. Contracts store u256 wei; 18 decimals. */
export function formatGen(wei: number | bigint, opts: { maxDecimals?: number } = {}): string {
  const maxDecimals = opts.maxDecimals ?? 4;
  const asBig = typeof wei === 'bigint' ? wei : BigInt(Math.trunc(wei));
  const negative = asBig < 0n;
  const abs = negative ? -asBig : asBig;

  const whole = abs / 10n ** 18n;
  let frac = (abs % 10n ** 18n).toString().padStart(18, '0').slice(0, maxDecimals).replace(/0+$/, '');

  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac ? `.${frac}` : ''} ${CURRENCY_SYMBOL}`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-GB').format(n);
}

export type GenParse = { wei: bigint; error: null } | { wei: null; error: string };

/**
 * Parse a decimal GEN amount into wei.
 *
 * String arithmetic, never `Number`: an escrow for 1,000 GEN is exactly
 * 1e21 wei, which a float cannot hold. Precision beyond 18 decimals is
 * rejected rather than truncated — silently dropping digits in a money field is
 * how an escrow ends up registered for a different figure than the one agreed.
 */
export function parseGen(value: string): GenParse {
  const raw = value.trim().replace(/[_ ]/g, '');
  if (raw.length === 0) return { wei: null, error: 'Enter the amount agreed.' };
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return { wei: null, error: 'Use digits with an optional decimal point — no sign or currency.' };
  }

  const [whole, frac = ''] = raw.split('.');
  if (frac.length > 18) {
    return { wei: null, error: 'GEN has 18 decimals. This amount is finer than it can be recorded.' };
  }

  const wei = BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0') || '0');
  if (wei === 0n) return { wei: null, error: 'The amount has to be greater than zero.' };
  return { wei, error: null };
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function isUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isTxHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Chain name, used in the network strip and in copy. */
export const CHAIN_LABEL = CHAIN_NAME;

export function pluralise(n: number, one: string, many?: string): string {
  return n === 1 ? one : (many ?? `${one}s`);
}

/**
 * When a re-evaluation becomes available again, or null if it already is.
 *
 * Mirrors `REEVALUATION_COOLDOWN_SECONDS` in the contract. Duplicated rather
 * than fetched because the page has to render the button state from data it
 * already holds, and a separate call that can fail would leave the button
 * enabled exactly when it should not be.
 *
 * `last_evaluated_at` is empty on a record that has never been re-evaluated,
 * and on a deployment predating the cooldown — both mean "no wait", so both
 * return null and leave the button alone.
 */
export function cooldownEnd(lastEvaluatedAt: string | undefined, windowSeconds = 3600): number | null {
  if (!lastEvaluatedAt) return null;
  const then = new Date(lastEvaluatedAt).getTime();
  if (Number.isNaN(then)) return null;
  return then + windowSeconds * 1000;
}

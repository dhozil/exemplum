/**
 * Turning a failure into something a person can act on.
 *
 * The contracts raise `gl.vm.UserError` with a tagged message such as
 * "[EXPECTED] need at least 2 distinct sources". That text is the most useful
 * thing we can show, so it is surfaced verbatim rather than replaced with a
 * generic apology. Everything else — wallet rejections, undetermined consensus,
 * rate limits, unreachable RPC — gets its own explanation and, where it makes
 * sense, a retry.
 */

import { ZERO, contractsConfigured, NOTARY_ADDRESS, SETTLEMENT_ADDRESS } from '../config';

export type ErrorTone = 'danger' | 'warn' | 'info';

export interface FriendlyError {
  title: string;
  detail: string;
  /** The contract's own message, when there is one. */
  contractMessage?: string;
  hint?: string;
  tone: ErrorTone;
  retryable: boolean;
  code?: string;
}

const CONTRACT_RE = /\[(EXPECTED|EXTERNAL|TRANSIENT|LLM_ERROR)\]\s*([^\n]*)/;

/**
 * Remembers that a refusal has already been seen, because the browser will
 * never tell us the status code.
 *
 * This is the only honest way to distinguish "the node is down" from "the node
 * refused us and the refusal was blocked by CORS": in the first case every read
 * fails from the start, in the second they succeed until the budget runs out
 * partway through a session. A bare "Failed to fetch" carries no status, so the
 * prior is the signal. A refusal seen in the last two minutes flips the
 * diagnosis — and because a fresh app with an unreachable node has never seen
 * one, the default stays "unreachable" rather than guessing.
 */
let sawRefusalAt = 0;
const REFUSAL_MEMORY_MS = 2 * 60_000;

function noteRefusal(): void {  sawRefusalAt = Date.now();
}

function hasRecentRateLimit(): boolean {
  return sawRefusalAt > 0 && Date.now() - sawRefusalAt < REFUSAL_MEMORY_MS;
}

/** Called by the RPC layer, which can sometimes see a real 429. */
export function recordRateLimit(): void {
  noteRefusal();
}

/** True when a refusal has been seen recently — used to word the UI. */
export function rateLimitedRecently(): boolean {
  return hasRecentRateLimit();
}

function walk(err: unknown, depth = 0): string[] {
  if (!err || depth > 6) return [];
  const out: string[] = [];
  if (typeof err === 'string') {
    out.push(err);
  } else if (err instanceof Error) {
    out.push(err.message);
    if (err.cause) out.push(...walk(err.cause, depth + 1));
  } else if (typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    for (const key of ['message', 'reason', 'details', 'shortMessage']) {
      const v = anyErr[key];
      if (typeof v === 'string' && v.length > 0) out.push(v);
    }
    if (anyErr.cause) out.push(...walk(anyErr.cause, depth + 1));
  }
  return out;
}

export function describeError(err: unknown): FriendlyError {
  const parts = walk(err);
  const blob = parts.join(' \n ');

  // A response we were allowed to read that still said "refused" is
  // unambiguous. Record it, so the next header-less failure is also read as a
  // refusal rather than an outage.
  if (/\b429\b|rate limit|too many requests/i.test(blob)) noteRefusal();

  // 1. The contract told us exactly what was wrong.
  const contract = CONTRACT_RE.exec(blob);
  if (contract) {
    const [, tag, message] = contract;
    return {
      title: 'The contract rejected this',
      detail: message?.trim() || 'The contract rejected this request.',
      contractMessage: contract[0].trim(),
      tone: tag === 'EXTERNAL' || tag === 'TRANSIENT' ? 'warn' : 'danger',
      retryable: tag === 'TRANSIENT' || tag === 'EXTERNAL',
      code: tag,
    };
  }

  // 2. The network is not configured, which is a setup problem, not a user one.
  if (!contractsConfigured()) {
    return {
      title: 'No deployment configured',
      detail:
        'This build has no contract addresses. Set VITE_NOTARY_ADDRESS and VITE_SETTLEMENT_ADDRESS, or use a build that ships with deployments.',
      hint: `Currently ${NOTARY_ADDRESS === ZERO ? 'unset' : NOTARY_ADDRESS} / ${SETTLEMENT_ADDRESS === ZERO ? 'unset' : SETTLEMENT_ADDRESS}`,
      tone: 'warn',
      retryable: false,
    };
  }

  // 3. The person declined in their wallet. Not an error to apologise for.
  if (
    /user rejected|user denied|rejected the request|request rejected|denied transaction|codes?4001/i.test(
      blob,
    )
  ) {
    return {
      title: 'Signature declined',
      detail: 'The transaction was not signed, so nothing was submitted.',
      tone: 'info',
      retryable: false,
    };
  }

  // 4. Validators could not agree. This is the interesting one: it is a
  //    property of the protocol, not a malfunction.
  if (/undetermined/i.test(blob)) {
    return {
      title: 'Validators did not reach agreement',
      detail:
        'The transaction ended UNDETERMINED, so no state was written. This happens when validators disagree about the non-deterministic result and rotations run out.',
      hint: 'Nothing changed on chain. Try again, or appeal the transaction if you think the recorded outcome is wrong.',
      tone: 'warn',
      retryable: true,
      code: 'UNDETERMINED',
    };
  }

  // 5. Rate limiting, when the browser was allowed to see the response.
  if (/\b429\b|-32429|rate limit|too many requests|pending-queue/i.test(blob)) {
    return {
      title: 'The network is rate limiting this app',
      detail: 'Too many requests were sent to the RPC endpoint in a short window.',
      hint: 'Wait about a minute, then retry. Batching several writes at once is what usually trips it.',
      tone: 'warn',
      retryable: true,
      code: 'RATE_LIMITED',
    };
  }

  // 6. The request never arrived — or the response was never allowed through.
  //
  //    These two are indistinguishable from here, and on StudioNet the second
  //    one is far more common than it looks. The public endpoint answers a
  //    rate-limited request with a bare 429 carrying no
  //    `Access-Control-Allow-Origin` header, so the browser refuses to hand the
  //    response to JavaScript and `fetch` rejects with "Failed to fetch" — the
  //    same thing a genuinely unreachable node produces. The console shows a CORS
  //    error, which points at the wrong layer entirely.
  //
  //    So: name the likely cause, give the one diagnostic that actually
  //    distinguishes them, and do not claim the node is down.
  if (
    /failed to fetch|network ?error|err_|econnrefused|load failed|cors|fetch failed|timeout/i.test(
      blob,
    )
  ) {
    const rateLimited = hasRecentRateLimit();
    return {
      title: rateLimited ? 'The network is rate limiting this app' : 'Could not reach the GenLayer node',
      detail: rateLimited
        ? 'The RPC endpoint refused this request. The browser reported it as a blocked cross-origin request because the error response carries no CORS header — that is a symptom of the refusal, not a CORS misconfiguration.'
        : 'The request never got a response.',
      hint: rateLimited
        ? 'The public StudioNet endpoint allows a limited number of contract calls per hour per IP (measured at 500 gen_call requests per hour). The budget is per IP, so a dev server, a second tab, and any other tool pointed at the same endpoint all spend from it. Wait for the window to reset, then retry.'
        : 'Check the RPC URL and your connection, then retry. If the network is only rate limiting, the console shows the same CORS error — see the note in frontend/README.md.',
      tone: rateLimited ? 'warn' : 'danger',
      retryable: true,
      code: rateLimited ? 'RATE_LIMITED' : 'UNREACHABLE',
    };
  }

  if (/insufficient funds|exceeds balance|gas required exceeds/i.test(blob)) {
    return {
      title: 'Not enough balance',
      detail: 'The submitting account cannot cover this transaction.',
      hint: 'Fund the account on this network and try again.',
      tone: 'danger',
      retryable: false,
    };
  }

  // 7. Anything else: show it rather than hide it.
  return {
    title: 'Something went wrong',
    detail: parts[0] || 'The request failed without a message.',
    tone: 'danger',
    retryable: true,
  };
}

/**
 * Transaction lifecycle.
 *
 * The important rule, and the one most dApps get wrong: on GenLayer, ACCEPTED
 * and FINALIZED describe the *consensus* outcome, not whether the contract ran.
 * A transaction can be finalized and still have failed inside the contract, in
 * which case no state was written. So the receipt is inspected for
 * `execution_result` before anything is reported as a success.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from './chain';
import { describeError, type FriendlyError } from './errors';

/** genlayer-js re-exports neither its Hash type nor its status enum from the
 *  package root, so both are borrowed from the method signatures. `FINALIZED` is
 *  cast through the parameter type rather than stringified, so a library change
 *  surfaces here instead of at runtime. */
type LibHash = Parameters<typeof client.waitForTransactionReceipt>[0]['hash'];
type WaitStatus = Parameters<typeof client.waitForTransactionReceipt>[0]['status'];
type SignFn = () => Promise<`0x${string}`>;
const FINALIZED = 'FINALIZED' as WaitStatus;

export type TxPhase =
  | 'idle'
  | 'signing'
  | 'submitted'
  | 'proposing'
  | 'committing'
  | 'revealing'
  | 'accepted'
  | 'finalized'
  | 'undetermined'
  | 'error';

export interface TxState {
  phase: TxPhase;
  hash: string | null;
  error: FriendlyError | null;
  /** True once the receipt says the contract actually executed successfully. */
  executed: boolean;
  /** Present when execution failed inside the contract. */
  executionDetail: string | null;
}

const INITIAL: TxState = {
  phase: 'idle',
  hash: null,
  error: null,
  executed: false,
  executionDetail: null,
};

const PHASE_ORDER: TxPhase[] = ['submitted', 'proposing', 'committing', 'revealing', 'accepted'];

interface AnyReceipt {
  status_name?: string;
  status?: string;
  consensus_data?: {
    leader_receipt?: Array<{
      execution_result?: string;
      genvm_result?: { stderr?: string; error_description?: string | null };
      result?: { status?: string; payload?: unknown };
    }>;
  };
}

const PHASE_FROM_STATUS: Record<string, TxPhase> = {
  UNINITIALIZED: 'submitted',
  PENDING: 'submitted',
  PROPOSING: 'proposing',
  COMMITTING: 'committing',
  REVEALING: 'revealing',
  ACCEPTED: 'accepted',
  FINALIZED: 'finalized',
  UNDETERMINED: 'undetermined',
  CANCELED: 'error',
};

function phaseFromStatus(status: string | undefined): TxPhase | null {
  if (!status) return null;
  return PHASE_FROM_STATUS[status.toUpperCase()] ?? null;
}

/** Did the contract body actually run to completion? */
function inspectExecution(receipt: AnyReceipt): { ok: boolean; detail: string | null } {
  const leader = receipt.consensus_data?.leader_receipt?.[0];
  if (!leader) return { ok: false, detail: null };

  /* The contract's own message lives in `result`, not in `genvm_result`, and the
     check has to come before the execution_result check. A deterministic
     rejection arrives as `status: 'rollback'` with the tagged text in `payload`
     and `execution_result: 'ERROR'`, while stderr and error_description are both
     empty. Reading only `genvm_result` — or only the 'contract_error' status —
     silently discarded "[EXPECTED] No such record: 999" and showed a generic
     "did not complete" instead, which is the one string that helps nobody. */
  const result = leader.result;
  const resultStatus = result?.status;
  if (resultStatus && resultStatus !== 'return') {
    return { ok: false, detail: String(result?.payload ?? resultStatus) };
  }

  if (leader.execution_result === 'SUCCESS') {
    return { ok: true, detail: null };
  }

  const stderr = leader.genvm_result?.stderr?.trim();
  const described = leader.genvm_result?.error_description;
  if (stderr) return { ok: false, detail: stderr };
  if (described) return { ok: false, detail: described };
  return { ok: false, detail: 'The contract did not complete.' };
}

export interface SubmitOptions {
  /** Human name of the action, used in status copy. */
  action: string;
  /** Skips the validator committee for cheap writes. */
  leaderOnly?: boolean;
  onSuccess?: (receipt: unknown) => void;
  onSettled?: () => void;
}

/**
 * Submits a write and tracks it all the way to a decided state.
 *
 * `sign` returns the hash; everything after that is polling. The phase names
 * come from the protocol, not from a guess: a notarization genuinely goes
 * through proposing → committing → revealing because five validators have to
 * agree, and showing those stages is more honest than a spinner.
 */
export function useTx() {
  const [state, setState] = useState<TxState>(INITIAL);
  const pollRef = useRef<number | null>(null);
  const actionRef = useRef<string>('');

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    setState(INITIAL);
  }, [stopPolling]);

  const submit = useCallback(
    async (sign: SignFn, opts: SubmitOptions) => {
      stopPolling();
      actionRef.current = opts.action;
      setState({ phase: 'signing', hash: null, error: null, executed: false, executionDetail: null });

      let hash: LibHash;
      try {
        hash = (await sign()) as LibHash;
      } catch (err) {
        setState({
          phase: 'error',
          hash: null,
          error: describeError(err),
          executed: false,
          executionDetail: null,
        });
        return;
      }

      setState({ phase: 'submitted', hash, error: null, executed: false, executionDetail: null });

      const finish = (next: TxState) => {
        stopPolling();
        setState(next);
        opts.onSettled?.();
      };

      // While pending, follow the protocol stages so the UI can name them.
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const tx = (await client.getTransaction({ hash })) as AnyReceipt;
            const phase = phaseFromStatus(tx?.status_name ?? tx?.status);
            if (phase && PHASE_ORDER.indexOf(phase) >= 0) {
              setState((prev) => (prev.phase === phase ? prev : { ...prev, phase }));
            }
          } catch {
            /* transient poll failure: the receipt wait below is authoritative */
          }
        })();
      }, 2500);

      try {
        const receipt = await client.waitForTransactionReceipt({
          hash,
          status: FINALIZED,
          interval: 3000,
          retries: 80,
        });
        const typed = receipt as unknown as AnyReceipt;
        const finalPhase = phaseFromStatus(typed.status_name ?? typed.status);

        if (finalPhase === 'undetermined' || typed.status_name === 'UNDETERMINED') {
          finish({
            phase: 'undetermined',
            hash,
            error: describeError(new Error('UNDETERMINED')),
            executed: false,
            executionDetail: null,
          });
          return;
        }

        const execution = inspectExecution(typed);

        if (!execution.ok) {
          finish({
            phase: 'error',
            hash,
            error: {
              title: `${actionRef.current} did not apply`,
              detail: 'The transaction reached consensus but the contract rejected the call, so no state was written.',
              contractMessage: execution.detail ?? undefined,
              tone: execution.detail?.includes('[EXTERNAL]') || execution.detail?.includes('[TRANSIENT]')
                ? 'warn'
                : 'danger',
              retryable: execution.detail?.includes('[TRANSIENT]') ?? false,
            },
            executed: false,
            executionDetail: execution.detail,
          });
          return;
        }

        finish({
          phase: 'finalized',
          hash,
          error: null,
          executed: true,
          executionDetail: null,
        });
        opts.onSuccess?.(receipt);
      } catch (err) {
        finish({
          phase: 'error',
          hash,
          error: describeError(err),
          executed: false,
          executionDetail: null,
        });
      }
    },
    [stopPolling],
  );

  return { state, submit, reset, busy: state.phase !== 'idle' && state.phase !== 'error' };
}

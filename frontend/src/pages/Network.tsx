import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CHAIN_NAME,
  CURRENCY_SYMBOL,
  DEPLOYMENTS,
  EXPLORER_URL,
  NOTARY_ADDRESS,
  RPC_URL,
  SETTLEMENT_ADDRESS,
  contractsConfigured,
  explorerAddress,
} from '../config';
import { client, ping } from '../lib/chain';
import { useQuery } from '../lib/useQuery';
import { formatCount } from '../lib/format';
import type { NotaryStats, SettlementStats } from '../lib/types';
import { KeyValue } from '../components/Evidence';
import { CopyButton } from '../components/Tx';

type Addr = `0x${string}`;

export default function Network() {
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [block, setBlock] = useState<bigint | null>(null);

  const stats = useQuery<NotaryStats>(
    () =>
      client
        .readContract({
          address: NOTARY_ADDRESS as Addr,
          functionName: 'get_stats',
          jsonSafeReturn: true,
        })
        .then((r) => r as unknown as NotaryStats),
    [],
    { enabled: contractsConfigured() },
  );

  const settlements = useQuery<SettlementStats | null>(
    () =>
      contractsConfigured()
        ? client.readContract({
            address: SETTLEMENT_ADDRESS as `0x${string}`,
            functionName: 'get_stats',
            jsonSafeReturn: true,
          }).then((r) => r as unknown as SettlementStats)
        : Promise.resolve(null),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const ok = await ping();
      if (cancelled) return;
      setReachable(ok);
      if (ok) {
        try {
          const n = await client.getBlockNumber();
          if (!cancelled) setBlock(n);
        } catch {
          /* the strip already reports reachability */
        }
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="docket">
      <div className="section" style={{ borderTop: 'none' }}>
        <p className="label">Deployment</p>
        <h1 style={{ fontSize: 'var(--t-h1)', margin: 'var(--s-3) 0 var(--s-4)', maxWidth: '22ch' }}>
          Which chain, and which contracts.
        </h1>
        <p className="lede">
          Every address this build reads from is listed here, so you can check any number in the
          interface against the chain.
        </p>
      </div>

      <div className="section">
        <div className="section__eyebrow">
          <span className="label">Node</span>
        </div>
        <KeyValue
          rows={[
            ['network', CHAIN_NAME],
            ['rpc', <Inline value={RPC_URL} href={RPC_URL} />],
            ['explorer', <Inline value={EXPLORER_URL} href={EXPLORER_URL} />],
            [
              'reachable',
              reachable === null ? 'checking…' : reachable ? 'yes' : 'no',
            ],
            ['block height', block === null ? '—' : formatCount(Number(block))],
            ['currency', CURRENCY_SYMBOL],
          ]}
        />
        {reachable === false && (
          <div className="notice notice--danger" style={{ marginTop: 'var(--s-4)' }}>
            <p className="notice__title">The node did not answer</p>
            <p className="notice__body">
              Reads on this page will fail until the RPC endpoint responds. The network strip in the
              header shows the same state.
            </p>
          </div>
        )}
      </div>

      <div className="section">
        <div className="section__eyebrow">
          <span className="label">Contracts</span>
        </div>

        {!contractsConfigured() && (
          <div className="notice notice--warn" style={{ marginBottom: 'var(--s-4)' }}>
            <p className="notice__title">No deployment configured</p>
            <p className="notice__body">
              Set <code>VITE_NOTARY_ADDRESS</code> and <code>VITE_SETTLEMENT_ADDRESS</code> when
              building, or use a build that ships with addresses. Reads and writes will not work until
              one is set.
            </p>
          </div>
        )}

        <div className="stack">
          <ContractCard
            name="AINotary"
            address={NOTARY_ADDRESS}
            role="Attestation. Fetches each source, judges the claim, and records the verdict a committee agreed on."
            methods="notarize · challenge · re_evaluate · set_paused · get_record · get_records_paginated · get_stats · get_challenge_log · get_source_hashes"
            stats={stats.data ? `${formatCount(stats.data.total)} records` : null}
            statsError={stats.error}
          />
          <ContractCard
            name="NotarizedSettlement"
            address={SETTLEMENT_ADDRESS}
            role="Settlement. Registers an obligation, binds a notarization to it, and records who is owed what."
            methods="open_settlement · attach_notarization · refresh_verdict · settle · challenge · request_reevaluation · set_notary_trust · revoke_notary_trust · set_trust_warmup_hours · set_paused · get_settlement · get_settlements_paginated · get_pending_payouts · get_stats · get_notary_trust · get_trusted_notaries · get_contract_balance · outcome_for_verdict · check_binding · get_verdict_freshness"
            stats={
              settlements.data ? `${formatCount(settlements.data.total)} escrows` : null
            }
          />
        </div>
      </div>

      <div className="section">
        <div className="section__eyebrow">
          <span className="label">Known limitation on this network</span>
        </div>
        <div className="card">
          <p className="notice__body" style={{ maxWidth: '70ch' }}>
            Native value is not credited to Intelligent Contracts here. A payable method reading its own
            received amount gets zero, and the contract's native balance stays at zero even though
            account-to-account transfers work normally.
          </p>
          <p className="notice__body" style={{ maxWidth: '70ch', marginTop: 'var(--s-3)' }}>
            So settlements on this network reach a recorded decision but queue no payout. The logic is
            exercised; the movement of money is not. Real custody needs a network that credits value to
            contracts and enforces balances.
          </p>
        </div>
      </div>

      <div className="section">
        <div className="section__eyebrow">
          <span className="label">Build</span>
        </div>
        <KeyValue
          rows={[
            ['configuration', DEPLOYMENTS.configured ? 'addresses set' : 'addresses unset'],
            [
              'override with',
              <span className="hash">
                VITE_GENLAYER_NETWORK · VITE_GENLAYER_RPC · VITE_NOTARY_ADDRESS ·
                VITE_SETTLEMENT_ADDRESS
              </span>,
            ],
            ['reference', <Link to="/how-it-works">How it works</Link>],
          ]}
        />
      </div>
    </div>
  );
}

function ContractCard({
  name,
  address,
  role,
  methods,
  stats,
  statsError,
}: {
  name: string;
  address: string;
  role: string;
  methods: string;
  stats?: string | null;
  statsError?: { title: string; detail: string } | null;
}) {
  return (
    <div className="card">
      <div className="card__head">
        <div>
          <p className="label" style={{ marginBottom: 'var(--s-2)' }}>
            {name}
          </p>
          <span className="copyable">
            <a
              className="mono"
              href={explorerAddress(address)}
              target="_blank"
              rel="noreferrer noopener"
            >
              {address}
            </a>
            <CopyButton value={address} />
          </span>
        </div>
        {stats ? <span className="badge badge--brass">{stats}</span> : null}
      </div>
      <p style={{ fontSize: 'var(--t-small)', color: 'var(--ink-soft)', margin: '0 0 var(--s-3)' }}>
        {role}
      </p>
      <p className="hash" style={{ margin: 0 }}>
        {methods}
      </p>
      {statsError && (
        <p className="hash" style={{ marginTop: 'var(--s-3)', color: 'var(--oxblood)' }}>
          could not read stats: {statsError.title.toLowerCase()}
        </p>
      )}
    </div>
  );
}

function Inline({ value, href }: { value: string; href: string }) {
  return (
    <span className="copyable">
      <a className="mono" href={href} target="_blank" rel="noreferrer noopener">
        {value}
      </a>
      <CopyButton value={value} />
    </span>
  );
}

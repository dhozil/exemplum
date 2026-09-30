import { NavLink, Outlet, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { RPC_URL, EXPLORER_URL, CHAIN_NAME, contractsConfigured } from '../config';
import { ping } from '../lib/chain';
import { rateLimitedRecently } from '../lib/errors';
import { Guilloche } from './Guilloche';
import { ExemplumMark } from './ExemplumMark';
import { AccountControl } from './AccountButton';

const NAV = [
  { to: '/records', label: 'Records' },
  { to: '/notarize', label: 'Notarize' },
  { to: '/settlements', label: 'Settlements' },
  { to: '/trust', label: 'Trust list' },
  { to: '/how-it-works', label: 'How it works' },
  { to: '/network', label: 'Network' },
];

/**
 * How often the strip re-probes the node.
 *
 * The public StudioNet RPC allows a limited number of contract calls per hour
 * per IP, and this probe runs on every page. It uses the cheap block-number
 * call rather than a contract read, so it stays out of the contract-call
 * budget, and it runs at 60s rather than 30s and pauses while the tab is
 * hidden.
 */
const PROBE_INTERVAL_MS = 60_000;

function NetworkStrip() {
  const [state, setState] = useState<'checking' | 'up' | 'down' | 'limited'>('checking');

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      if (document.hidden) return;
      const ok = await ping();
      if (cancelled) return;
      /* "Reachable but refusing" is a distinct and very common state on a
         shared endpoint, and reporting it as "unreachable" sends people to
         debug their network instead of waiting. */
      setState(ok ? 'up' : rateLimitedRecently() ? 'limited' : 'down');
    };

    void check();
    const timer = window.setInterval(check, PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const LABEL: Record<typeof state, string> = {
    checking: 'checking node',
    up: 'node reachable',
    down: 'node unreachable',
    limited: 'node refusing reads',
  };

  return (
    <div className="netstrip">
      <div className="netstrip__inner">
        <span className="netstrip__item">
          <span
            className={`pulse ${
              state === 'down' || state === 'limited'
                ? 'pulse--down'
                : state === 'checking'
                  ? 'pulse--checking'
                  : ''
            }`}
            aria-hidden="true"
          />
          {LABEL[state]}
        </span>
        <span className="netstrip__item">{CHAIN_NAME}</span>
        {!contractsConfigured() && <span className="netstrip__item">no deployment configured</span>}
        <span className="spacer" />
        <a className="netstrip__item" href={EXPLORER_URL} target="_blank" rel="noreferrer noopener">
          explorer ↗
        </a>
        <a className="netstrip__item" href={RPC_URL} target="_blank" rel="noreferrer noopener">
          rpc ↗
        </a>
      </div>
    </div>
  );
}

export function AppShell() {
  return (
    <div className="shell">
      <header className="masthead">
        <div className="masthead__inner">
          <Link to="/" className="masthead__mark">
            <ExemplumMark size={32} />
            <span className="masthead__wordmark">Exemplum</span>
          </Link>
          <nav className="masthead__nav" aria-label="Main">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} className="masthead__link">
                {({ isActive }) => (
                  <span aria-current={isActive ? 'page' : undefined}>{item.label}</span>
                )}
                </NavLink>
              ))}
            </nav>
            <AccountControl />
          </div>
      </header>

      <NetworkStrip />

      <main className="shell__main">
        {/* Printed into the sheet, not laid on top of it.

            Two things keep it a watermark rather than a second ornament. The
            medallion is off, because a filled centre reads as a focal point and
            the seal is already the focal point of this interface. And the
            opacity is low enough that the headline is never fighting it — a
            real watermark is meant to be read *through*, so overlapping the text
            is correct, but only if it recedes. */}
        <div className="watermark" aria-hidden="true">
          <Guilloche
            size={780}
            opacity={0.026}
            layers={4}
            strokeWidth={0.4}
            rotate={14}
            medallion={false}
          />
        </div>
        <Outlet />
      </main>

      <footer className="footer">
        <div className="footer__inner">
          <div>
            <p className="footer__title">
              <ExemplumMark size={26} />
              Exemplum
            </p>
            <p className="footer__note">
              An attestation records that a committee of validators reached a documented conclusion from
              sources that were publicly reachable at a recorded time. It is evidence of observation, not
              a legal determination, and it says nothing about whether a source was honest when it was
              read.
            </p>
          </div>
          <div>
            <p className="label label--on-dark" style={{ marginBottom: 'var(--s-2)' }}>
              Registry
            </p>
            <Link to="/records">Notarisation records</Link>
            <Link to="/settlements">Settlements</Link>
            <Link to="/settlements/new">Open a settlement</Link>
            <Link to="/trust">Notary trust list</Link>
          </div>
          <div>
            <p className="label label--on-dark" style={{ marginBottom: 'var(--s-2)' }}>
              Reference
            </p>
            <Link to="/how-it-works">How it works</Link>
            <Link to="/network">Network and deployments</Link>
            <a href={EXPLORER_URL} target="_blank" rel="noreferrer noopener">
              GenLayer explorer ↗
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

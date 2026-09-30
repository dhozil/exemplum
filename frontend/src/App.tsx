import { Suspense, lazy } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import Landing from './pages/Landing';

/** genlayer-js pulls in viem and a full client, so routes are split rather than
 *  shipping every page in one chunk. The landing page is the common entry and
 *  stays in the main bundle. */
const HowItWorks = lazy(() => import('./pages/HowItWorks'));
const Notarize = lazy(() => import('./pages/Notarize'));
const Records = lazy(() => import('./pages/Records'));
const RecordDetail = lazy(() => import('./pages/RecordDetail'));
const Settlements = lazy(() => import('./pages/Settlements'));
const OpenSettlement = lazy(() => import('./pages/OpenSettlement'));
const SettlementDetail = lazy(() => import('./pages/SettlementDetail'));
const Trust = lazy(() => import('./pages/Trust'));
const Network = lazy(() => import('./pages/Network'));
const NotFound = lazy(() => import('./pages/NotFound'));

function RouteFallback() {
  return (
    <div className="docket">
      <div className="section" style={{ borderTop: 'none', paddingTop: 'var(--s-7)' }}>
        <p className="cluster" style={{ color: 'var(--ink-faint)', fontSize: 'var(--t-small)' }}>
          <span className="spinner" aria-hidden="true" />
          Loading…
        </p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<Landing />} />
              <Route
                path="/how-it-works"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <HowItWorks />
                  </Suspense>
                }
              />
              <Route
                path="/notarize"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <Notarize />
                  </Suspense>
                }
              />
              <Route
                path="/records"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <Records />
                  </Suspense>
                }
              />
              <Route
                path="/records/:id"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <RecordDetail />
                  </Suspense>
                }
              />
              <Route
                path="/settlements"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <Settlements />
                  </Suspense>
                }
              />
              {/* Declared before /settlements/:id so the intent reads in the order a
                  reader meets it; React Router ranks the static segment higher
                  regardless, so "new" is never parsed as an escrow number. */}
              <Route
                path="/settlements/new"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <OpenSettlement />
                  </Suspense>
                }
              />
              <Route
                path="/settlements/:id"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <SettlementDetail />
                  </Suspense>
                }
              />
              <Route
                path="/trust"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <Trust />
                  </Suspense>
                }
              />
              <Route
                path="/network"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <Network />
                  </Suspense>
                }
              />
              <Route
                path="*"
                element={
                  <Suspense fallback={<RouteFallback />}>
                    <NotFound />
                  </Suspense>
                }
              />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { describeError } from '../lib/errors';

/**
 * Last-resort boundary.
 *
 * A blank white screen is the worst outcome for a dApp that exists to be
 * believed, so a render failure says what happened and offers a way out.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Exemplum render failure', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const friendly = describeError(this.state.error);
      return (
        <div className="docket" style={{ paddingTop: 'var(--s-8)' }}>
          <div className="notice notice--danger" role="alert">
            <p className="notice__title">This page could not be drawn</p>
            <p className="notice__body">{friendly.detail}</p>
            <p className="notice__body">
              The data on chain is unaffected. Reloading usually clears it.
            </p>
            <p className="notice__body" style={{ marginTop: 'var(--s-3)' }}>
              <button type="button" className="btn btn--sm" onClick={() => window.location.reload()}>
                Reload
              </button>
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

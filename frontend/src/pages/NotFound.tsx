import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="docket">
      <div className="section" style={{ borderTop: 'none', textAlign: 'center', paddingTop: 'var(--s-9)' }}>
        <p className="label" style={{ marginBottom: 'var(--s-4)' }}>
          404 · nothing on the record
        </p>
        <h1 style={{ fontSize: 'var(--t-h1)', marginBottom: 'var(--s-4)' }}>
          That page does not exist.
        </h1>
        <p className="lede" style={{ margin: '0 auto var(--s-5)' }}>
          The link may be from an older build. Everything this app can show is reachable from the
          registry.
        </p>
        <div className="cluster" style={{ justifyContent: 'center' }}>
          <Link className="btn" to="/records">
            Browse records
          </Link>
          <Link className="btn btn--ghost" to="/">
            Back to the start
          </Link>
        </div>
      </div>
    </div>
  );
}

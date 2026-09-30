import { isUrl } from '../lib/format';
/**
 * The source list editor.
 *
 * Shared by the notarization form and the settlement form because the two have
 * to agree exactly: a settlement only accepts a notarization whose source list
 * matches its own, order included. One editor, one set of rules, so the two forms
 * cannot drift apart and quietly produce lists that will never bind.
 *
 * Validation lives with the caller. This component only owns the shape of the
 * list: how many rows there are, and the add/remove affordances.
 */
export function SourceEditor({
  value,
  onChange,
  min,
  max,
  errors,
  showErrors,
  label = 'Sources',
  hint,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  min: number;
  max: number;
  /** Indexed by row, as the caller numbers them. */
  errors?: Record<number, string>;
  showErrors?: boolean;
  label?: string;
  hint?: string;
}) {
  const distinct = new Set(value.map((s) => s.trim()).filter(Boolean));

  const setAt = (i: number, next: string) => {
    const copy = [...value];
    copy[i] = next;
    onChange(copy);
  };

  return (
    <div className="field">
      <span className="field__label" id="sources-label">
        {label}
      </span>
      <p className="field__hint" style={{ marginTop: 0, marginBottom: 'var(--s-3)' }}>
        {hint ?? (
          <>
            {distinct.size} of at least {min} distinct. Duplicate URLs do not count towards
            corroboration.
          </>
        )}
      </p>

      <div className="stack-sm" role="group" aria-labelledby="sources-label">
        {value.map((raw, i) => {
          const invalid = showErrors && (errors?.[i] !== undefined || !isUrl(raw.trim()));
          return (
            <div className="srcentry" key={i}>
              <div className="srcentry__head">
                <span className="label">source {String(i + 1).padStart(2, '0')}</span>
                {value.length > min && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => onChange(value.filter((_, idx) => idx !== i))}
                  >
                    Remove
                  </button>
                )}
              </div>
              <input
                className="input input--mono"
                value={raw}
                onChange={(e) => setAt(i, e.target.value)}
                placeholder="https://…"
                aria-label={`Source ${i + 1} URL`}
                aria-invalid={invalid}
                aria-describedby={showErrors && errors?.[i] ? `source-error-${i}` : undefined}
              />
              {showErrors && errors?.[i] && (
                <p className="field__error" id={`source-error-${i}`} style={{ margin: 0 }}>
                  {errors[i]}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {value.length < max && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          style={{ marginTop: 'var(--s-3)' }}
          onClick={() => onChange([...value, ''])}
        >
          Add another source
        </button>
      )}
    </div>
  );
}

import type { ElementType, ReactNode } from 'react';
import { useReveal } from '../lib/useReveal';

/**
 * Wraps content in a reveal-on-scroll container.
 *
 * Kept as a component rather than a hook at each call site because the class
 * string and the observer have to move together; splitting them across the
 * codebase is how pages end up with a `.reveal` that never gets `.is-shown`.
 */
export function Reveal({
  children,
  as: Tag = 'div',
  className = '',
  group = false,
}: {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  /** Staggers direct children as they arrive, for a row of cards. */
  group?: boolean;
}) {
  const { ref } = useReveal<HTMLDivElement>();

  return (
    <Tag ref={ref} className={`reveal ${group ? 'reveal-group' : ''} ${className}`.trim()}>
      {children}
    </Tag>
  );
}

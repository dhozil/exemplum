import { useEffect, useRef } from 'react';

const SHOWN = 'is-shown';

/**
 * Reveal-on-scroll, done without React state.
 *
 * A section starts 12px low and slightly transparent, then settles. It runs
 * exactly once per element: re-animating on every pass turns a page into a
 * slideshow, and by the time a reader scrolls back up they are looking for the
 * text, not watching it arrive again.
 *
 * This deliberately touches the DOM class directly rather than holding a
 * boolean in state. The concern is purely visual — nothing else in the tree
 * branches on whether an element has been revealed — so a state update would
 * buy nothing and cost a render of whatever contains it. It also removes the
 * real failure mode: an element whose state never flips is stuck at
 * `opacity: 0` forever, which is why the fallback below is not optional.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(
  options: { threshold?: number; once?: boolean; className?: string } = {},
) {
  const { threshold = 0.12, once = true, className = 'reveal' } = options;
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const show = () => node.classList.add(SHOWN);
    const hide = () => node.classList.remove(SHOWN);

    // If IntersectionObserver is missing, or the element is already within the
    // viewport when it mounts, show it at once. Content that never becomes
    // visible is a far worse outcome than content that does not animate.
    if (typeof IntersectionObserver === 'undefined') {
      show();
      return;
    }

    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      show();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            show();
            if (once) observer.unobserve(entry.target);
          } else if (!once) {
            hide();
          }
        }
      },
      { threshold, rootMargin: '0px 0px -8% 0px' },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, once]);

  return { ref, className };
}

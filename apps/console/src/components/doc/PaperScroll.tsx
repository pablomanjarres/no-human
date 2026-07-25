"use client";

import { useEffect, useRef } from "react";

/**
 * The scroll box the extracted page sits in.
 *
 * A judge arrives here from a page reference in the comparison table. The line
 * the value was read from has to already be on screen — hunting for it defeats
 * the point. On mount, and on every change of page or focused line, the
 * highlighted line is centred. No smooth scroll: it is a jump cut, so the line
 * is under the eye before the page has finished settling.
 */
export function PaperScroll({
  focusKey,
  className = "",
  label,
  children,
}: {
  /** Changes whenever the page or the focused line changes. */
  focusKey: string;
  className?: string;
  label: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const hit = root.querySelector<HTMLElement>('[data-hit="true"]');
    if (!hit) {
      root.scrollTop = 0;
      return;
    }
    const rootBox = root.getBoundingClientRect();
    const hitBox = hit.getBoundingClientRect();
    const delta = hitBox.top - rootBox.top - (root.clientHeight - hitBox.height) / 2;
    root.scrollTop = Math.max(0, root.scrollTop + delta);
  }, [focusKey]);

  return (
    <div
      ref={ref}
      // A scroll region needs to be reachable by keyboard, or the content below
      // the fold is unreadable without a mouse.
      tabIndex={0}
      role="region"
      aria-label={label}
      className={`min-h-0 overflow-y-auto ${className}`}
    >
      {children}
    </div>
  );
}

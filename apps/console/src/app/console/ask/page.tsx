import type { Metadata } from "next";
import Link from "next/link";

import { AskPanel } from "@/components/AskPanel";

export const metadata: Metadata = {
  title: "Application engineer — SICK Cross",
  description:
    "The one lane with a model in it. It reads the catalogue through the deterministic solver and prints every tool call it made, so the answer can be checked rather than trusted.",
};

/**
 * The live lane.
 *
 * Kept on its own route rather than folded into the workspace on purpose. The
 * workspace is deterministic and scrubbable — the same input replays the same
 * solve, frame for frame, which is what makes it demonstrable. A model turn is
 * none of those things. Mixing them would cost the workspace the property that
 * makes it worth showing, so the two lanes stay adjacent and honest about which
 * is which.
 */
export default function AskPage() {
  return (
    <main className="mx-auto flex h-dvh w-full max-w-[880px] flex-col px-5 py-7 lg:px-8 lg:py-10">
      <nav className="mb-6 shrink-0">
        <Link
          href="/console"
          className="inline-flex items-center gap-2 font-mono text-[11px] text-ink-faint transition-colors hover:text-sick focus-visible:text-sick"
        >
          <span aria-hidden>←</span>
          <span>Workspace</span>
        </Link>
      </nav>

      <header className="mb-6 shrink-0 border-b border-rail pb-6">
        <p className="eyebrow">Live lane · a model runs here</p>
        <h1 className="mt-2 font-display text-[26px] leading-[1.15] font-semibold tracking-[-0.01em] text-ink">
          Application engineer
        </h1>
        <p className="mt-3 max-w-[62ch] text-[13px] leading-[1.6] text-ink-dim">
          Everywhere else in this console the answer is computed and no model is involved. Here one
          is — but it reaches the catalogue only through the same deterministic tools, so it cannot
          name a part the index did not return. Every call it makes is printed above its answer.
        </p>
      </header>

      <div className="min-h-0 flex-1">
        <AskPanel />
      </div>
    </main>
  );
}

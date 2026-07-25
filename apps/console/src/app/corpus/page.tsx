import type { Metadata } from "next";
import Link from "next/link";

import { corpusStats } from "@/data/runs";
import { collectDisputes, collectFlagged } from "@/components/corpus/collect";
import { BrandCoverage } from "@/components/corpus/BrandCoverage";
import { DisputeLedger } from "@/components/corpus/DisputeLedger";
import { FlaggedRows } from "@/components/corpus/FlaggedRows";
import { MethodNote } from "@/components/corpus/MethodNote";
import { ReadoutStrip } from "@/components/corpus/ReadoutStrip";
import { groupDigits } from "@/components/corpus/format";

export const metadata: Metadata = {
  title: "Corpus — SICK Cross",
  description:
    "187 datasheet PDFs, 2 954 structured spec rows, 31 places the verifier disagreed with the extractor. The disputes are the proof the second pass ran.",
};

/**
 * The corpus board.
 *
 * Everything the engine says downstream is only as good as this index, so the
 * board reports the index the way an instrument reports a reading: the numbers,
 * the coverage, and — in the centre, in signal yellow — every place the system
 * caught itself. The dispute count is not an embarrassment to bury under a
 * confidence percentage. It is the measurement.
 */
export default function CorpusPage() {
  const disputes = collectDisputes();
  const flagged = collectFlagged();

  return (
    <main className="mx-auto w-full max-w-[1280px] px-5 py-7 lg:px-8 lg:py-10">
      <nav className="mb-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2 font-mono text-[11px] text-ink-faint transition-colors hover:text-sick focus-visible:text-sick"
        >
          <span aria-hidden>←</span>
          <span>Workspace</span>
        </Link>
      </nav>

      <header className="mb-7 border-b border-rail pb-7">
        <p className="eyebrow">Offline corpus · extraction index</p>
        <h1 className="nameplate mt-2.5 text-[clamp(1.75rem,4.2vw,2.75rem)] leading-[0.98] text-ink">
          The index everything else is read out of
        </h1>
        <p className="mt-4 max-w-[86ch] text-[14px] leading-[1.7] text-ink-dim">
          An extraction swarm ran at{" "}
          <span className="font-mono text-ink">{corpusStats.extractedAt}</span> against{" "}
          <span className="font-mono text-ink">{groupDigits(corpusStats.datasheets)}</span> datasheet
          PDFs sitting on local disk and turned them into{" "}
          <span className="font-mono text-ink">{groupDigits(corpusStats.specRows)}</span> structured
          spec rows. A second agent then re-read every one of those rows against its source page and
          disagreed with the extractor{" "}
          <span className="font-mono text-signal">{groupDigits(corpusStats.disputes)}</span> times.
        </p>
        <p className="mt-3 max-w-[86ch] text-[14px] leading-[1.7] text-ink-dim">
          Those {groupDigits(corpusStats.disputes)} disagreements are on this page, in full, with
          both readings intact. They are the reason to believe the rest of it.
        </p>
      </header>

      <div className="flex flex-col gap-5">
        <ReadoutStrip stats={corpusStats} />
        <BrandCoverage stats={corpusStats} />
        <DisputeLedger rows={disputes} totalDisputes={corpusStats.disputes} />
        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <MethodNote stats={corpusStats} />
          <FlaggedRows rows={flagged} totalLow={corpusStats.lowConfidence} />
        </div>
      </div>

      <footer className="mt-8 border-t border-rail pt-5">
        <p className="max-w-[86ch] text-[12px] leading-[1.65] text-ink-faint">
          Nothing on this page was computed at request time. The index is a build artefact: it is
          rebuilt when the PDF store changes, and the console reads it. If a value is not in it, the
          console says so and refuses — it does not fall back to a model.
        </p>
      </footer>
    </main>
  );
}

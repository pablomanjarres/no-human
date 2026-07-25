import Link from "next/link";
import type { CorpusStats } from "@/lib/types";

/** A hairline between two readouts. Cab-600 rather than the 700 hairline: on a
 *  white strip the lighter divider disappears entirely. */
function Divider() {
  return <span className="w-px shrink-0 self-stretch bg-cab-600" aria-hidden />;
}

function Readout({
  label,
  value,
  unit,
  tone = "ink",
  marked = false,
  title,
}: {
  label: string;
  value: string;
  unit?: string;
  /** Amber is caution. It is the dark amber token — never the safety yellow, which
   *  is a fill colour and would sit at 1.7:1 as text. */
  tone?: "ink" | "signal";
  /** Wash the cell so one number owns the strip without shouting in yellow. */
  marked?: boolean;
  title?: string;
}) {
  return (
    <div
      className={`flex shrink-0 flex-col gap-[1px] px-3 ${
        marked ? "-my-1 rounded-[3px] bg-signal-wash py-1 ring-1 ring-signal-bright/60" : ""
      }`}
      title={title}
    >
      <span className="eyebrow leading-none">{label}</span>
      <span className="flex items-baseline gap-1 leading-none">
        <span
          className={`font-mono text-[15px] tabular-nums leading-none ${
            tone === "signal" ? "text-signal" : "text-ink"
          }`}
        >
          {value}
        </span>
        {unit ? <span className="font-mono text-[9.5px] text-ink-faint">{unit}</span> : null}
      </span>
    </div>
  );
}

/**
 * Corpus telemetry. The extraction swarm ran offline; this strip is the evidence.
 * The dispute count is deliberately the one cell that is washed and ringed — a
 * verifier that never disagrees is a verifier that is not running. On white it
 * earns that with an amber tint behind it, not with a brighter typeface colour.
 */
export function TelemetryRail({ stats }: { stats: CorpusStats }) {
  const minutes = Math.round(stats.runtimeMs / 60000);

  return (
    <header className="flex shrink-0 items-stretch gap-0 border-b border-rail bg-cab-900">
      <Link
        href="/"
        className="group flex shrink-0 items-center gap-2.5 border-r border-rail px-3 py-2.5 sm:px-4"
        title="Back to sick.com"
      >
        <span className="block h-[18px] w-[3px] bg-sick" aria-hidden />
        <div className="leading-none">
          <span className="nameplate block text-[15px] leading-none text-ink transition-colors group-hover:text-sick">
            SICK Cross
          </span>
          <span className="eyebrow mt-[3px] hidden leading-none sm:block">
            Cross-brand equivalence engine
          </span>
        </div>
      </Link>

      <div className="flex min-w-0 flex-1 items-center overflow-x-auto py-2 [scrollbar-width:none]">
        <Readout label="Datasheets" value={String(stats.datasheets)} title="PDFs cached in the offline corpus" />
        <Divider />
        <Readout label="Spec rows" value={stats.specRows.toLocaleString("en-US")} title="Structured rows produced by the extraction swarm" />
        <Divider />
        <Readout
          label="Verifier disputes"
          value={String(stats.disputes)}
          tone="signal"
          marked
          title="Rows where the verifier disagreed with the extractor. Flagged, never averaged."
        />
        <Divider />
        <Readout
          label="Low confidence"
          value={String(stats.lowConfidence)}
          tone="signal"
          title="Rows the extraction pass could not read cleanly"
        />
        <Divider />
        <Readout label="Brands" value={String(stats.brands.length)} title={stats.brands.map((b) => b.name).join(" · ")} />
        <Divider />
        <Readout label="Swarm runtime" value={String(minutes)} unit="min" title={`Extraction swarm started ${stats.extractedAt}`} />
      </div>

      <div className="flex shrink-0 items-center gap-2.5 border-l border-rail px-2.5 sm:gap-3 sm:px-3.5">
        <span
          className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-faint"
          title="Nothing is fetched at request time. The demo runs with no network."
        >
          {/* Indicator lamp: a solid blue pip in a pale blue halo, so a 6px dot
              still registers against white. */}
          <span
            className="block h-1.5 w-1.5 shrink-0 rounded-full bg-sick ring-[3px] ring-sick-wash"
            aria-hidden
          />
          Offline
        </span>
        <Link
          href="/console/corpus"
          className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:text-sick"
        >
          Corpus →
        </Link>
      </div>
    </header>
  );
}

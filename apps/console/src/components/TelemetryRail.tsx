import Link from "next/link";
import type { CorpusStats } from "@/lib/types";

function Readout({
  label,
  value,
  unit,
  accent,
  title,
}: {
  label: string;
  value: string;
  unit?: string;
  accent?: string;
  title?: string;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-[1px] px-3" title={title}>
      <span className="eyebrow leading-none">{label}</span>
      <span className="flex items-baseline gap-1 leading-none">
        <span
          className="font-mono text-[15px] tabular-nums leading-none"
          style={{ color: accent ?? "var(--color-ink)" }}
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
 * The dispute count is deliberately the brightest number on the bar — a verifier
 * that never disagrees is a verifier that is not running.
 */
export function TelemetryRail({ stats }: { stats: CorpusStats }) {
  const minutes = Math.round(stats.runtimeMs / 60000);

  return (
    <header className="flex shrink-0 items-stretch gap-0 border-b border-rail bg-cab-900">
      <div className="flex shrink-0 items-center gap-2.5 border-r border-rail px-4 py-2.5">
        <span
          className="block h-[18px] w-[3px]"
          style={{ background: "var(--color-sick)" }}
          aria-hidden
        />
        <div className="leading-none">
          <span className="nameplate block text-[15px] leading-none text-ink">SICK Cross</span>
          <span className="eyebrow mt-[3px] block leading-none">Cross-brand equivalence engine</span>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center overflow-x-auto py-2 [scrollbar-width:none]">
        <Readout label="Datasheets" value={String(stats.datasheets)} title="PDFs cached in the offline corpus" />
        <span className="w-px shrink-0 self-stretch bg-cab-700" aria-hidden />
        <Readout label="Spec rows" value={stats.specRows.toLocaleString("en-US")} title="Structured rows produced by the extraction swarm" />
        <span className="w-px shrink-0 self-stretch bg-cab-700" aria-hidden />
        <Readout
          label="Verifier disputes"
          value={String(stats.disputes)}
          accent="var(--color-signal)"
          title="Rows where the verifier disagreed with the extractor. Flagged, never averaged."
        />
        <span className="w-px shrink-0 self-stretch bg-cab-700" aria-hidden />
        <Readout
          label="Low confidence"
          value={String(stats.lowConfidence)}
          accent="var(--color-signal)"
          title="Rows the extraction pass could not read cleanly"
        />
        <span className="w-px shrink-0 self-stretch bg-cab-700" aria-hidden />
        <Readout label="Brands" value={String(stats.brands.length)} title={stats.brands.map((b) => b.name).join(" · ")} />
        <span className="w-px shrink-0 self-stretch bg-cab-700" aria-hidden />
        <Readout label="Swarm runtime" value={String(minutes)} unit="min" title={`Extraction swarm started ${stats.extractedAt}`} />
      </div>

      <div className="flex shrink-0 items-center gap-3 border-l border-rail px-3.5">
        <span
          className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-faint"
          title="Nothing is fetched at request time. The demo runs with no network."
        >
          <span
            className="block h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--color-sick)" }}
            aria-hidden
          />
          Offline
        </span>
        <Link
          href="/corpus"
          className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:text-sick"
        >
          Corpus →
        </Link>
      </div>
    </header>
  );
}

import { Chip, Panel, PanelHead } from "@/components/primitives";
import { groupDigits, perDocSeconds, runtimeMinutes } from "@/components/corpus/format";
import type { CorpusStats } from "@/lib/types";

/**
 * The headline numbers, rendered as a readout — one strip, hairline seams, values
 * at the scale their importance earns. Not four identical cards: a card grid says
 * "dashboard", and this run was an instrument reading, not a KPI report.
 *
 * The disputes channel is the one the eye is supposed to land on. It is marked in
 * signal yellow and given twice the width, because a verifier that never disagrees
 * is a verifier that never ran.
 */

interface Channel {
  index: string;
  label: string;
  value: string;
  unit: string;
  gloss: string;
  marked: boolean;
  span: string;
  size: string;
}

/** A ruler, not a divider. Major ticks full height, minor ticks hung off the bottom. */
function Graticule() {
  return (
    <div
      aria-hidden
      className="h-[9px] shrink-0 border-b border-rail bg-cab-950"
      style={{
        backgroundImage:
          "repeating-linear-gradient(90deg, var(--color-rail) 0 1px, transparent 1px 60px), repeating-linear-gradient(90deg, var(--color-cab-600) 0 1px, transparent 1px 12px)",
        backgroundSize: "100% 9px, 100% 4px",
        backgroundPosition: "0 0, 0 100%",
        backgroundRepeat: "repeat-x, repeat-x",
      }}
    />
  );
}

export function ReadoutStrip({ stats }: { stats: CorpusStats }) {
  const channels: Channel[] = [
    {
      index: "01",
      label: "Datasheets",
      value: groupDigits(stats.datasheets),
      unit: "PDF",
      gloss: "Read off local disk. No vendor API was called.",
      marked: false,
      span: "",
      size: "text-[30px]",
    },
    {
      index: "02",
      label: "Spec rows",
      value: groupDigits(stats.specRows),
      unit: "rows",
      gloss: "Structured, typed, each one carrying a page reference.",
      marked: false,
      span: "",
      size: "text-[30px]",
    },
    {
      index: "03",
      label: "Disputes",
      value: groupDigits(stats.disputes),
      unit: "rows",
      gloss: "The verifier re-read the source and disagreed with the extractor. Held open, never averaged.",
      marked: true,
      span: "col-span-2",
      size: "text-[46px]",
    },
    {
      index: "04",
      label: "Low conf.",
      value: groupDigits(stats.lowConfidence),
      unit: "rows",
      gloss: "Rows flagged at extraction. The solver will not treat one as settled.",
      marked: false,
      span: "",
      size: "text-[30px]",
    },
    {
      index: "05",
      label: "Wall clock",
      value: runtimeMinutes(stats.runtimeMs),
      unit: "min",
      gloss: `${perDocSeconds(stats.runtimeMs, stats.datasheets)} s per datasheet, end to end.`,
      marked: false,
      span: "",
      size: "text-[30px]",
    },
    {
      index: "06",
      label: "Extracted",
      value: stats.extractedAt,
      unit: "local",
      gloss: "Ran before the demo, offline. Nothing here is generated at request time.",
      marked: false,
      span: "col-span-2 lg:col-span-1",
      size: "text-[30px]",
    },
  ];

  return (
    <Panel aria-labelledby="readout-heading">
      <PanelHead
        eyebrow="Extraction readout"
        title={`swarm · ${stats.extractedAt} · offline`}
        right={<Chip accent="sick">NO NETWORK</Chip>}
      />
      <Graticule />
      <h2 id="readout-heading" className="sr-only">
        Extraction readout
      </h2>
      <div className="grid grid-cols-2 gap-px bg-rail md:grid-cols-4 lg:grid-cols-7">
        {channels.map((c) => (
          <div
            key={c.index}
            className={`relative min-w-0 px-4 pb-4 pt-3.5 ${c.marked ? "bg-cab-850" : "bg-cab-900"} ${c.span}`}
          >
            {c.marked ? (
              <span aria-hidden className="absolute inset-x-0 top-0 block h-[2px] bg-signal" />
            ) : null}
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[9px] leading-none text-ink-faint">{c.index}</span>
              <span className="eyebrow leading-none">{c.label}</span>
            </div>
            <p className="mt-2.5 flex items-baseline gap-1.5">
              <span
                className={`font-mono font-medium leading-none tabular-nums ${c.size} ${
                  c.marked ? "text-signal" : "text-ink"
                }`}
              >
                {c.value}
              </span>
              <span className="font-mono text-[10px] leading-none text-ink-faint">{c.unit}</span>
            </p>
            <p
              className={`mt-2.5 text-[11px] leading-[1.45] ${
                c.marked ? "max-w-[34ch] text-ink-dim" : "text-ink-faint"
              }`}
            >
              {c.gloss}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

import Link from "next/link";

import { BrandMark, Chip, Panel, PanelHead } from "@/components/primitives";
import { corpusStats } from "@/data/runs";
import type { Part } from "@/lib/types";

/**
 * The reason this page exists.
 *
 * A manufacturer's own product page lists what a part does. It will never list
 * whose business it takes. This section does — and every entry is a live handle:
 * open one and the solver re-derives the match against this part's spec vector,
 * row by row, citing the competitor's datasheet and ours.
 */

interface Rival {
  brand: string;
  family: string;
  /** A real part number from that family — what the workspace gets handed. */
  probe: string;
  note: string;
}

const RIVALS: Record<string, Rival> = {
  "Banner QS18 series": {
    brand: "Banner",
    family: "QS18",
    probe: "QS18VN6LV",
    note: "The workhorse diffuse sensor on packaging lines across the region. Same M12 4-pin footprint, same NPN sinking output. The range figure is where it bites — Banner quotes 400 mm against a 90 % white card, and most of these are pointed at something darker.",
  },
  "Banner Q45 series": {
    brand: "Banner",
    family: "Q45",
    probe: "Q45BB6LV",
    note: "Larger housing, longer optical budget, usually mounted where panel width was never the constraint. Migrating off it frees width rather than costing it.",
  },
  "Keyence PZ-G series": {
    brand: "Keyence",
    family: "PZ-G",
    probe: "PZ-G51N",
    note: "Sold with its own output polarity and teach behaviour. Check the installed input card before the swap — that is the row that decides it, not the range.",
  },
  "Pepperl+Fuchs OBT series": {
    brand: "Pepperl+Fuchs",
    family: "OBT",
    probe: "OBT300-R100-2EP-IO-V31",
    note: "Carries IO-Link. If the master is already wired and reading process data, say so before ordering — that changes the constraint set, not just the part.",
  },
  "Pepperl+Fuchs ML100 series": {
    brand: "Pepperl+Fuchs",
    family: "ML100",
    probe: "ML100-8-1000-RT/95/103",
    note: "Retroreflective, and the model key almost always carries appended option codes. Where those codes are not in the corpus the run ends in a refusal rather than a guess.",
  },
};

const KNOWN_BRANDS = ["Pepperl+Fuchs", "Banner", "Keyence", "Omron", "Datalogic", "IFM"];

function parseRival(label: string): Rival {
  const known = RIVALS[label];
  if (known) return known;
  const brand = KNOWN_BRANDS.find((b) => label.toLowerCase().startsWith(b.toLowerCase()));
  const head = brand ?? label.split(" ")[0] ?? label;
  const family =
    label
      .slice(head.length)
      .replace(/series\s*$/i, "")
      .trim() || label;
  return {
    brand: head,
    family,
    probe: family,
    note: "Recorded in the corpus as a documented replacement. Open it to see the row-by-row solve.",
  };
}

export function ReplacesPanel({ part }: { part: Part }) {
  const labels = part.replaces ?? [];

  if (labels.length === 0) {
    return (
      <Panel>
        <PanelHead eyebrow="02 · Cross-reference" title="documented replacements" />
        <div className="px-5 py-6 sm:px-6">
          <h2 className="nameplate text-[clamp(1.4rem,3vw,2rem)] leading-none">Replaces</h2>
          <p className="mt-3 max-w-[64ch] text-[13px] leading-[1.6] text-ink-dim">
            No competitor family is recorded against this part in the corpus. That is an absence of
            evidence, not a claim of uniqueness — hand the workspace a competitor part number and it
            will solve it from the spec vector directly.
          </p>
        </div>
      </Panel>
    );
  }

  const rivals = labels.map(parseRival);

  return (
    <Panel style={{ animationDelay: "60ms" }} className="anim-in">
      {/* This panel gets the blue edge. It is the primary claim on the page. */}
      <div className="h-[3px] w-full shrink-0 bg-sick" aria-hidden />

      <PanelHead
        eyebrow="02 · Cross-reference"
        title="competitor families this part takes out"
        right={<Chip accent="sick">{corpusStats.datasheets} datasheets indexed</Chip>}
      />

      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 border-b border-rail px-5 py-6 sm:px-6 sm:py-7">
        <div className="min-w-0">
          <h2 className="nameplate text-[clamp(1.9rem,4.6vw,3rem)] leading-[0.88]">Replaces</h2>
          <p className="mt-3.5 max-w-[62ch] text-[13.5px] leading-[1.6] text-ink-dim">
            Competitor families this part is a documented replacement for. Each one resolves against
            the spec vector on this page — parameter by parameter, both datasheets cited. Open one
            and the solver runs it in front of you, or tells you it cannot.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <span className="eyebrow">Families displaced</span>
          <p className="mt-1.5 font-mono text-[46px] font-semibold leading-[0.8] tracking-[-0.02em] text-sick tabular-nums">
            {String(rivals.length).padStart(2, "0")}
          </p>
        </div>
      </div>

      <ul className="flex flex-col">
        {rivals.map((r, i) => (
          <li key={`${r.brand}-${r.family}`} className="border-b border-rail last:border-b-0">
            <Link
              href={`/console?q=${encodeURIComponent(r.probe)}`}
              className="group grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-2 gap-y-3 border-l-[3px] border-l-cab-600 px-4 py-5 transition-colors duration-150 hover:border-l-sick hover:bg-sick-wash focus-visible:border-l-sick focus-visible:bg-sick-wash sm:grid-cols-[2.25rem_minmax(0,1fr)_auto] sm:gap-x-4 sm:px-5"
            >
              <span className="mt-1 font-mono text-[11px] leading-none text-ink-faint tabular-nums transition-colors group-hover:text-sick">
                {String(i + 1).padStart(2, "0")}
              </span>

              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <BrandMark brand={r.brand} />
                  <span className="font-mono text-[10px] text-ink-faint">{r.probe}</span>
                </div>

                <p className="nameplate mt-2 text-[clamp(1.15rem,2.6vw,1.75rem)] leading-none transition-colors group-hover:text-sick-bright">
                  {r.family} <span className="text-ink-faint">series</span>
                </p>

                <p className="mt-2.5 max-w-[70ch] text-[12.5px] leading-[1.6] text-ink-dim">
                  {r.note}
                </p>
              </div>

              <span className="eyebrow col-start-2 mt-0.5 shrink-0 whitespace-nowrap transition-colors group-hover:text-sick group-focus-visible:text-sick sm:col-start-3 sm:text-right">
                Run equivalence{" "}
                <span
                  aria-hidden
                  className="inline-block transition-transform duration-150 group-hover:translate-x-1"
                >
                  →
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <p className="border-t border-rail bg-cab-850 px-5 py-4 text-[12.5px] leading-[1.65] text-ink-dim sm:px-6">
        <span className="eyebrow mr-2.5">Why this list exists</span>
        No manufacturer publishes a cross-reference for somebody else&rsquo;s catalogue, and the
        spreadsheets that circulate instead carry no sources. This one is checkable: open a family
        and every row of the comparison carries the datasheet page it was read from — or the run
        ends in a refusal and says which constraint it could not defend.
      </p>
    </Panel>
  );
}

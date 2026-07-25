"use client";

import { Fragment, useState } from "react";

import { BrandMark, CiteLink, ConfidenceMark, Panel, PanelHead } from "@/components/primitives";
import { corpusStats } from "@/data/runs";
import type { Citation, Dispute, Part } from "@/lib/types";

/**
 * The specification, and the audit of it.
 *
 * Two things are load-bearing here. First: every value carries the page it was
 * read from, and clicking that page shows the exact line — grounding you can
 * read, not a claim that grounding exists. Second: where the extraction pass and
 * the verification pass disagreed, both readings stay on the page. They are never
 * averaged and the row is never dropped. A disputed row is the system reporting
 * what it found in the source, which is the whole product working.
 */

function Readout({ label, value, accent }: { label: string; value: number; accent: boolean }) {
  return (
    <div>
      <dt className="eyebrow whitespace-nowrap">{label}</dt>
      <dd
        className="mt-1.5 font-mono text-[19px] font-semibold leading-none tabular-nums"
        style={{ color: accent ? "var(--color-signal)" : "var(--color-ink)" }}
      >
        {String(value).padStart(2, "0")}
      </dd>
    </div>
  );
}

function DisputePair({ dispute }: { dispute: Dispute }) {
  return (
    <div className="flex flex-wrap gap-2">
      <div className="min-w-[8.5rem] flex-1 rounded-[2px] border border-rail bg-cab-850 px-2.5 py-1.5">
        <span className="eyebrow">Extracted</span>
        <p className="mt-1 font-mono text-[13px] leading-tight text-ink-dim line-through decoration-cab-600">
          {dispute.extracted}
        </p>
      </div>
      <div className="min-w-[8.5rem] flex-1 rounded-[2px] border border-signal bg-signal-wash px-2.5 py-1.5">
        <span className="eyebrow text-signal">Verified</span>
        <p className="mt-1 font-mono text-[13px] leading-tight text-signal-bright">{dispute.verified}</p>
      </div>
    </div>
  );
}

export function SpecTable({ part }: { part: Part }) {
  const [open, setOpen] = useState<Citation | null>(null);

  const disputed = part.specs.filter((s) => s.dispute !== undefined).length;
  const belowHigh = part.specs.filter((s) => s.confidence !== "high").length;
  const doc = part.specs[0]?.citation;

  return (
    <Panel>
      <PanelHead
        eyebrow="03 · Specification"
        {...(doc ? { title: doc.docTitle } : {})}
        right={
          <span className="shrink-0 font-mono text-[10px] whitespace-nowrap text-ink-faint">
            {part.brand} · {part.partNumber}
          </span>
        }
      />

      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 border-b border-rail px-4 py-5 sm:px-5">
        <div className="min-w-0">
          <h2 className="nameplate text-[clamp(1.15rem,2.6vw,1.65rem)] leading-none">Specification</h2>
          <p className="mt-2.5 max-w-[66ch] text-[12.5px] leading-[1.6] text-ink-dim">
            Each row is one value read out of one datasheet page, not a summary of it. Click a page
            reference to see the line it came from.
          </p>
        </div>
        <dl className="flex shrink-0 gap-6">
          <Readout label="Rows" value={part.specs.length} accent={false} />
          <Readout label="Disputed" value={disputed} accent={disputed > 0} />
          <Readout label="Below high" value={belowHigh} accent={belowHigh > 0} />
        </dl>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] border-collapse text-left">
          <caption className="sr-only">
            Full specification for {part.brand} {part.partNumber}, read from {doc?.docTitle ?? "the offline corpus"}.
            Each row carries the datasheet page the value was read from.
          </caption>
          <thead>
            <tr className="border-b border-rail bg-cab-850">
              <th scope="col" className="eyebrow px-4 py-2.5">
                Parameter
              </th>
              <th scope="col" className="eyebrow px-4 py-2.5">
                Value
              </th>
              <th scope="col" className="eyebrow px-4 py-2.5">
                Unit
              </th>
              <th scope="col" className="eyebrow px-4 py-2.5 text-right">
                Source
              </th>
            </tr>
          </thead>
          <tbody>
            {part.specs.map((s) => {
              const d = s.dispute;
              return (
                <Fragment key={s.key}>
                  <tr
                    className={
                      d
                        ? "bg-signal-wash"
                        : "border-b border-cab-800 transition-colors hover:bg-cab-850"
                    }
                  >
                    <th
                      scope="row"
                      className="px-4 py-3 align-top text-[13px] leading-snug font-normal text-ink-dim"
                      style={d ? { borderLeft: "3px solid var(--color-signal)" } : undefined}
                    >
                      {s.label}
                    </th>
                    <td className="px-4 py-3 align-top">
                      {d ? (
                        <DisputePair dispute={d} />
                      ) : (
                        <span className="font-mono text-[13px] leading-snug text-ink">{s.value}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top font-mono text-[11px] whitespace-nowrap text-ink-faint">
                      {s.unit}
                    </td>
                    <td className="px-4 py-3 text-right align-top">
                      <span className="inline-flex items-center gap-2">
                        <ConfidenceMark confidence={s.confidence} />
                        <CiteLink citation={s.citation} onOpen={setOpen} />
                      </span>
                    </td>
                  </tr>

                  {d ? (
                    <tr className="border-b border-cab-800 bg-signal-wash">
                      <td
                        colSpan={4}
                        className="px-4 pt-0 pb-3.5 text-[12.5px] leading-[1.6] text-ink-dim"
                        style={{ borderLeft: "3px solid var(--color-signal)" }}
                      >
                        <span className="eyebrow mr-2.5 text-signal">Open dispute</span>
                        {d.note}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Grounding, shown rather than asserted. */}
      <div className="border-t border-rail bg-cab-850 px-4 py-3 sm:px-5" aria-live="polite">
        {open ? (
          <div className="flex items-start gap-3">
            <span className="mt-[5px] h-[9px] w-[9px] shrink-0 bg-sick" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <BrandMark brand={open.brand} />
                <span className="font-mono text-[11px] text-ink-dim">{open.docTitle}</span>
                <span className="font-mono text-[11px] text-ink-faint">p.{open.page}</span>
              </div>
              {open.snippet ? (
                <p className="mt-2 border-l-2 border-cab-600 pl-3 font-mono text-[12px] leading-[1.65] text-ink">
                  &ldquo;{open.snippet}&rdquo;
                </p>
              ) : null}
              <p className="mt-2 font-mono text-[10px] text-ink-faint">{open.href}</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(null)}
              aria-label="Close source line"
              className="shrink-0 rounded-[2px] border border-rail px-2 py-1 font-mono text-[11px] leading-none text-ink-faint transition-colors hover:border-rail-bright hover:text-ink"
            >
              ×
            </button>
          </div>
        ) : (
          <p className="font-mono text-[11px] text-ink-faint">
            Select a page reference to read the exact line the value was taken from.
          </p>
        )}
      </div>

      <p className="border-t border-rail px-4 py-4 text-[12.5px] leading-[1.65] text-ink-dim sm:px-5">
        <span className="eyebrow mr-2.5">On disputed rows</span>
        Two passes read every datasheet: one extracts, one verifies. Where they disagree, both
        readings stay on the page with the reason, accented in yellow. Nothing is averaged and nothing
        is quietly dropped — a disputed row is the system telling you the source is ambiguous, which is
        the only honest thing to do with a number you are about to order against. Across the corpus{" "}
        <span className="font-mono text-ink">{corpusStats.disputes}</span> rows are open disputes and{" "}
        <span className="font-mono text-ink">{corpusStats.lowConfidence}</span> sit below high
        confidence. On this part:{" "}
        <span className="font-mono text-ink">
          {disputed} disputed, {belowHigh} below high
        </span>
        .
      </p>
    </Panel>
  );
}

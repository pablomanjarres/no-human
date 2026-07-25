import { BrandMark, Chip, ConfidenceMark, Panel, PanelHead } from "@/components/primitives";
import { CiteJump } from "@/components/doc/CiteJump";
import { groupDigits } from "@/components/corpus/format";
import type { FlaggedRow } from "@/components/corpus/collect";

/**
 * The rows that did not come out of extraction settled.
 *
 * A disputed row lands here by construction — confidence drops the moment the
 * verifier contradicts the extractor. So do the rows where the corpus simply has
 * no page: the two ML100 option codes are the reason that solve ends in a refusal
 * instead of a plausible guess.
 */

export function FlaggedRows({ rows, totalLow }: { rows: FlaggedRow[]; totalLow: number }) {
  return (
    <Panel aria-labelledby="flagged-heading" className="min-w-0">
      <PanelHead
        eyebrow="Flagged rows"
        title={`${groupDigits(rows.length)} in the loaded runs`}
        right={<Chip accent="rail">BELOW FULL CONFIDENCE</Chip>}
      />
      <h2 id="flagged-heading" className="sr-only">
        Rows below full confidence
      </h2>

      <ul className="min-w-0">
        {rows.map((row) => (
          <li key={row.id} className="border-b border-cab-700 px-4 py-3.5 last:border-b-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2">
                <BrandMark brand={row.part.brand} />
                <span className="truncate font-mono text-[11px] text-ink-dim">
                  {row.part.partNumber}
                </span>
              </span>
              <ConfidenceMark confidence={row.confidence} />
            </div>

            <div className="mt-2 flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-[12px] leading-snug text-ink">{row.field}</span>
              <CiteJump citation={row.citation} href={row.citation.href} />
            </div>

            <p className="mt-1 font-mono text-[11px] leading-snug text-ink-dim">
              {row.value}
              {row.unit === "—" ? "" : ` ${row.unit}`}
            </p>

            {row.disputed ? (
              <p className="mt-1.5 text-[11px] leading-[1.5] text-ink-faint">
                Dropped here by the verifier disagreeing. Both readings are in the ledger above.
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <footer className="border-t border-rail bg-cab-850 px-4 py-3.5">
        <p className="text-[12px] leading-[1.65] text-ink-dim">
          <span className="font-mono text-ink">{groupDigits(totalLow)}</span> rows across the index
          sit below full confidence;{" "}
          <span className="font-mono text-ink">{groupDigits(rows.length)}</span> of them belong to
          parts the loaded runs read. Nothing here is rounded up to a plausible number. A row the
          corpus cannot ground says so, and a solve that turns on one refuses rather than guessing.
        </p>
      </footer>
    </Panel>
  );
}

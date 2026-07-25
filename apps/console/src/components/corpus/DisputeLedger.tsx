import { BrandMark, Chip, ConfidenceMark, Housing, Panel, PanelHead } from "@/components/primitives";
import { CiteJump } from "@/components/doc/CiteJump";
import { groupDigits } from "@/components/corpus/format";
import type { DisputeRow } from "@/components/corpus/collect";
import type { Part } from "@/lib/types";

/**
 * The dispute ledger.
 *
 * Every row here is a place where the second pass contradicted the first. The
 * ledger exists because the alternative — quietly picking one reading, or worse,
 * averaging two — produces a number that appears on no datasheet page and cannot
 * be cited. Both readings stay. The row is marked. A human closes it.
 */

function uniqueParts(rows: DisputeRow[]): Part[] {
  const seen = new Map<string, Part>();
  for (const row of rows) if (!seen.has(row.part.id)) seen.set(row.part.id, row.part);
  return [...seen.values()];
}

export function DisputeLedger({ rows, totalDisputes }: { rows: DisputeRow[]; totalDisputes: number }) {
  const shown = rows.length;
  const elsewhere = Math.max(totalDisputes - shown, 0);
  const parts = uniqueParts(rows);

  return (
    <Panel aria-labelledby="ledger-heading">
      <PanelHead
        eyebrow="Dispute ledger"
        title={`${groupDigits(totalDisputes)} open in the index · ${groupDigits(shown)} on parts the loaded runs read`}
        right={<Chip accent="signal">VERIFIER ≠ EXTRACTOR</Chip>}
      />
      <h2 id="ledger-heading" className="sr-only">
        Dispute ledger
      </h2>

      <div className="border-b border-rail bg-cab-850 px-4 py-3.5">
        <p className="max-w-[104ch] text-[13px] leading-[1.65] text-ink-dim">
          A verifier agent re-read every extracted row against the page it was lifted from and
          disagreed with the extractor{" "}
          <span className="font-mono text-signal">{groupDigits(totalDisputes)}</span> times. That
          count is the only evidence the second pass did any work — a verifier that always agrees is
          a verifier nobody ran. Each disagreement is held open: both readings stay on the row, the
          row drops below full confidence, and neither is promoted into a figure no datasheet
          prints.
        </p>
      </div>

      {shown === 0 ? (
        <p className="px-4 py-6 text-[12px] text-ink-faint">
          No disputed row belongs to a part the loaded runs read.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr className="border-b border-rail">
                <th scope="col" className="eyebrow w-[15%] px-4 py-2">
                  Part
                </th>
                <th scope="col" className="eyebrow w-[13%] px-4 py-2">
                  Field
                </th>
                <th scope="col" className="eyebrow w-[14%] px-4 py-2">
                  Extractor read
                </th>
                <th scope="col" className="px-1 py-2">
                  <span className="sr-only">Disagreement</span>
                </th>
                <th scope="col" className="eyebrow w-[14%] px-4 py-2">
                  Verifier read
                </th>
                <th scope="col" className="eyebrow w-[28%] px-4 py-2">
                  Why it stays open
                </th>
                <th scope="col" className="eyebrow w-[16%] px-4 py-2">
                  Source
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-cab-700 last:border-b-0 align-top">
                  <th scope="row" className="px-4 py-4 text-left font-normal">
                    <span className="flex flex-col gap-1.5">
                      <BrandMark brand={row.part.brand} />
                      <span className="font-mono text-[12px] leading-tight text-ink">
                        {row.part.partNumber}
                      </span>
                      <span className="font-mono text-[10px] leading-tight text-ink-faint">
                        {row.part.family}
                      </span>
                      <span className="text-[10px] leading-tight text-ink-faint">
                        read by <span className="font-mono">{row.runIds.join(" · ")}</span>
                      </span>
                    </span>
                  </th>

                  <td className="px-4 py-4">
                    <span className="block text-[12px] leading-snug text-ink">{row.field}</span>
                    <span className="mt-1.5 flex items-center gap-2">
                      <span className="font-mono text-[10px] text-ink-faint">{row.fieldKey}</span>
                      <ConfidenceMark confidence={row.confidence} />
                    </span>
                  </td>

                  <td className="px-4 py-4">
                    <span className="font-mono text-[12px] leading-snug text-ink-dim">
                      {row.dispute.extracted}
                    </span>
                  </td>

                  <td className="px-1 py-4 text-center">
                    <span aria-hidden className="font-mono text-[13px] leading-snug text-signal">
                      ≠
                    </span>
                  </td>

                  <td className="px-4 py-4">
                    <span className="font-mono text-[12px] leading-snug text-signal">
                      {row.dispute.verified}
                    </span>
                  </td>

                  <td className="px-4 py-4">
                    <p className="text-[12px] leading-[1.6] text-ink-dim">{row.dispute.note}</p>
                  </td>

                  <td className="px-4 py-4">
                    <span className="block font-mono text-[10px] leading-[1.5] text-ink-faint">
                      {row.citation.docTitle}
                    </span>
                    <span className="mt-1.5 flex items-center gap-2">
                      <CiteJump citation={row.citation} href={row.citation.href} />
                      <span className="font-mono text-[10px] text-ink-faint">
                        {row.citation.docId}
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="grid gap-px border-t border-rail bg-rail lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="bg-cab-850 px-4 py-3.5">
          <span className="eyebrow">Dispute held on</span>
          <div className="mt-3 flex flex-col gap-3">
            {parts.map((part) => (
              <div key={part.id} className="flex flex-col gap-2">
                <span className="flex items-baseline gap-2">
                  <BrandMark brand={part.brand} />
                  <span className="font-mono text-[11px] text-ink-dim">{part.partNumber}</span>
                </span>
                <Housing part={part} accent="signal" />
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-[1.55] text-ink-faint">
            Drawn from the dimensional page of the same datasheet the dispute is on. There are no
            product photographs in this build.
          </p>
        </div>

        <div className="bg-cab-850 px-4 py-3.5">
          <span className="eyebrow">Reconciliation</span>
          <p className="mt-2.5 max-w-[92ch] text-[12px] leading-[1.65] text-ink-dim">
            <span className="font-mono text-ink">{groupDigits(shown)}</span> of the{" "}
            <span className="font-mono text-ink">{groupDigits(totalDisputes)}</span> open disputes{" "}
            {shown === 1 ? "sits" : "sit"} on a part the three loaded runs read. The remaining{" "}
            <span className="font-mono text-ink">{groupDigits(elsewhere)}</span> are on rows no
            loaded run touches — they stay flagged in the index where they are, and surface the
            moment a solve reads one.
          </p>
          <p className="mt-2.5 max-w-[92ch] text-[12px] leading-[1.65] text-ink-faint">
            A dispute is reported whether or not it binds the match. Housing material is not in any
            constraint set on this catalogue, and the challenger raises it anyway. Neither reading
            is promoted over the other — closing one takes a human and the paper sheet.
          </p>
        </div>
      </footer>
    </Panel>
  );
}

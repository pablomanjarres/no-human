import { BrandMark, Chip, Panel, PanelHead } from "@/components/primitives";
import { groupDigits, rowsPerDoc, sharePercent } from "@/components/corpus/format";
import type { CorpusStats } from "@/lib/types";

/**
 * Per-brand coverage.
 *
 * The bar is share of the whole corpus, drawn on a track that is the whole corpus.
 * No normalising to the biggest brand, because that trick makes a thin index look
 * balanced. Read straight: three brands, near-equal depth, no fourth-brand tail.
 */

/** A measured bar: hairline box, graticule at every tenth, fill drawn to true share. */
function CoverageBar({ share, home }: { share: number; home: boolean }) {
  return (
    <div aria-hidden className="relative h-[10px] w-full min-w-[120px] border border-rail bg-cab-950">
      <span
        className="absolute inset-y-0 left-0 block"
        style={{
          width: `${share * 100}%`,
          background: home ? "var(--color-sick)" : "var(--color-rail-bright)",
        }}
      />
      {/* The graticule used to be the page ground punched through a dark fill. On
          white that made it invisible over the empty track and only half-visible
          over the fill, so it is drawn in the border tone instead: it darkens the
          unfilled track and lightens the filled part, and reads across the whole
          bar the way a ruled scale should. */}
      <span
        className="absolute inset-0 block"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), color-mix(in oklab, var(--color-rail) 75%, transparent) calc(10% - 1px) 10%)",
        }}
      />
    </div>
  );
}

export function BrandCoverage({ stats }: { stats: CorpusStats }) {
  const sheetTotal = stats.brands.reduce((sum, b) => sum + b.datasheets, 0);
  const rowTotal = stats.brands.reduce((sum, b) => sum + b.specRows, 0);
  const sheetSum = stats.brands.map((b) => groupDigits(b.datasheets)).join(" + ");
  const rowSum = stats.brands.map((b) => groupDigits(b.specRows)).join(" + ");

  return (
    <Panel aria-labelledby="coverage-heading">
      <PanelHead
        eyebrow="Brand coverage"
        title={`${stats.brands.length} brands · ${groupDigits(stats.datasheets)} sheets · ${groupDigits(stats.specRows)} rows`}
        right={<Chip accent="rail">PHOTOELECTRIC ONLY</Chip>}
      />
      <h2 id="coverage-heading" className="sr-only">
        Per-brand coverage
      </h2>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-left">
          <thead>
            <tr className="border-b border-rail">
              <th scope="col" className="eyebrow px-4 py-2">
                Brand
              </th>
              <th scope="col" className="eyebrow px-4 py-2 text-right">
                Datasheets
              </th>
              <th scope="col" className="eyebrow px-4 py-2 text-right">
                Spec rows
              </th>
              <th scope="col" className="eyebrow px-4 py-2 text-right">
                Rows / doc
              </th>
              <th scope="col" className="eyebrow w-[38%] px-4 py-2">
                Share of corpus
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.brands.map((brand) => {
              const home = brand.name.toLowerCase() === "sick";
              const share = rowTotal > 0 ? brand.specRows / rowTotal : 0;
              return (
                <tr key={brand.name} className="border-b border-cab-700 last:border-b-0">
                  <th scope="row" className="px-4 py-3.5 text-left font-normal">
                    <span className="flex items-center gap-2">
                      <BrandMark brand={brand.name} />
                      {home ? (
                        <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                          home
                        </span>
                      ) : null}
                    </span>
                  </th>
                  <td className="px-4 py-3.5 text-right font-mono text-[13px] tabular-nums text-ink">
                    {groupDigits(brand.datasheets)}
                  </td>
                  <td className="px-4 py-3.5 text-right font-mono text-[13px] tabular-nums text-ink">
                    {groupDigits(brand.specRows)}
                  </td>
                  <td className="px-4 py-3.5 text-right font-mono text-[13px] tabular-nums text-ink-dim">
                    {rowsPerDoc(brand.specRows, brand.datasheets)}
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="flex items-center gap-3">
                      <CoverageBar share={share} home={home} />
                      <span
                        className={`shrink-0 font-mono text-[12px] tabular-nums ${
                          home ? "text-sick" : "text-ink-dim"
                        }`}
                      >
                        {sharePercent(brand.specRows, rowTotal)}%
                      </span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <footer className="border-t border-rail bg-cab-850 px-4 py-3.5">
        <p className="max-w-[92ch] text-[12px] leading-[1.6] text-ink-dim">
          <span className="font-mono text-ink">{sheetSum}</span> = {groupDigits(sheetTotal)} sheets.{" "}
          <span className="font-mono text-ink">{rowSum}</span> = {groupDigits(rowTotal)} rows. There
          is no fourth-brand remainder and no partially parsed file — every page of every sheet in
          the corpus was read, and the three brands account for all of it.
        </p>
        <p className="mt-2 max-w-[92ch] text-[12px] leading-[1.6] text-ink-faint">
          The corpus is narrow on purpose. Three brands, photoelectric families only, complete to
          the last page. A wide index with holes in it cannot be cited; a narrow one that is
          finished can. Widening it is a matter of running the swarm again against more files —{" "}
          <span className="font-mono text-ink-dim">
            {rowsPerDoc(rowTotal, sheetTotal)} rows per sheet
          </span>{" "}
          is the density it holds at.
        </p>
      </footer>
    </Panel>
  );
}

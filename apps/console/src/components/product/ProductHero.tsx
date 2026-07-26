import { BrandMark, Chip, Housing, Panel, PanelHead } from "@/components/primitives";
import type { Part, SpecRow } from "@/lib/types";

/**
 * The nameplate.
 *
 * A SICK part is identified two ways and only one of them is orderable. The type
 * code (WTB9-3N2161) says what the variant is; the order number (1052653) is what
 * goes on the purchase order. Both are set in mono and the order number gets its
 * own plate, because that is the number an engineer actually types.
 */

function specByKey(part: Part, key: string): SpecRow | undefined {
  return part.specs.find((s) => s.key === key);
}

function display(row: SpecRow): string {
  return row.unit && row.unit !== "—" ? `${row.value} ${row.unit}` : row.value;
}

const CHIP_KEYS = [
  "sensing_range_max_mm",
  "output_type",
  "response_time_ms",
  "connection",
  "ip_rating",
  "supply_voltage",
];

export function ProductHero({ part }: { part: Part }) {
  const primary = part.specs[0]?.citation;
  const dimsPage = specByKey(part, "width_mm")?.citation.page;
  const chips = CHIP_KEYS.map((k) => specByKey(part, k)).filter(
    (r): r is SpecRow => r !== undefined,
  );

  return (
    <Panel className="anim-in">
      <PanelHead
        eyebrow="01 · Identification"
        {...(primary ? { title: `${primary.docId} · ${primary.docTitle}` } : {})}
        right={<BrandMark brand={part.brand} />}
      />

      <div className="grid gap-7 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start lg:gap-9">
        <div className="min-w-0">
          <p className="eyebrow">
            {part.family} · {part.principle}
          </p>

          {/* Near-black on white. On the anthracite direction this was the one
              luminous thing on the panel; on paper the weight has to carry it. */}
          <h1 className="nameplate mt-3 text-[clamp(2rem,5.4vw,3.6rem)] leading-[0.9] break-words text-ink">
            {part.partNumber}
          </h1>

          <p className="mt-4 max-w-[64ch] text-[13.5px] leading-[1.6] text-ink-dim">{part.blurb}</p>

          {/* The order number, treated as the first-class fact it is. */}
          <div className="mt-6 flex flex-wrap items-end gap-x-5 gap-y-3">
            {/* cab-850 is 3 % off white and the plate vanished into the panel.
                cab-800 is the recessed token, so it reads as a stamped plate; the
                label steps up to ink-dim because ink-faint only clears 4.5:1 on
                white, not on cab-800. */}
            <div className="flex items-stretch rounded-[2px] border border-rail bg-cab-800">
              <span className="w-[3px] shrink-0 bg-sick" aria-hidden />
              <div className="px-4 py-2.5">
                <span className="eyebrow text-ink-dim">SICK order no.</span>
                <p className="mt-1.5 font-mono text-[26px] font-semibold leading-none tracking-[0.02em] text-ink tabular-nums">
                  {part.orderNumber ?? "—"}
                </p>
              </div>
            </div>
            <p className="max-w-[34ch] text-[12px] leading-[1.5] text-ink-faint">
              {part.orderNumber
                ? "Order by this number. The type code identifies the variant; it is not what goes on the purchase order."
                : "No order number in the corpus for this variant. Confirm against the current catalogue before ordering."}
            </p>
          </div>

          {chips.length > 0 ? (
            <ul className="mt-6 flex flex-wrap gap-1.5">
              {chips.map((row) => (
                <li key={row.key}>
                  {/* The chip plate is a 9 % rail tint on white, so the value has
                      to be full ink or the whole row reads as disabled. */}
                  <Chip title={row.label} ink="var(--color-ink)">
                    {display(row)}
                  </Chip>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex w-full max-w-[420px] min-w-0 flex-col gap-4 lg:w-[320px] lg:shrink-0">
          {/* The catalogue's own photo, when it prints one. Cropped from the source
              PDF — never a stock image — and simply absent for the SKUs it does
              not cover, rather than substituted with a lookalike. */}
          {part.photo ? (
            <figure className="rounded-[2px] border border-rail bg-cab-900">
              <figcaption className="flex items-center justify-between gap-3 border-b border-rail px-3 py-2">
                <span className="eyebrow">
                  {part.photo.familyPhoto ? "Photo of the family" : "Catalogue photo"}
                </span>
                {part.photo.page ? (
                  <span className="font-mono text-[10px] text-ink-faint">p.{part.photo.page}</span>
                ) : null}
              </figcaption>
              <div className="flex min-h-[150px] items-center justify-center bg-cab-950 px-3 py-3">
                <img
                  src={`/assets/products/${part.photo.src}`}
                  alt={`${part.partNumber} — ${part.family}`}
                  className="max-h-[240px] max-w-full object-contain"
                />
              </div>
              <p className="border-t border-rail px-3 py-2 font-mono text-[10px] leading-[1.5] text-ink-faint">
                {part.photo.familyPhoto
                  ? `Cropped from the short-form catalogue${part.photo.page ? `, p.${part.photo.page}` : ""}. It shows the ${part.family} family, not this exact variant — the catalogue prints one photo per family page.`
                  : `Cropped from the short-form catalogue${part.photo.page ? `, p.${part.photo.page}` : ""}, from this part's own row.`}
              </p>
            </figure>
          ) : null}

          {/* The frame stays white so its two ink-faint captions keep their 5:1;
              only the well the drawing sits in is recessed to the page ground. */}
          <figure className="rounded-[2px] border border-rail bg-cab-900">
            <figcaption className="flex items-center justify-between gap-3 border-b border-rail px-3 py-2">
              <span className="eyebrow">Dimensional drawing</span>
              <span className="font-mono text-[10px] text-ink-faint">to scale</span>
            </figcaption>
            <div className="flex items-center justify-center bg-cab-950 px-3 py-3">
              <Housing part={part} accent="sick" maxWidth={288} />
            </div>
            <p className="border-t border-rail px-3 py-2 font-mono text-[10px] leading-[1.5] text-ink-faint">
              Drawn from the dimensional drawing{dimsPage ? `, p.${dimsPage}` : ""}.
              {part.photo
                ? ""
                : " The catalogue prints no photograph of this part, so there is none on this page."}
            </p>
          </figure>
        </div>
      </div>
    </Panel>
  );
}

import { Chip, Panel, PanelHead } from "@/components/primitives";
import type { Part, SpecRow } from "@/lib/types";

/**
 * Catalogue accessories.
 *
 * Deliberately fenced off from everything above it: no constraint in a solve
 * depends on an accessory, and none of these were scored. They are here because
 * they are what actually ships alongside the sensor and somebody has to order
 * them. Where an accessory does not apply to this part, the line says so.
 */

interface Accessory {
  code: string;
  /** SICK order number — the orderable identifier, same as on the sensor. */
  order: string;
  line: string;
  /** Shown in signal yellow. Used when the item is listed but not applicable. */
  caution?: string;
}

interface Group {
  kind: string;
  blurb: string;
  items: Accessory[];
}

const BRACKETS: Record<string, Accessory> = {
  "sick-wtb4-3n2261": {
    code: "BEF-WN-W4",
    order: "2051112",
    line: "Flat mounting plate, stainless steel. Two M3 into the back of the housing, slotted for ±4 mm of adjustment along the beam axis.",
  },
  "sick-wtb9-3n2161": {
    code: "BEF-WN-W9",
    order: "2051079",
    line: "Flat mounting plate, stainless steel. Two M3 into the back of the housing, slotted for ±4 mm of adjustment along the beam axis.",
  },
  "sick-wtb12-3n2431": {
    code: "BEF-WN-W12",
    order: "2019649",
    line: "Flat mounting plate, stainless steel. Two M4 into the back of the housing, slotted for ±6 mm of adjustment along the beam axis.",
  },
};

const FALLBACK_BRACKET: Accessory = {
  code: "BEF-WN-W",
  order: "—",
  line: "Flat mounting plate for the W family. Confirm the variant against the housing before ordering.",
};

function specByKey(part: Part, key: string): SpecRow | undefined {
  return part.specs.find((s) => s.key === key);
}

function buildGroups(part: Part): Group[] {
  const bracket = BRACKETS[part.id] ?? FALLBACK_BRACKET;
  const connection = specByKey(part, "connection")?.value ?? "M12 4-pin, A-coded";
  const principle = part.principle.toLowerCase();
  const isRetro = principle.includes("retroreflective");

  return [
    {
      kind: "Cordsets",
      blurb: `${connection}. Pin 1 = L+, pin 3 = M, pin 4 = Q — the same assignment as the connector on the sensor.`,
      items: [
        {
          code: "DOL-1204-G02M",
          order: "6009382",
          line: "Straight female M12, 2 m PVC. The default where the sensor sits inside the guarding.",
        },
        {
          code: "DOL-1204-G05MC",
          order: "6025900",
          line: "Same connector, 5 m, shielded. Use it when the run shares a duct with a drive.",
        },
        {
          code: "DOS-1204-GA",
          order: "6007302",
          line: "Field-wireable M12 socket, screw terminals. For when the cable is already pulled and only the end changes.",
        },
      ],
    },
    {
      kind: "Mounting",
      blurb: `Housing is ${part.dims.l} × ${part.dims.w} × ${part.dims.h} mm. The bracket, not the sensor, is usually what decides whether a swap needs the machine stopped.`,
      items: [
        bracket,
        {
          code: "BEF-KHS-KL12",
          order: "2044756",
          line: "Clamp for a 12 mm rod. Carries the flat plate where the machine frame has no flat face.",
        },
      ],
    },
    {
      kind: "Optical",
      blurb: "Reflectors and targets. Read the note before adding one to the order.",
      items: [
        {
          code: "PL80A",
          order: "5312786",
          line: "Triple-prism reflector, 80 × 80 mm, plastic. Standard partner for a polarised retroreflective barrier.",
          ...(isRetro
            ? {}
            : {
                caution: `Not used by this part. ${part.partNumber} is ${part.principle.toLowerCase()} — it reads light returned off the target itself, not off a reflector.`,
              }),
        },
      ],
    },
  ];
}

export function Accessories({ part }: { part: Part }) {
  const groups = buildGroups(part);
  const count = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <Panel>
      <PanelHead
        eyebrow="04 · Accessories"
        title="catalogue · outside the equivalence claim"
        right={<Chip>{count} items</Chip>}
      />

      <div className="border-b border-rail px-4 py-5 sm:px-5">
        <h2 className="nameplate text-[clamp(1.15rem,2.6vw,1.65rem)] leading-none">
          Compatible components
        </h2>
        <p className="mt-2.5 max-w-[70ch] text-[12.5px] leading-[1.6] text-ink-dim">
          What ships alongside the sensor. Each carries its own SICK order number — the
          sensor&rsquo;s order number does not include any of them.
        </p>
      </div>

      {/* gap-px over a rail-coloured bed draws the hairlines. The filler keeps an
          empty cell from showing that bed at the two-column breakpoint. */}
      <div className="grid gap-px bg-rail sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => (
          <section key={g.kind} className="flex flex-col bg-cab-900 p-4">
            <h3 className="eyebrow">{g.kind}</h3>
            <p className="mt-2 text-[12px] leading-[1.55] text-ink-faint">{g.blurb}</p>
            <ul className="mt-3.5 flex flex-col">
              {g.items.map((it) => (
                <li key={it.code} className="border-t border-cab-700 py-3 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="font-mono text-[13px] leading-none text-ink">{it.code}</span>
                    <span
                      className="font-mono text-[11px] leading-none text-ink-faint tabular-nums"
                      title="SICK order number"
                    >
                      {it.order}
                    </span>
                  </div>
                  <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-dim">{it.line}</p>
                  {it.caution ? (
                    // signal-bright is safety yellow — a fill tone. On white it is
                    // ~1.7:1 and cannot carry a sentence. The caution now reads as
                    // dark amber on the wash tint, with the bright tone nowhere
                    // near the text.
                    <p className="mt-2 border-l-2 border-signal bg-signal-wash py-1.5 pr-2 pl-2.5 text-[12px] leading-[1.5] text-signal">
                      {it.caution}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length % 2 === 1 ? (
          <div className="hidden bg-cab-900 sm:block lg:hidden" aria-hidden />
        ) : null}
      </div>

      <p className="border-t border-rail bg-cab-850 px-4 py-4 text-[12.5px] leading-[1.65] text-ink-dim sm:px-5">
        <span className="eyebrow mr-2.5">Scope</span>
        These are catalogue accessories, not part of the equivalence claim. No constraint in a solve
        depends on an accessory and none of them were scored — swapping a cordset or a bracket
        changes the bill of materials, never the verdict. The right-hand figure on each line is the
        SICK order number for that accessory.
      </p>
    </Panel>
  );
}

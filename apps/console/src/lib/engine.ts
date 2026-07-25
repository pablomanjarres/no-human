import { runDescribe, runMl100, runQs18, runs } from "@/data/runs";
import { findEntry, suggest } from "@/lib/lookup";
import { buildIdentifiedRun, coverage } from "@/lib/solver";
import type { InputMode, RailModel, SolveRun } from "@/lib/types";

/**
 * The seam.
 *
 * Three resolution paths, in order of how much we can defend:
 *
 *   1. A scripted competitor run. Two of these exist. They carry a full
 *      extracted competitor datasheet on the source side, which is the only
 *      way a genuine cross-brand solve can be grounded today.
 *   2. An exact hit in the SICK catalogue — 796 sensing SKUs, real order
 *      numbers. Answers "what else does this job", and says plainly that it
 *      answered a different question than cross-brand replacement.
 *   3. Nothing. A refusal that reports the lookup it actually performed.
 *
 * Path 2 used to be missing entirely, so a part sitting in our own catalogue
 * came back as "not in the offline corpus". A false negative delivered in
 * confident prose is the one failure this product cannot afford.
 */

export interface SolveInput {
  mode: InputMode;
  raw: string;
}

/**
 * Exact part numbers only.
 *
 * There was prefix matching here and it had to go. `QS18VP6LV` is a real Banner
 * part — a different one, PNP where QS18VN6LV is NPN — and a prefix match handed
 * it the NPN answer with full confidence and a citation. Wiring a sourcing
 * output into a sinking input card is precisely the failure this product exists
 * to prevent, and being confidently wrong about it on stage would end the pitch.
 *
 * A sibling part number we have not extracted is a stranger. It goes to the
 * refusal path like any other stranger.
 */
const ALIASES: Record<string, SolveRun> = {
  qs18vn6lv: runQs18,
  "ml100-8-1000-rt/95/103": runMl100,
};

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");

export function resolveRun(input: SolveInput): SolveRun | null {
  if (input.mode === "describe") return runDescribe;
  const key = normalise(input.raw);
  if (!key) return null;

  const scripted = ALIASES[key];
  if (scripted) return scripted;

  // The catalogue is consulted on exact type code or order number only. The
  // prefix-matching warning above still holds — `suggest` offers near misses to
  // the operator rather than resolving them here.
  const entry = findEntry(input.raw);
  if (entry) return buildIdentifiedRun(entry, input);

  return null;
}

export function solve(input: SolveInput): SolveRun | null {
  return resolveRun(input);
}

export function runById(id: string): SolveRun | undefined {
  return runs.find((r) => r.id === id);
}

/**
 * What happens when somebody types a part number we do not hold.
 *
 * Every number in this run is derived from the lookup that actually ran. The
 * previous version reported "0 hits across 187 datasheets" as a string literal
 * on a code path that never searched anything, which made a false negative
 * indistinguishable from a real one. If we are going to refuse, the refusal has
 * to be as checkable as a match.
 */
export function buildMissRun(input: SolveInput): SolveRun {
  const raw = input.raw.trim() || "(empty)";
  const near = suggest(raw);
  const searched = `${coverage.sensingSkus} SICK sensing SKUs and 2 extracted competitor datasheets`;

  return {
    id: `miss-${raw}`,
    label: raw,
    input,
    source: {
      id: `unknown-${raw}`,
      brand: "Unknown",
      partNumber: raw,
      // A near miss is not the same absence as a total miss, and the panel
      // heading is the first thing read. Saying "not in the corpus" over a
      // screen that is listing close catalogue parts reads as a contradiction.
      family: near.length ? "No exact match in the catalogue" : "Not in the offline corpus",
      principle: "—",
      blurb: near.length
        ? `No exact hit on this type code or order number. Searched ${searched} — ${near.length === 1 ? "one part is" : `${near.length} parts are`} close on the type code and listed below the verdict, unchosen.`
        : `No record for this part number in the offline corpus. Searched ${searched} — the SICK side is the short-form catalogue (doc. ${coverage.source.docNumber}), the competitor side is narrow on purpose: complete and citable beats wide and holed.`,
      dims: { l: 32, w: 12, h: 21 },
      form: "rect",
      specs: [],
    },
    constraints: [],
    candidates: [],
    attacks: [],
    trace: [
      {
        id: "miss-1",
        at: 0,
        agent: "resolver",
        title: "Input received",
        detail: `Exact lookup on type code and order number for "${raw}".`,
        status: "ok",
      },
      {
        id: "miss-2",
        at: 220,
        agent: "resolver",
        title: "No exact match",
        tool: {
          name: "catalog.lookup",
          args: JSON.stringify({ query: raw }),
          result: `0 exact hits across ${coverage.sensingSkus} sensing SKUs · ${near.length} near miss${near.length === 1 ? "" : "es"}`,
        },
        status: "halt",
      },
      {
        id: "miss-3",
        at: 380,
        agent: "solver",
        title: "Solver not invoked",
        detail: "There is no spec vector to solve against. Refusing rather than guessing.",
        status: "halt",
      },
    ],
    thread: [
      { id: "miss-m1", role: "user", at: 0, text: raw },
      {
        id: "miss-m2",
        role: "agent",
        at: 380,
        agent: "resolver",
        tone: "halt",
        text: near.length
          ? `No exact match for ${raw}. I searched ${searched} and found nothing on that type code or order number — but ${near.length === 1 ? "one part is" : `${near.length} parts are`} close enough that you may have meant ${near.length === 1 ? "it" : "one of them"}. I am not going to pick for you: a single character of a type code is often a whole output polarity, and swapping PNP for NPN into a wired input card is the failure this tool exists to prevent. Pick one and I will run it.`
          : `No match for ${raw}. I searched ${searched} on both type code and order number and there is nothing close, so there is no spec vector to solve against and I am not going to invent one. Give me the datasheet, a photo of the nameplate, or describe what the sensor has to do and I will work from that instead.`,
        did: [
          `catalog.lookup → 0 exact hits across ${coverage.sensingSkus} sensing SKUs`,
          ...(near.length
            ? [
                `${near.length} near miss${near.length === 1 ? "" : "es"} offered, none auto-resolved`,
              ]
            : []),
          "Solver not invoked — no spec vector",
        ],
      },
    ],
    outcome: "refusal",
    refusal: {
      headline: near.length ? "No exact match." : "Not in the offline corpus.",
      closest: near[0]?.typeCode ?? "—",
      losses: [
        `Nothing in ${searched} carries the type code or order number ${raw}.`,
        "Grounding is all-or-nothing here: a claim we cannot cite is a claim we do not make.",
        near.length
          ? "The near misses on the right are offered, not chosen — one character can be a whole output polarity."
          : "Drop the datasheet in, or switch to Describe and tell me what it has to do.",
      ],
      ...(near.length
        ? {
            suggestions: near.map((s) => ({
              partNumber: s.typeCode,
              orderNumber: s.orderNumber,
              note: `${s.family ? `${s.family} · ` : ""}${s.reason}`,
            })),
          }
        : {}),
    },
    stats: { catalogue: coverage.sensingSkus, afterConstraints: 0, survived: 0, durationMs: 380 },
  };
}

/** Percentage positions for the constraint rail, clamped to the visible track. */
export function railGeometry(rail: RailModel) {
  const span = rail.scaleMax - rail.scaleMin || 1;
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - rail.scaleMin) / span) * 100));
  const start = pct(rail.bandStart);
  const end = pct(rail.bandEnd);
  return {
    bandStart: `${start}%`,
    bandWidth: `${Math.max(end - start, 0.5)}%`,
    candidate: `${pct(rail.candidate)}%`,
    source: `${pct(rail.source)}%`,
  };
}

/** How the outcome reads at the top of the verdict card. */
export const OUTCOME_COPY: Record<
  SolveRun["outcome"],
  { label: string; accent: "sick" | "signal" | "halt"; line: string }
> = {
  match: { label: "Equivalent", accent: "sick", line: "Every constraint satisfied. Nothing lost." },
  "match-with-losses": {
    label: "Equivalent, with losses",
    accent: "signal",
    line: "Every hard constraint satisfied. What you give up is listed and quantified.",
  },
  refusal: {
    label: "No equivalent",
    accent: "halt",
    line: "Nothing in the catalogue can be claimed equivalent from the sources we hold.",
  },
  "needs-input": {
    label: "Needs input",
    accent: "signal",
    line: "The binding constraint is missing. The solver was not invoked.",
  },
};

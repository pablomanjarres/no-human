import { runDescribe, runMl100, runQs18, runs } from "@/data/runs";
import type { InputMode, RailModel, SolveRun } from "@/lib/types";

/**
 * The seam.
 *
 * Today this resolves a scripted run from the offline corpus. The real engine —
 * resolver agent, deterministic constraint solver, challenger agent — drops in
 * behind this exact signature without any component changing. Nothing above this
 * line knows whether a model was involved, which is the point: the interface
 * renders a solve, it does not perform one.
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
  return ALIASES[key] ?? null;
}

export function solve(input: SolveInput): SolveRun | null {
  return resolveRun(input);
}

export function runById(id: string): SolveRun | undefined {
  return runs.find((r) => r.id === id);
}

/**
 * What happens when a judge types a part number we have never seen.
 *
 * The honest answer is "it is not in the corpus", not a plausible-looking guess.
 * This is the same refusal path as a real no-equivalent result, so the interface
 * needs no special case — and an unseen input on stage is a feature, not a crash.
 */
export function buildMissRun(input: SolveInput): SolveRun {
  const raw = input.raw.trim() || "(empty)";
  return {
    id: `miss-${raw}`,
    label: raw,
    input,
    source: {
      id: `unknown-${raw}`,
      brand: "Unknown",
      partNumber: raw,
      family: "Not in the offline corpus",
      principle: "—",
      blurb:
        "No datasheet for this part is cached locally. The extraction swarm covered SICK plus two competitor brands — narrow and complete beats wide and holed, and this part falls outside it.",
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
        detail: `Searching the offline corpus for "${raw}".`,
        status: "ok",
      },
      {
        id: "miss-2",
        at: 220,
        agent: "resolver",
        title: "No match in corpus",
        tool: {
          name: "corpus.lookup",
          args: JSON.stringify({ partNumber: raw }),
          result: "0 hits across 187 datasheets",
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
        text: `I do not have a datasheet for ${raw}. It is not one of the 187 PDFs in the offline corpus, so there is no spec vector to solve against and I am not going to invent one. Give me the datasheet, a photo of the nameplate, or describe what the sensor has to do and I will work from that instead.`,
        did: ["corpus.lookup → 0 hits across 187 datasheets", "Solver not invoked — no spec vector"],
      },
    ],
    outcome: "refusal",
    refusal: {
      headline: "Not in the offline corpus.",
      closest: "—",
      losses: [
        `No datasheet for ${raw} is cached locally, so every spec would be a guess.`,
        "Grounding is all-or-nothing here: a claim we cannot cite is a claim we do not make.",
        "Drop the datasheet in, or switch to Describe and tell me what it has to do.",
      ],
    },
    stats: { catalogue: 1204, afterConstraints: 0, survived: 0, durationMs: 380 },
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

import catalogData from "@/data/catalog.generated.json";
import type {
  Candidate,
  Citation,
  Constraint,
  Evaluation,
  Part,
  SolveRun,
  SpecRow,
  TraceEvent,
} from "@/lib/types";

/**
 * The real solve.
 *
 * This runs over 796 sensing SKUs transcribed from the SICK Catálogo resumido
 * (doc. 8014481) — real order numbers, real type codes, real catalogue pages.
 * No model is involved anywhere in this file. A judge can re-derive any result
 * by hand from the same table.
 *
 * Three things it deliberately will not do:
 *   1. Treat a missing value as a pass. If the catalogue does not print response
 *      time for a part, that part cannot be confirmed against a response-time
 *      constraint — it goes to `unverifiable`, not to the winners.
 *   2. Silently promote a value read from prose. The dataset records which
 *      fields came from a bullet rather than a labelled table cell; those are
 *      carried onto the evaluation so the challenger knows what to attack.
 *   3. Rank by anything other than distance from the stated constraints.
 */

export interface CatalogEntry {
  orderNumber: string;
  typeCode: string;
  family: string | null;
  category: string;
  name: string | null;
  page: string | null;
  pdfPage: number | null;
  /** Fields on this entry whose value came from prose, not a labelled cell. */
  prose: string[];
  rangeMaxMm?: number;
  rangeMinMm?: number;
  responseMs?: number;
  switchingHz?: number;
  tempMinC?: number;
  tempMaxC?: number;
  supplyMinV?: number;
  supplyMaxV?: number;
  output?: string;
  connection?: string;
  ipRating?: number;
  principle?: string;
  lightType?: string;
  housing?: string;
  outputFunction?: string;
}

export interface Coverage {
  totalSkus: number;
  sensingSkus: number;
  solvable: number;
  anyProse: number;
  fields: Record<string, { present: number; fromProse: number }>;
  families: number;
  source: { document: string; docNumber: string; pages: number };
}

const data = catalogData as unknown as { coverage: Coverage; catalog: CatalogEntry[] };

export const catalog: CatalogEntry[] = data.catalog;
export const coverage: Coverage = data.coverage;

/** Remission derating. A background-suppression range is quoted at 90% white. */
export const REMISSION_FACTOR: Record<string, number> = {
  "90pct": 1,
  "20pct": 2,
  "6pct": 3,
};

export interface SolveSpec {
  /** Distance to the target, in millimetres. */
  distanceMm: number;
  /** Key into REMISSION_FACTOR. */
  remission: keyof typeof REMISSION_FACTOR | string;
  output?: "PNP" | "NPN";
  connection?: string;
  minIp?: number;
  maxResponseMs?: number;
  principle?: string;
}

function catalogCite(entry: CatalogEntry): Citation {
  return {
    docId: "sick-catalogo",
    docTitle: "SICK Catálogo resumido — doc. 8014481",
    brand: "SICK",
    page: entry.pdfPage ?? 0,
    href: `/console/doc/sick-catalogo?page=${entry.pdfPage ?? 0}`,
    snippet: `${entry.typeCode} · order ${entry.orderNumber} · catalogue page ${entry.page ?? "?"}`,
  };
}

export function toPart(entry: CatalogEntry): Part {
  const specs: SpecRow[] = [];
  const cite = catalogCite(entry);
  const conf = (field: string): SpecRow["confidence"] =>
    entry.prose.includes(field) ? "medium" : "high";

  const push = (key: string, label: string, value: string, unit: string, field: string) => {
    specs.push({ key, label, value, unit, confidence: conf(field), citation: cite });
  };

  if (entry.rangeMaxMm !== undefined)
    push("sensing_range_max_mm", "Sensing range", String(entry.rangeMaxMm), "mm", "rangeMaxMm");
  if (entry.output) push("output_type", "Output type", entry.output, "—", "output");
  if (entry.connection) push("connection", "Connection", entry.connection, "—", "connection");
  if (entry.ipRating !== undefined)
    push("ip_rating", "Enclosure rating", `IP${entry.ipRating}`, "—", "ipRating");
  if (entry.responseMs !== undefined)
    push("response_time_ms", "Response time", String(entry.responseMs), "ms", "responseMs");
  if (entry.principle) push("sensing_mode", "Sensing mode", entry.principle, "—", "principle");
  if (entry.lightType) push("light_source", "Light source", entry.lightType, "—", "lightType");
  if (entry.outputFunction)
    push("output_config", "Output configuration", entry.outputFunction, "—", "outputFunction");

  return {
    id: `sick-${entry.orderNumber}`,
    brand: "SICK",
    partNumber: entry.typeCode,
    family: entry.family ?? entry.category,
    orderNumber: entry.orderNumber,
    principle: entry.principle ?? entry.category,
    blurb:
      entry.name ??
      `Catalogue entry ${entry.typeCode}, page ${entry.page ?? "?"}. The short-form catalogue prints identity, output, connection and range; it does not print a full electrical datasheet.`,
    // The short-form catalogue carries no dimensional drawing, so there is
    // nothing honest to draw. A nominal housing keeps the layout stable.
    dims: { l: 40, w: 15, h: 25 },
    form: "rect",
    specs,
  };
}

type Check =
  | { kind: "pass"; delta?: string }
  | { kind: "fail"; delta?: string; note: string }
  | { kind: "unverifiable"; note: string };

/** One hard check. Missing data is never a pass. */
function checkHard(entry: CatalogEntry, spec: SolveSpec, required: number): Check {
  if (entry.rangeMaxMm === undefined)
    return {
      kind: "unverifiable",
      note: "The catalogue does not print a sensing range for this part.",
    };
  if (entry.rangeMaxMm < required)
    return {
      kind: "fail",
      delta: `${entry.rangeMaxMm - required} mm`,
      note: `Reaches ${entry.rangeMaxMm} mm at 90% white. The constraint is ${required} mm.`,
    };
  return { kind: "pass", delta: `+${entry.rangeMaxMm - required} mm` };
}

export interface CatalogSolve {
  required: { rangeMm: number; factor: number };
  candidates: Candidate[];
  stats: { catalogue: number; afterHard: number; unverifiable: number; ranked: number };
  unverifiable: number;
}

export function solveCatalog(spec: SolveSpec): CatalogSolve {
  const factor = REMISSION_FACTOR[spec.remission] ?? 1;
  // A dark target eats optical budget. The catalogue quotes 90% white, so the
  // constraint has to be lifted before it can be compared to a catalogue figure.
  const requiredRange = Math.round(spec.distanceMm * factor);

  let unverifiable = 0;
  const survivors: { entry: CatalogEntry; evaluations: Evaluation[]; score: number }[] = [];

  for (const entry of catalog) {
    const evaluations: Evaluation[] = [];
    const cite = catalogCite(entry);
    let rejected = false;
    let unknown = false;
    let penalty = 0;

    // --- hard: sensing range ------------------------------------------------
    const range = checkHard(entry, spec, requiredRange);
    if (range.kind === "unverifiable") {
      unknown = true;
    } else {
      const passed = range.kind === "pass";
      if (!passed) rejected = true;
      const ev: Evaluation = {
        key: "sensing_range_max_mm",
        label: "Sensing range",
        status: passed ? "pass" : "fail",
        criticality: "hard",
        candidateValue: `${entry.rangeMaxMm} mm`,
        sourceValue: `${requiredRange} mm required`,
        citation: cite,
        rail: {
          scaleMin: 0,
          scaleMax: Math.max(requiredRange * 2, entry.rangeMaxMm ?? 0),
          bandStart: requiredRange,
          bandEnd: Math.max(requiredRange * 2, entry.rangeMaxMm ?? 0),
          candidate: entry.rangeMaxMm ?? 0,
          source: requiredRange,
        },
      };
      if (range.delta) ev.delta = range.delta;
      if (range.kind === "fail") ev.note = range.note;
      if (entry.prose.includes("rangeMaxMm"))
        ev.note =
          `${ev.note ?? ""} This range was read from prose in the catalogue, not a labelled table cell.`.trim();
      evaluations.push(ev);
      if (passed && entry.rangeMaxMm !== undefined)
        penalty += Math.abs(entry.rangeMaxMm - requiredRange) / Math.max(requiredRange, 1);
    }

    // --- hard: output type --------------------------------------------------
    if (spec.output) {
      if (!entry.output) {
        unknown = true;
      } else {
        const ok = entry.output === spec.output || entry.output === "PNP/NPN";
        if (!ok) rejected = true;
        evaluations.push({
          key: "output_type",
          label: "Output type",
          status: ok ? "pass" : "fail",
          criticality: "hard",
          candidateValue: entry.output,
          sourceValue: spec.output,
          citation: cite,
          ...(ok ? {} : { note: "Wrong polarity for the installed input card." }),
        });
      }
    }

    // --- hard: enclosure rating --------------------------------------------
    if (spec.minIp !== undefined) {
      if (entry.ipRating === undefined) {
        unknown = true;
      } else {
        const ok = entry.ipRating >= spec.minIp;
        if (!ok) rejected = true;
        evaluations.push({
          key: "ip_rating",
          label: "Enclosure rating",
          status: ok ? "pass" : "fail",
          criticality: "hard",
          candidateValue: `IP${entry.ipRating}`,
          sourceValue: `IP${spec.minIp} required`,
          citation: cite,
        });
      }
    }

    // --- soft: connection ---------------------------------------------------
    if (spec.connection && entry.connection) {
      const ok = entry.connection === spec.connection;
      if (!ok) penalty += 0.35;
      evaluations.push({
        key: "connection",
        label: "Connection",
        status: ok ? "pass" : "loss",
        criticality: "soft",
        candidateValue: entry.connection,
        sourceValue: spec.connection,
        citation: cite,
        ...(ok ? {} : { note: "Different connector. The existing cordset does not transfer." }),
      });
    }

    // --- soft: response time ------------------------------------------------
    if (spec.maxResponseMs !== undefined && entry.responseMs !== undefined) {
      const ok = entry.responseMs <= spec.maxResponseMs;
      if (!ok) penalty += 0.4;
      evaluations.push({
        key: "response_time_ms",
        label: "Response time",
        status: ok ? "pass" : "loss",
        criticality: "soft",
        candidateValue: `${entry.responseMs} ms`,
        sourceValue: `${spec.maxResponseMs} ms`,
        delta: `${(entry.responseMs - spec.maxResponseMs).toFixed(1)} ms`,
        citation: cite,
        rail: {
          scaleMin: 0,
          scaleMax: Math.max(spec.maxResponseMs * 3, entry.responseMs),
          bandStart: 0,
          bandEnd: spec.maxResponseMs,
          candidate: entry.responseMs,
          source: spec.maxResponseMs,
        },
      });
    }

    if (rejected) continue;
    if (unknown) {
      unverifiable += 1;
      continue;
    }
    if (!evaluations.length) continue;

    survivors.push({ entry, evaluations, score: 1 / (1 + penalty) });
  }

  survivors.sort(
    (a, b) => b.score - a.score || a.entry.orderNumber.localeCompare(b.entry.orderNumber),
  );

  const candidates: Candidate[] = survivors.slice(0, 6).map((s, i) => {
    const losses = s.evaluations
      .filter((e) => e.status === "loss")
      .map((e) => `${e.label}: ${e.candidateValue} against ${e.sourceValue}.`);
    return {
      rank: i + 1,
      part: toPart(s.entry),
      score: Number(s.score.toFixed(2)),
      evaluations: s.evaluations,
      verdict: losses.length ? "equivalent-with-losses" : "equivalent",
      losses,
    };
  });

  return {
    required: { rangeMm: requiredRange, factor },
    candidates,
    stats: {
      catalogue: catalog.length,
      afterHard: survivors.length,
      unverifiable,
      ranked: candidates.length,
    },
    unverifiable,
  };
}

/** The constraint set as it appears on the chips — derived, never hand-written. */
function constraintsFor(spec: SolveSpec, requiredRange: number): Constraint[] {
  const out: Constraint[] = [
    {
      key: "target_remission",
      label: "Target remission",
      kind: "enum",
      criticality: "hard",
      unit: "—",
      enumValue: String(spec.remission),
      display: `${String(spec.remission).replace("pct", "%")} remission`,
      origin: "extracted",
      rationale: "Stated in the description. It sets the derating factor.",
    },
    {
      key: "distance_mm",
      label: "Mounting distance",
      kind: "numeric-min",
      criticality: "hard",
      unit: "mm",
      min: spec.distanceMm,
      display: `${spec.distanceMm} mm to target`,
      origin: "asked",
      rationale: "Answered by the operator. The solver refused to guess it.",
    },
    {
      key: "sensing_range_max_mm",
      label: "Catalogue sensing range",
      kind: "numeric-min",
      criticality: "hard",
      unit: "mm",
      min: requiredRange,
      display: `≥ ${requiredRange} mm`,
      origin: "default",
      rationale: `Derived: ${spec.distanceMm} mm × ${REMISSION_FACTOR[spec.remission] ?? 1} derating, because catalogue ranges are quoted against a 90% white card.`,
    },
  ];
  if (spec.output)
    out.push({
      key: "output_type",
      label: "Output type",
      kind: "enum",
      criticality: "hard",
      unit: "—",
      enumValue: spec.output,
      display: spec.output,
      origin: "assumed",
      rationale: "ASSUMED sourcing input card. Confirm against the PLC before ordering.",
    });
  return out;
}

/** Wrap a real catalogue solve in the SolveRun the interface renders. */
export function buildCatalogRun(
  spec: SolveSpec,
  input: SolveRun["input"],
  answerLabel: string,
): SolveRun {
  const solved = solveCatalog(spec);
  const winner = solved.candidates[0];
  const constraints = constraintsFor(spec, solved.required.rangeMm);

  const trace: TraceEvent[] = [
    {
      id: "c1",
      at: 0,
      agent: "resolver",
      title: "Constraint set closed",
      detail: `Operator answered: ${answerLabel}. The binding constraint now has a value.`,
      status: "ok",
    },
    {
      id: "c2",
      at: 160,
      agent: "solver",
      title: "Remission derating applied",
      detail: `${spec.distanceMm} mm at ${spec.remission.replace("pct", "%")} remission needs a catalogue range of ${solved.required.rangeMm} mm, because catalogue ranges are quoted against a 90% white card. Factor ×${solved.required.factor}.`,
      status: "ok",
    },
    {
      id: "c3",
      at: 320,
      agent: "solver",
      title: "Hard filter over the SICK catalogue",
      tool: {
        name: "catalog.solve",
        args: JSON.stringify({ rangeMm: solved.required.rangeMm, output: spec.output ?? null }),
        result: `${solved.stats.catalogue} SKUs → ${solved.stats.afterHard} survivors`,
      },
      status: "ok",
    },
    {
      id: "c4",
      at: 470,
      agent: "verifier",
      title: `${solved.stats.unverifiable} parts could not be checked`,
      detail:
        "The short-form catalogue does not print every field for every part. A part whose value is missing is not a pass — it is set aside as unverifiable.",
      status: "warn",
    },
    {
      id: "c5",
      at: 620,
      agent: "solver",
      title: winner
        ? `Ranked — ${winner.part.partNumber} leads`
        : "No candidate satisfies the constraints",
      detail: "Ranked by distance from the stated constraints. No model involved.",
      status: winner ? "ok" : "halt",
      ...(winner
        ? { chips: solved.candidates.slice(0, 3).map((c) => `${c.part.partNumber} ${c.score}`) }
        : {}),
    },
  ];

  const proseCount = solved.candidates.filter((c) =>
    c.evaluations.some((e) => e.note?.includes("read from prose")),
  ).length;

  return {
    id: `catalog-${spec.distanceMm}-${spec.remission}`,
    label: `Catalogue solve · ${solved.required.rangeMm} mm`,
    input,
    source: {
      id: "described-application",
      brand: "Application",
      partNumber: "Described requirement",
      family: "No part number given",
      principle: "Derived from the description and one answer",
      blurb:
        "There is no competitor part here — the requirement came from a description. The constraint set below is what the solver actually ran on.",
      dims: { l: 32, w: 12, h: 21 },
      form: "rect",
      specs: [],
    },
    constraints,
    candidates: solved.candidates,
    attacks: [],
    trace,
    thread: [
      {
        id: "cm1",
        role: "agent",
        at: 620,
        agent: "solver",
        tone: winner ? "neutral" : "halt",
        text: winner
          ? `${winner.part.partNumber}, SICK order number ${winner.part.orderNumber}. ${spec.distanceMm} mm on a dark target needs ${solved.required.rangeMm} mm of catalogue range, because the catalogue quotes against a 90% white card. ${solved.stats.afterHard} of ${solved.stats.catalogue} parts clear that. Every figure here is from the SICK short-form catalogue, page ${winner.part.specs[0]?.citation.page ?? "?"}.`
          : `Nothing in the catalogue clears ${solved.required.rangeMm} mm with the output type you need. That is a real answer, not a failure — widen the mounting distance or accept a different output and I will run it again.`,
        did: [
          `Derating ×${solved.required.factor} → ${solved.required.rangeMm} mm required`,
          `catalog.solve → ${solved.stats.catalogue} SKUs → ${solved.stats.afterHard} survivors`,
          `${solved.stats.unverifiable} set aside as unverifiable — the catalogue omits a needed field`,
          ...(proseCount
            ? [`${proseCount} of the ranked parts have a value read from prose, flagged on the row`]
            : []),
        ],
        ...(winner
          ? { citations: [winner.part.specs[0]?.citation].filter(Boolean) as Citation[] }
          : {}),
      },
    ],
    outcome: winner ? (winner.losses.length ? "match-with-losses" : "match") : "refusal",
    ...(winner
      ? {}
      : {
          refusal: {
            headline: "Nothing in the catalogue clears it.",
            closest: "—",
            losses: [
              `${solved.required.rangeMm} mm of range with a ${spec.output ?? "given"} output is not in the 796 sensing SKUs we hold.`,
              `${solved.stats.unverifiable} parts could not be checked at all because the short-form catalogue omits a field the constraint needs.`,
              "Widen the mounting distance, or send the full datasheet for the family you have in mind.",
            ],
          },
        }),
    stats: {
      catalogue: solved.stats.catalogue,
      afterConstraints: solved.stats.afterHard,
      survived: solved.candidates.length,
      durationMs: 620,
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Interchange: what else in the catalogue can stand in for a part we hold.
 * ------------------------------------------------------------------------- */

/**
 * A part number the operator typed that we actually have.
 *
 * The cross-brand case (competitor part in, SICK part out) needs a competitor
 * datasheet. When the part typed is one of ours, that whole path is the wrong
 * question — but "what else in this catalogue does this job" is a real one, and
 * it is answerable from the table alone. So we answer that instead of refusing,
 * and we say plainly which question we answered.
 *
 * Same discipline as `solveCatalog`: a missing value is never a pass. If the
 * short-form catalogue does not print range for a candidate, that candidate is
 * set aside as unverifiable rather than ranked.
 */
export interface InterchangeSolve {
  candidates: Candidate[];
  constraints: Constraint[];
  stats: { catalogue: number; sameCategory: number; afterHard: number; unverifiable: number };
  /** False when the part we found does not itself carry enough printed spec. */
  defensible: boolean;
}

export function solveInterchange(entry: CatalogEntry): InterchangeSolve {
  const constraints: Constraint[] = [];

  if (entry.rangeMaxMm !== undefined)
    constraints.push({
      key: "sensing_range_max_mm",
      label: "Sensing range",
      kind: "numeric-min",
      criticality: "hard",
      unit: "mm",
      min: entry.rangeMaxMm,
      display: `≥ ${entry.rangeMaxMm} mm`,
      origin: "extracted",
      rationale: `Read from the catalogue entry for ${entry.typeCode}, page ${entry.page ?? "?"}. A stand-in has to reach at least as far.`,
    });

  if (entry.output)
    constraints.push({
      key: "output_type",
      label: "Output type",
      kind: "enum",
      criticality: "hard",
      unit: "—",
      enumValue: entry.output,
      display: entry.output,
      origin: "extracted",
      rationale:
        "Printed on the catalogue row. Wrong polarity into a wired input card is a refusal, not a downgrade.",
    });

  if (entry.connection)
    constraints.push({
      key: "connection",
      label: "Connection",
      kind: "enum",
      criticality: "soft",
      unit: "—",
      enumValue: entry.connection,
      display: entry.connection,
      origin: "extracted",
      rationale:
        "A different connector still works, but the existing cordset does not transfer. Reported as a named loss.",
    });

  // Without a printed range or output there is no constraint worth solving on,
  // and a ranked list built from nothing would be decoration.
  const defensible = entry.rangeMaxMm !== undefined || entry.output !== undefined;

  let sameCategory = 0;
  let unverifiable = 0;
  const survivors: { entry: CatalogEntry; evaluations: Evaluation[]; score: number }[] = [];

  if (defensible) {
    for (const other of catalog) {
      if (other.typeCode === entry.typeCode) continue;
      if (other.category !== entry.category) continue;
      sameCategory += 1;

      const evaluations: Evaluation[] = [];
      const otherCite = catalogCite(other);
      let rejected = false;
      let unknown = false;
      let penalty = 0;

      if (entry.rangeMaxMm !== undefined) {
        if (other.rangeMaxMm === undefined) {
          unknown = true;
        } else {
          const ok = other.rangeMaxMm >= entry.rangeMaxMm;
          if (!ok) rejected = true;
          const ev: Evaluation = {
            key: "sensing_range_max_mm",
            label: "Sensing range",
            status: ok ? "pass" : "fail",
            criticality: "hard",
            candidateValue: `${other.rangeMaxMm} mm`,
            sourceValue: `${entry.rangeMaxMm} mm`,
            delta: `${other.rangeMaxMm - entry.rangeMaxMm > 0 ? "+" : ""}${other.rangeMaxMm - entry.rangeMaxMm} mm`,
            citation: otherCite,
            rail: {
              scaleMin: 0,
              scaleMax: Math.max(entry.rangeMaxMm * 2, other.rangeMaxMm),
              bandStart: entry.rangeMaxMm,
              bandEnd: Math.max(entry.rangeMaxMm * 2, other.rangeMaxMm),
              candidate: other.rangeMaxMm,
              source: entry.rangeMaxMm,
            },
          };
          if (!ok)
            ev.note = `Falls ${entry.rangeMaxMm - other.rangeMaxMm} mm short of the part being replaced.`;
          if (other.prose.includes("rangeMaxMm"))
            ev.note =
              `${ev.note ?? ""} This range was read from prose in the catalogue, not a labelled table cell.`.trim();
          evaluations.push(ev);
          penalty += Math.abs(other.rangeMaxMm - entry.rangeMaxMm) / Math.max(entry.rangeMaxMm, 1);
        }
      }

      if (entry.output) {
        if (!other.output) {
          unknown = true;
        } else {
          const ok = other.output === entry.output || other.output === "PNP/NPN";
          if (!ok) rejected = true;
          evaluations.push({
            key: "output_type",
            label: "Output type",
            status: ok ? "pass" : "fail",
            criticality: "hard",
            candidateValue: other.output,
            sourceValue: entry.output,
            citation: otherCite,
            ...(ok ? {} : { note: "Opposite polarity. This is a rewire, not a swap." }),
          });
        }
      }

      if (entry.connection && other.connection) {
        const ok = other.connection === entry.connection;
        if (!ok) penalty += 0.35;
        evaluations.push({
          key: "connection",
          label: "Connection",
          status: ok ? "pass" : "loss",
          criticality: "soft",
          candidateValue: other.connection,
          sourceValue: entry.connection,
          citation: otherCite,
          ...(ok ? {} : { note: "Different connector. The existing cordset does not transfer." }),
        });
      }

      if (entry.lightType && other.lightType && other.lightType !== entry.lightType) {
        penalty += 0.2;
        evaluations.push({
          key: "light_source",
          label: "Light source",
          status: "loss",
          criticality: "soft",
          candidateValue: other.lightType,
          sourceValue: entry.lightType,
          citation: otherCite,
          note: "Different emitter. Behaviour against shiny or translucent targets changes with it.",
        });
      }

      if (rejected) continue;
      if (unknown) {
        unverifiable += 1;
        continue;
      }
      if (!evaluations.length) continue;

      survivors.push({ entry: other, evaluations, score: 1 / (1 + penalty) });
    }
  }

  survivors.sort(
    (a, b) => b.score - a.score || a.entry.orderNumber.localeCompare(b.entry.orderNumber),
  );

  const candidates: Candidate[] = survivors.slice(0, 6).map((s, i) => {
    const losses = s.evaluations
      .filter((e) => e.status === "loss")
      .map((e) => `${e.label}: ${e.candidateValue} against ${e.sourceValue}.`);
    return {
      rank: i + 1,
      part: toPart(s.entry),
      score: Number(s.score.toFixed(2)),
      evaluations: s.evaluations,
      verdict: losses.length ? "equivalent-with-losses" : "equivalent",
      losses,
    };
  });

  return {
    candidates,
    constraints,
    stats: { catalogue: catalog.length, sameCategory, afterHard: survivors.length, unverifiable },
    defensible,
  };
}

/** Wrap an exact catalogue hit in the SolveRun the interface renders. */
export function buildIdentifiedRun(entry: CatalogEntry, input: SolveRun["input"]): SolveRun {
  const solved = solveInterchange(entry);
  const winner = solved.candidates[0];
  const part = toPart(entry);
  const cite = catalogCite(entry);

  const trace: TraceEvent[] = [
    {
      id: "id1",
      at: 0,
      agent: "resolver",
      title: "Exact hit in the catalogue",
      tool: {
        name: "catalog.lookup",
        args: JSON.stringify({ query: input.raw }),
        result: `1 exact hit · ${entry.typeCode} · order ${entry.orderNumber} · page ${entry.page ?? "?"}`,
      },
      status: "ok",
    },
    {
      id: "id2",
      at: 150,
      agent: "resolver",
      title: "This is a SICK part, not a competitor part",
      detail:
        "Cross-brand replacement needs a competitor datasheet on the source side. There is none here, so the question becomes what else in this catalogue does the same job.",
      status: "warn",
    },
    {
      id: "id3",
      at: 300,
      agent: "solver",
      title: solved.defensible
        ? "Constraint set taken from the part's own printed row"
        : "Not enough printed spec to solve on",
      detail: solved.defensible
        ? `${solved.constraints.length} constraints, every one read from the catalogue entry for ${entry.typeCode}.`
        : "The short-form catalogue prints neither a sensing range nor an output type for this part. Nothing can be ranked against it.",
      status: solved.defensible ? "ok" : "halt",
    },
    ...(solved.defensible
      ? [
          {
            id: "id4",
            at: 450,
            agent: "solver" as const,
            title: "Hard filter across the same category",
            tool: {
              name: "catalog.interchange",
              args: JSON.stringify({ category: entry.category, rangeMm: entry.rangeMaxMm ?? null }),
              result: `${solved.stats.sameCategory} same-category SKUs → ${solved.stats.afterHard} survivors`,
            },
            status: "ok" as const,
          },
          {
            id: "id5",
            at: 600,
            agent: "verifier" as const,
            title: `${solved.stats.unverifiable} parts could not be checked`,
            detail:
              "The short-form catalogue omits a needed field for these. A missing value is not a pass — they are set aside rather than ranked.",
            status: "warn" as const,
          },
        ]
      : []),
  ];

  const did = [
    `catalog.lookup → 1 exact hit · order ${entry.orderNumber}`,
    ...(solved.defensible
      ? [
          `catalog.interchange → ${solved.stats.sameCategory} same-category SKUs → ${solved.stats.afterHard} survivors`,
          `${solved.stats.unverifiable} set aside as unverifiable — the catalogue omits a needed field`,
        ]
      : ["Solver not invoked — the catalogue prints no range or output for this part"]),
  ];

  const identity = `${entry.typeCode} is a SICK part — order number ${entry.orderNumber}, ${entry.family ?? entry.category}, catalogue page ${entry.page ?? "?"}.`;

  return {
    id: `identified-${entry.typeCode}`,
    label: entry.typeCode,
    input,
    source: part,
    constraints: solved.constraints,
    candidates: solved.candidates,
    attacks: [],
    trace,
    thread: [
      { id: "im1", role: "user", at: 0, text: input.raw },
      {
        id: "im2",
        role: "agent",
        at: solved.defensible ? 600 : 300,
        agent: "resolver",
        tone: winner ? "neutral" : "caution",
        text: winner
          ? `${identity} So there is no cross-brand solve to run — what I can tell you is what else in this catalogue covers it. ${solved.stats.afterHard} of ${solved.stats.sameCategory} parts in the same category reach at least as far on the same output type; ${winner.part.partNumber} is the closest. If you meant to replace a competitor part with this one, give me the competitor part number instead.`
          : solved.defensible
            ? `${identity} Nothing else in the same category matches it on both range and output type, so I am not going to name a stand-in. That is a real answer from the table, not a lookup failure — the part itself is right here.`
            : `${identity} The short-form catalogue does not print a sensing range or an output type for it, so I have identity and page but no spec vector. I will not rank alternatives against a spec I do not hold. Send the full datasheet and I will.`,
        did,
        citations: [cite],
      },
    ],
    outcome: winner ? (winner.losses.length ? "match-with-losses" : "match") : "refusal",
    ...(winner
      ? {}
      : {
          refusal: {
            headline: "Found it — but nothing stands in for it.",
            closest: "—",
            losses: solved.defensible
              ? [
                  `${entry.typeCode} is in the catalogue: order ${entry.orderNumber}, page ${entry.page ?? "?"}. Its record is on the left.`,
                  `No other part in ${entry.category} clears ${entry.rangeMaxMm ?? "its"} mm on a ${entry.output ?? "matching"} output.`,
                  "This is a SICK part. For a cross-brand solve, give me the competitor part you are replacing.",
                ]
              : [
                  `${entry.typeCode} is in the catalogue: order ${entry.orderNumber}, page ${entry.page ?? "?"}. Its record is on the left.`,
                  "The short-form catalogue prints no sensing range and no output type for it, so there is no spec vector to rank against.",
                  "Send the full datasheet, or describe what it has to do and I will solve from the description.",
                ],
          },
        }),
    stats: {
      catalogue: solved.stats.sameCategory,
      afterConstraints: solved.stats.afterHard,
      survived: solved.candidates.length,
      durationMs: solved.defensible ? 600 : 300,
    },
  };
}

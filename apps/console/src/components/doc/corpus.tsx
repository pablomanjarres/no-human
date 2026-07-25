import { findPart, runs } from "@/data/runs";
import type { AgentName, Citation, EvalStatus, Part } from "@/lib/types";

/**
 * The offline corpus, as the citation viewer sees it.
 *
 * Two things live here and nothing else:
 *
 *  1. A record per document — what the file is, how many pages it has, where it
 *     sits on disk. The PDFs are cached at extraction time. Nothing in this
 *     route reads the network.
 *
 *  2. The extracted text layer, page by page. This is NOT the PDF and is not
 *     pretending to be one: it is the line list the extractor emitted, order
 *     preserved, table cells flattened to one line each. Every snippet quoted
 *     anywhere in the app appears here verbatim, which is the only reason the
 *     highlight can be trusted — the viewer matches whole lines, exactly.
 *
 * The citation index is derived, never hand-maintained: it is built by walking
 * `runs` and collecting every `Citation` that names the document. If a value
 * moves in the fixtures, this page follows it.
 */

// --- document records ------------------------------------------------------

export interface DocRecord {
  docId: string;
  title: string;
  brand: string;
  /** Pages in the source PDF. */
  pages: number;
  /** Path inside the offline corpus. Never served, never fetched. */
  file: string;
  /** The revision line as printed on the document. */
  revision: string;
  /** What the document is. */
  description: string;
  /** The part this datasheet documents — drives the to-scale housing. */
  part: string;
}

const DOCS: Record<string, DocRecord> = {
  "banner-qs18": {
    docId: "banner-qs18",
    title: "WORLD-BEAM QS18 — Datasheet 128140",
    brand: "Banner",
    pages: 8,
    file: "corpus/banner/128140_worldbeam_qs18_revG.pdf",
    revision: "Rev. G · 2019-11",
    description:
      "Family datasheet for the Banner WORLD-BEAM QS18. One document covers every model in the series, which is why the housing material in the series table on page 3 disagrees with the model-specific note on page 7.",
    part: "QS18VN6LV",
  },
  "sick-w4": {
    docId: "sick-w4",
    title: "W4 Photoelectric Sensors — Online Data Sheet",
    brand: "SICK",
    pages: 6,
    file: "corpus/sick/1041985_w4_wtb4-3n2261.pdf",
    revision: "8014052 · 2021-03",
    description:
      "SICK online data sheet for the WTB4-3N2261. It carries the remission derating table the headline sensing range is quoted against — page 2, three lines below the 600 mm figure.",
    part: "WTB4-3N2261",
  },
  "sick-w9": {
    docId: "sick-w9",
    title: "W9 Photoelectric Sensors — Online Data Sheet",
    brand: "SICK",
    pages: 6,
    file: "corpus/sick/1052653_w9_wtb9-3n2161.pdf",
    revision: "8020317 · 2022-06",
    description:
      "SICK online data sheet for the WTB9-3N2161. Holds the 6% remission figure the match turns on and the pin assignment that decides whether the installed cordset transfers.",
    part: "WTB9-3N2161",
  },
  "sick-w12": {
    docId: "sick-w12",
    title: "W12-3 Photoelectric Sensors — Online Data Sheet",
    brand: "SICK",
    pages: 6,
    file: "corpus/sick/1041274_w12-3_family.pdf",
    revision: "8009585 · 2021-09",
    description:
      "SICK online data sheet for the W12-3 family. It covers the WTB diffuse variant and the WL polarised retroreflective variant together, so two different response times are printed on the same page.",
    part: "WTB12-3N2431",
  },
  "pf-ml100": {
    docId: "pf-ml100",
    title: "ML100 Retroreflective — Datasheet 231456",
    brand: "Pepperl+Fuchs",
    pages: 4,
    file: "corpus/pepperl-fuchs/231456_ml100.pdf",
    revision: "Rev. 04 · 2020-02",
    description:
      "Pepperl+Fuchs datasheet for the ML100 base part. The model key on page 1 carries option codes /95 and /103. No page in this document says what they change, and no configuration sheet was ingested alongside it.",
    part: "ML100-8-1000-RT/95/103",
  },
};

/** Unknown ids resolve to nothing — the route answers with notFound(), not a guess. */
export function getDoc(docId: string): DocRecord | undefined {
  return DOCS[docId];
}

/**
 * The one place the citation route is spelled out. `Citation.href` in the
 * fixtures has to agree with this — if the viewer moves, both move together.
 */
export function docHref(docId: string, page: number, line?: number): string {
  const query = line === undefined ? `?page=${page}` : `?page=${page}&line=${line}`;
  return `/console/doc/${docId}${query}`;
}

// --- extracted text layer --------------------------------------------------

export type PageLine =
  | { kind: "head"; text: string }
  | { kind: "body"; text: string }
  /** An extractor annotation. Not text from the page — labelled as such on screen. */
  | { kind: "note"; text: string };

const H = (text: string): PageLine => ({ kind: "head", text });
const L = (text: string): PageLine => ({ kind: "body", text });
const N = (text: string): PageLine => ({ kind: "note", text });

/**
 * Only pages a value was read from are retained. The extractor discards the
 * rest of the text layer once the spec rows are emitted, so navigating to an
 * unretained page shows nothing rather than something invented.
 */
const TEXT: Record<string, Record<number, PageLine[]>> = {
  "banner-qs18": {
    1: [
      H("WORLD-BEAM QS18 SERIES"),
      L("Datasheet 128140 · Rev. G"),
      L("Self-contained miniature photoelectric sensors"),
      L("Models covered: QS18VN6D, QS18VN6LP, QS18VN6LV, QS18VP6LV, QS18AN6LV"),
      H("SELECTION — QS18VN6LV"),
      L("Sensing mode: diffuse with fixed-field background suppression"),
      L("Emitter: visible red"),
      L("Housing style: rectangular, side-mount"),
      L("Certifications: CE, UL, cULus"),
      L("Page 1 of 8"),
    ],
    2: [
      H("SPECIFICATIONS"),
      L("Range: 400 mm (90% reflectance white test card)"),
      L("Excess gain at 400 mm: 1.4"),
      L("Output: NPN (current sinking)"),
      L("Output rating: 100 mA max."),
      L("Programmable light operate / dark operate"),
      L("Output response time: 1 millisecond"),
      L("Repeatability: 300 microseconds"),
      L("Supply voltage: 10 to 30V dc"),
      L("Supply current: 25 mA max., exclusive of load"),
      L("Visible red LED, 660 nm"),
      L("Adjustment: 8-turn potentiometer or remote teach"),
      L("Page 2 of 8"),
    ],
    3: [
      H("CONSTRUCTION AND ENVIRONMENT — SERIES TABLE, ALL QS18 MODELS"),
      L("4-pin M12 quick-disconnect"),
      L("Cable models: 2 m PVC, 4-wire"),
      L("IEC IP67"),
      L("NEMA 6"),
      L("Housing: ABS/polycarbonate blend"),
      L("Lens: acrylic"),
      L("Operating: −20°C to +70°C"),
      L("Storage: −40°C to +80°C"),
      L("Relative humidity: 90% at 50°C, non-condensing"),
      L("Vibration: 10 to 55 Hz, 1 mm amplitude"),
      N("Series table. Values here are the widest case across the series, not per model."),
      L("Page 3 of 8"),
    ],
    4: [
      H("DIMENSIONS"),
      L("Dimensional drawing: 12 mm across the mounting face"),
      L("Overall length: 32 mm"),
      L("Overall height: 21 mm"),
      L("Mounting: two M3 clearance holes on 25 mm centres"),
      L("Optical axis: 10.5 mm from base"),
      L("Page 4 of 8"),
    ],
    7: [
      H("MODEL-SPECIFIC NOTES"),
      L("QS18VN6LV"),
      L("Housing: polycarbonate"),
      L("This note supersedes the series table on page 3 for this model."),
      L("Lens: acrylic, unchanged"),
      L("Chemical compatibility: see 128140-A"),
      L("Page 7 of 8"),
    ],
  },

  "sick-w4": {
    1: [
      H("WTB4-3N2261 · W4 PHOTOELECTRIC"),
      L("Online data sheet · Part no. 1041985"),
      L("Sensing mode: energetic / background suppression"),
      L("Product family: W4"),
      L("Housing: miniature rectangular"),
      L("Page 1 of 6"),
    ],
    2: [
      H("TECHNICAL DATA"),
      L("Sensing range max.: 600 mm, 90% reflectance"),
      L("Sensing range: 20 mm … 600 mm"),
      H("REMISSION DERATING"),
      L("Remission 90%: sensing range 600 mm"),
      L("Remission 18%: sensing range 400 mm"),
      L("Remission 6%: sensing range 250 mm"),
      L("Light source: PinPoint LED, red"),
      L("Output: NPN, 100 mA"),
      L("Response time: ≤ 1 ms"),
      L("Switching frequency: 500 Hz"),
      L("Supply voltage: 10 V DC … 30 V DC"),
      L("Page 2 of 6"),
    ],
    3: [
      H("MECHANICS AND ELECTRONICS"),
      L("Connection type: male connector M12, 4-pin"),
      L("Enclosure rating: IP67"),
      L("Housing material: ABS"),
      L("Ambient operating temperature: −25 °C … +55 °C"),
      L("Weight: 15 g"),
      L("Page 3 of 6"),
    ],
    4: [
      H("DIMENSIONAL DRAWING"),
      L("Dimensional drawing: 11 mm"),
      L("Length: 32 mm"),
      L("Height: 20 mm"),
      L("Optical axis: 9 mm from mounting face"),
      L("Page 4 of 6"),
    ],
  },

  "sick-w9": {
    1: [
      H("WTB9-3N2161 · W9 PHOTOELECTRIC"),
      L("Online data sheet · Part no. 1052653"),
      L("Sensing mode: background suppression"),
      L("Product family: W9"),
      L("Supersedes W9-2 in new installations"),
      L("Page 1 of 6"),
    ],
    2: [
      H("TECHNICAL DATA"),
      L("Sensing range max.: 700 mm, 90% reflectance"),
      L("Sensing range: 30 mm … 700 mm"),
      H("REMISSION DERATING"),
      L("18% remission: 520 mm"),
      L("6% remission: 420 mm"),
      L("Light source: PinPoint LED, red, 655 nm"),
      L("Output: NPN, 100 mA"),
      L("Light/dark switching, teach-in"),
      L("Response time: ≤ 1.5 ms"),
      L("Switching frequency: 330 Hz"),
      L("Supply voltage V_S: 10 V DC … 30 V DC"),
      L("Residual ripple: ≤ 5 V_ss"),
      L("Page 2 of 6"),
    ],
    3: [
      H("MECHANICS AND ELECTRONICS"),
      L("Connection type: male connector M12, 4-pin"),
      H("PIN ASSIGNMENT"),
      L("Pin 1: L+, Pin 3: M, Pin 4: Q"),
      L("Pin 2: not connected"),
      L("Enclosure rating: IP67"),
      L("Housing material: ABS"),
      L("Ambient operating temperature: −30 °C … +60 °C"),
      L("Weight: 25 g"),
      L("Page 3 of 6"),
    ],
    4: [
      H("DIMENSIONAL DRAWING"),
      L("Dimensional drawing: 15.0 mm"),
      L("Length: 42.0 mm"),
      L("Height: 27.0 mm"),
      L("Optical axis: 12.5 mm from mounting face"),
      L("Mounting: 2 × M3 through holes, 32 mm centres"),
      L("Page 4 of 6"),
    ],
  },

  "sick-w12": {
    2: [
      H("TECHNICAL DATA — W12-3 FAMILY"),
      L("Variant WTB12-3N2431 · diffuse, background suppression"),
      L("Sensing range max.: 1,100 mm"),
      L("Response time: ≤ 2 ms"),
      L("Output: NPN"),
      L("Switching frequency: 250 Hz"),
      L("Variant WL12-3P2431 · retroreflective, polarised"),
      L("Sensing range max.: 6,500 mm with PL80A reflector"),
      L("Response time: ≤ 1.5 ms"),
      L("Output: PNP"),
      L("Supply voltage: 10 V DC … 30 V DC"),
      N("Two variants share this table. Response time differs by row, not by column."),
      L("Page 2 of 6"),
    ],
    3: [
      H("MECHANICS AND ELECTRONICS"),
      L("M12, 4-pin"),
      L("Alternative: cable, 2 m, 4-wire"),
      L("IP67"),
      L("Housing material: ABS"),
      L("Ambient operating temperature: −40 °C … +60 °C"),
      L("Page 3 of 6"),
    ],
    4: [
      H("DIMENSIONAL DRAWING"),
      L("Width across mounting face"),
      L("20 mm"),
      L("Length: 50 mm"),
      L("Height: 32 mm"),
      L("Optical axis: 15 mm from mounting face"),
      L("Page 4 of 6"),
    ],
  },

  "pf-ml100": {
    1: [
      H("ML100 · POLARISED RETROREFLECTIVE"),
      L("Datasheet 231456 · Rev. 04"),
      L("Polarised retroreflective sensor"),
      L("Model key: ML100-8-1000-RT/95/103"),
      L("Base model: ML100-8-1000-RT"),
      L("Option codes: see configuration sheet"),
      N("No configuration sheet for /95 or /103 was ingested with this document."),
      L("Page 1 of 4"),
    ],
    2: [
      H("TECHNICAL DATA"),
      L("Operating range: 0 … 1,000 mm"),
      L("Reflector: C110-2 or equivalent"),
      L("Output type: PNP"),
      L("Response time: 300 µs"),
      L("Switching frequency: 1,500 Hz"),
      L("Light source: red LED, 640 nm, polarising filter"),
      L("Supply voltage: 10 … 30 V DC"),
      L("Page 2 of 4"),
    ],
    3: [
      H("MECHANICAL DATA"),
      L("Connection: M12 × 1, 4-pin"),
      L("Degree of protection: IP67"),
      L("Housing material: PC"),
      L("Ambient temperature: −25 … +55 °C"),
      L("Dimensions: 42 × 15 × 30 mm"),
      L("Page 3 of 4"),
    ],
  },
};

/** Pages whose text layer survived extraction, ascending. */
export function retainedPages(docId: string): number[] {
  const doc = TEXT[docId];
  if (!doc) return [];
  return Object.keys(doc)
    .map(Number)
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
}

/**
 * The line list for one page. Any cited snippet the fixtures carry but the text
 * layer is missing is appended rather than dropped — a citation must never
 * point at a line the viewer cannot show.
 */
export function linesFor(docId: string, page: number): PageLine[] {
  const base = TEXT[docId]?.[page] ?? [];
  const missing = citationsFor(docId)
    .filter((c) => c.page === page && c.snippet !== "" && !base.some((l) => l.text === c.snippet))
    .map((c) => L(c.snippet));
  return missing.length > 0 ? [...base, ...missing] : base;
}

// --- citation index --------------------------------------------------------

/** One place in the workspace where a quoted line is used. */
export interface CitationUse {
  agent: AgentName;
  /** What the quote is doing there. */
  what: string;
  /** Runs this use appears in. */
  inRuns: string[];
  status?: EvalStatus;
}

/** A quoted line: one page, one exact snippet, every use behind it. */
export interface CitedLine {
  page: number;
  snippet: string;
  uses: CitationUse[];
  agents: AgentName[];
}

export interface CitedPageGroup {
  page: number;
  lines: CitedLine[];
}

const AGENT_ORDER: Record<AgentName, number> = {
  extractor: 0,
  verifier: 1,
  resolver: 2,
  solver: 3,
  challenger: 4,
};

/** Spec rows print the unit separately, except where the value already carries it. */
const withUnit = (value: string, unit: string): string => {
  if (unit === "—" || unit === "") return value;
  if (value.toLowerCase().endsWith(unit.toLowerCase())) return value;
  return `${value} ${unit}`;
};

const cache = new Map<string, CitedLine[]>();

/** Every distinct line of this document that something on screen quotes. */
export function citationsFor(docId: string): CitedLine[] {
  const hit = cache.get(docId);
  if (hit) return hit;

  const byLine = new Map<string, CitedLine>();

  const add = (c: Citation, runId: string, use: Omit<CitationUse, "inRuns">): void => {
    if (c.docId !== docId) return;
    const snippet = c.snippet ?? "";
    const lineKey = `${c.page} ${snippet}`;
    let line = byLine.get(lineKey);
    if (!line) {
      line = { page: c.page, snippet, uses: [], agents: [] };
      byLine.set(lineKey, line);
    }
    const existing = line.uses.find((u) => u.agent === use.agent && u.what === use.what);
    if (existing) {
      if (!existing.inRuns.includes(runId)) existing.inRuns.push(runId);
    } else {
      line.uses.push({ ...use, inRuns: [runId] });
    }
    if (!line.agents.includes(use.agent)) line.agents.push(use.agent);
  };

  for (const run of runs) {
    for (const spec of run.source.specs) {
      add(spec.citation, run.id, {
        agent: "extractor",
        what: `Source spec · ${spec.label} = ${withUnit(spec.value, spec.unit)}`,
      });
      if (spec.dispute) {
        add(spec.citation, run.id, {
          agent: "verifier",
          what: `Dispute · verifier read “${spec.dispute.verified}” instead`,
        });
      }
    }

    for (const candidate of run.candidates) {
      for (const spec of candidate.part.specs) {
        add(spec.citation, run.id, {
          agent: "extractor",
          what: `${candidate.part.partNumber} spec · ${spec.label} = ${withUnit(spec.value, spec.unit)}`,
        });
      }
      for (const evaluation of candidate.evaluations) {
        add(evaluation.citation, run.id, {
          agent: "solver",
          what: `${candidate.part.partNumber} · ${evaluation.label} — ${evaluation.candidateValue} against ${evaluation.sourceValue}`,
          status: evaluation.status,
        });
      }
    }

    for (const attack of run.attacks) {
      add(attack.citation, run.id, {
        agent: "challenger",
        what: `Attack ${attack.id} · ${
          attack.outcome === "kill"
            ? `killed ${attack.targetPart}`
            : `${attack.targetPart} survived it`
        }`,
        status: attack.outcome === "kill" ? "fail" : "info",
      });
    }

    for (const message of run.thread) {
      if (message.role !== "agent" || !message.citations) continue;
      for (const c of message.citations) {
        add(c, run.id, {
          agent: message.agent,
          what: `Consultation turn ${message.id} · quoted back to the operator`,
        });
      }
    }
  }

  const lines = [...byLine.values()];
  for (const line of lines) {
    line.uses.sort((a, b) => AGENT_ORDER[a.agent] - AGENT_ORDER[b.agent]);
    line.agents.sort((a, b) => AGENT_ORDER[a] - AGENT_ORDER[b]);
  }
  lines.sort((a, b) => a.page - b.page || a.snippet.localeCompare(b.snippet));

  cache.set(docId, lines);
  return lines;
}

/** Cited lines grouped by page, each page ordered as the text layer prints it. */
export function pageGroups(docId: string): CitedPageGroup[] {
  const groups = new Map<number, CitedLine[]>();
  for (const line of citationsFor(docId)) {
    const bucket = groups.get(line.page);
    if (bucket) bucket.push(line);
    else groups.set(line.page, [line]);
  }

  return [...groups.entries()]
    .map(([page, lines]) => {
      const text = linesFor(docId, page);
      const positioned = [...lines].sort((a, b) => {
        const ia = text.findIndex((l) => l.text === a.snippet);
        const ib = text.findIndex((l) => l.text === b.snippet);
        return (
          (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib)
        );
      });
      return { page, lines: positioned };
    })
    .sort((a, b) => a.page - b.page);
}

// --- part lookup -----------------------------------------------------------

const ALL_PARTS: Part[] = runs.flatMap((run) => [run.source, ...run.candidates.map((c) => c.part)]);

/** The part this datasheet documents, so the header can draw it to scale. */
export function partForDoc(doc: DocRecord): Part | undefined {
  return (
    findPart(doc.part) ??
    ALL_PARTS.find((p) => p.partNumber.toLowerCase() === doc.part.toLowerCase())
  );
}

// --- agent presentation ----------------------------------------------------

export const AGENT_TAG: Record<AgentName, { short: string; label: string; accent: string }> = {
  extractor: { short: "EXT", label: "Extractor — read the value off the page", accent: "rail" },
  verifier: { short: "VER", label: "Verifier — re-read the page and disagreed", accent: "signal" },
  resolver: { short: "RES", label: "Resolver — turned the input into constraints", accent: "rail" },
  solver: { short: "SLV", label: "Solver — scored the value against a constraint", accent: "sick" },
  challenger: {
    short: "CHL",
    label: "Challenger — attacked the match with this line",
    accent: "halt",
  },
};

/** Run labels, for showing where a quote is used. */
export function runLabel(runId: string): string {
  return runs.find((r) => r.id === runId)?.label ?? runId;
}

#!/usr/bin/env node
/**
 * `sick-rag` — the operator surface for the SICK catalog index.
 *
 * Five commands: `index` builds the artifact, `search` runs hybrid retrieval,
 * `get` dumps one SKU, `solve` runs the deterministic constraint solver, and
 * `stats` reports what the artifact actually contains.
 *
 * ## Why the output looks the way it does
 *
 * The point of this tool is not to be convenient — it is to be *checkable*. So:
 *
 * - **`search` prints every lane's rank and score, and a `-` for a lane that did
 *   not run.** A number nobody can trace is a number nobody should trust. If the
 *   dense lane was off because there is no API key, the trace says so instead of
 *   quietly showing BM25 results as if they were hybrid.
 * - **`solve` prints a per-constraint verdict table, `unknown` rows included.**
 *   This table is the deliverable: a skeptical engineer must be able to open the
 *   cited catalog page and re-derive every `pass` / `fail` by hand. Hiding the
 *   `unknown` rows would turn "the catalog is silent about response time" into
 *   an implied "response time checks out", which is exactly the confident wrong
 *   answer this whole package is built to avoid.
 * - **Ranking and matching are printed by different commands.** `search` ranks;
 *   it never claims a part is correct. `solve` decides; it never consults a
 *   similarity score. Keeping them separate on screen keeps them separate in the
 *   reader's head.
 *
 * ## Conventions
 *
 * Argv is parsed by hand — no dependency, and the flag set is small enough that
 * a parser is cheaper than a library. Human output goes to stdout, progress and
 * diagnostics to stderr, so `--json` output stays pipeable. `--help` and an
 * unknown command exit 0 with usage; a real failure exits 1 with a one-line
 * message on stderr and no stack trace (set `SICK_RAG_DEBUG=1` for the stack).
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndex } from "./buildIndex.js";
import { readIndex, writeIndex } from "./index/store.js";
import { createRetriever, type Retriever } from "./retrieve.js";
import type {
  Citation,
  ConnectorType,
  ConstraintVerdict,
  NormalizedSpec,
  OutputType,
  RetrievalResult,
  RowType,
  SearchOptions,
  SerializedIndex,
  SickProduct,
  SolveResult,
  SpecConstraints,
} from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * `packages/rag/src` (or `packages/rag/dist` after a build) → repo root.
 *
 * Derived from `import.meta.url`, never from `process.cwd()`: the default index
 * path has to mean the same file whether the CLI is run from the repo root, from
 * the package directory, or through a `node_modules/.bin` shim.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const DEFAULT_DATASET_DIR = join(REPO_ROOT, "sick-catalog-dataset");
const DEFAULT_INDEX_PATH = join(DEFAULT_DATASET_DIR, "rag-index.json");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failure the user can act on: bad flag, missing artifact, unknown SKU.
 *
 * Separated from a genuine crash so the top-level handler can print one clear
 * line instead of a stack trace. A stack trace as the primary error message
 * tells an operator nothing about what to type next.
 */
class CliError extends Error {}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

/** Flags that consume the following token (or use `--flag=value`). */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "dataset",
  "out",
  "index",
  "top",
  "ip",
  "range-min",
  "range-max",
  "response-max",
  "connector",
  "section",
  "family",
]);

/** Flags that are presence-only. */
const BOOL_FLAGS: ReadonlySet<string> = new Set([
  "no-embed",
  "pnp",
  "npn",
  "ip69k",
  "json",
  "no-rerank",
  "no-dense",
  "products-only",
  "help",
]);

/**
 * Parsed command line.
 *
 * Values are kept as arrays because the constraint flags are genuinely
 * repeatable (`--section B --section C` is a legitimate two-section filter) and
 * silently keeping only the last one would answer a different question than the
 * one that was asked.
 */
interface Argv {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string[]>;
  bools: Set<string>;
}

function parseArgv(tokens: readonly string[]): Argv {
  const argv: Argv = { command: undefined, positionals: [], flags: new Map(), bools: new Set() };
  let literal = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    if (literal || (!token.startsWith("-") && token !== "-")) {
      if (argv.command === undefined && !literal) argv.command = token;
      else argv.positionals.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (token === "-h") {
      argv.bools.add("help");
      continue;
    }

    const body = token.startsWith("--") ? token.slice(2) : token.slice(1);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

    if (BOOL_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        throw new CliError(
          `--${name} is a switch and takes no value (got --${name}=${inlineValue})`,
        );
      }
      argv.bools.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new CliError(`unknown option --${name}. Run \`sick-rag --help\` for the flag list.`);
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = tokens[i + 1];
      // A `--` prefix on the next token means the value was forgotten; consuming
      // it would silently eat the following flag and change the query.
      if (next === undefined || next.startsWith("--")) {
        throw new CliError(`--${name} requires a value`);
      }
      value = next;
      i += 1;
    }
    const bucket = argv.flags.get(name);
    if (bucket) bucket.push(value);
    else argv.flags.set(name, [value]);
  }

  return argv;
}

const has = (argv: Argv, name: string): boolean => argv.bools.has(name);
const list = (argv: Argv, name: string): string[] => argv.flags.get(name) ?? [];

function one(argv: Argv, name: string): string | undefined {
  const values = list(argv, name);
  return values.length === 0 ? undefined : values[values.length - 1];
}

/** Numeric flag read that refuses to invent a value from garbage. */
function num(argv: Argv, name: string): number | undefined {
  const raw = one(argv, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new CliError(`--${name} expects a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

const CONNECTOR_ALIASES: ReadonlyMap<string, ConnectorType> = new Map<string, ConnectorType>([
  ["m5", "M5"],
  ["m8", "M8"],
  ["m12", "M12"],
  ["cable", "cable"],
  ["terminal", "terminal"],
  ["terminals", "terminal"],
  ["other", "other"],
]);

/**
 * Turn constraint flags into a {@link SpecConstraints}.
 *
 * Two decisions worth knowing about:
 *
 * - **`--pnp` accepts `PNP/NPN` as well as `PNP`.** A part whose catalog row
 *   says the output is switchable between PNP and NPN genuinely satisfies a PNP
 *   requirement. Matching only the literal `PNP` would drop real, correct
 *   equivalents — a false negative that reads as "SICK has no equivalent".
 * - **A bare `--range-max` is a *requested detection distance*, not a ceiling on
 *   the sensor's rating.** `SpecConstraints.sensingRangeMm` asks "must be able to
 *   detect at this distance"; the solver fails a candidate whose printed maximum
 *   is shorter. Naming it `--range-max` matches the field, but the help text
 *   spells out the semantics because getting this backwards silently inverts the
 *   candidate set.
 */
function buildConstraints(argv: Argv): SpecConstraints {
  const constraints: SpecConstraints = {};

  const outputType: OutputType[] = [];
  if (has(argv, "pnp")) outputType.push("PNP", "PNP/NPN");
  if (has(argv, "npn")) outputType.push("NPN", "PNP/NPN");
  if (outputType.length > 0) constraints.outputType = [...new Set(outputType)];

  const ip = num(argv, "ip");
  if (ip !== undefined) constraints.minIpRating = ip;
  if (has(argv, "ip69k")) constraints.ip69k = true;

  const rangeMin = num(argv, "range-min");
  const rangeMax = num(argv, "range-max");
  if (rangeMin !== undefined || rangeMax !== undefined) {
    constraints.sensingRangeMm = {
      ...(rangeMin !== undefined ? { min: rangeMin } : {}),
      ...(rangeMax !== undefined ? { max: rangeMax } : {}),
    };
  }

  const responseMax = num(argv, "response-max");
  if (responseMax !== undefined) constraints.responseTimeMs = { max: responseMax };

  const connectors = list(argv, "connector");
  if (connectors.length > 0) {
    constraints.connector = connectors.map((raw) => {
      const mapped = CONNECTOR_ALIASES.get(raw.trim().toLowerCase());
      if (mapped === undefined) {
        throw new CliError(
          `--connector expects one of M5, M8, M12, cable, terminal, other; got ${JSON.stringify(raw)}`,
        );
      }
      return mapped;
    });
  }

  const sections = list(argv, "section");
  if (sections.length > 0) constraints.section = sections.map((s) => s.trim().toUpperCase());

  const families = list(argv, "family");
  if (families.length > 0) constraints.family = families.map((f) => f.trim());

  if (has(argv, "products-only")) constraints.rowType = ["product" satisfies RowType];

  return constraints;
}

/** Human summary of what was actually constrained — printed above every result set. */
function describeConstraints(c: SpecConstraints): string {
  const parts: string[] = [];
  if (c.outputType) parts.push(`output ∈ {${c.outputType.join(", ")}}`);
  if (c.ioLink !== undefined) parts.push(`IO-Link ${c.ioLink ? "required" : "excluded"}`);
  if (c.connector) parts.push(`connector ∈ {${c.connector.join(", ")}}`);
  if (c.connectorPins !== undefined) parts.push(`${String(c.connectorPins)} pins`);
  if (c.minIpRating !== undefined) parts.push(`IP ≥ ${String(c.minIpRating)}`);
  if (c.ip69k === true) parts.push("IP69K");
  if (c.sensingRangeMm) {
    const { min, max } = c.sensingRangeMm;
    parts.push(
      min !== undefined && max !== undefined
        ? `detects across ${String(min)}–${String(max)} mm`
        : `detects at ${String(min ?? max)} mm`,
    );
  }
  if (c.responseTimeMs?.max !== undefined)
    parts.push(`response ≤ ${String(c.responseTimeMs.max)} ms`);
  if (c.section) parts.push(`section ∈ {${c.section.join(", ")}}`);
  if (c.family) parts.push(`family ∈ {${c.family.join(", ")}}`);
  if (c.rowType) parts.push(`row type ∈ {${c.rowType.join(", ")}}`);
  return parts.length === 0 ? "none" : parts.join(" · ");
}

const constraintCount = (c: SpecConstraints): number =>
  Object.values(c).filter((v) => v !== undefined).length;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};
const note = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + " ".repeat(width - text.length);

const json = (value: unknown): void => {
  out(JSON.stringify(value, null, 2));
};

/** `3` → `3`, `0.8123` → `0.812`. Keeps score columns aligned and readable. */
function score(value: number | null): string {
  if (value === null) return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/** `rank #2 (0.812)`, or a bare `-` when the lane produced nothing for this hit. */
function lane(rank: number | null, value: number | null): string {
  if (rank === null) return "-";
  return `#${String(rank)} (${score(value)})`;
}

/** Citation as one line an operator can take to the PDF. */
function citationLine(citation: Citation): string {
  const bits = [`page ${citation.sourcePage}`, `pdf p.${String(citation.pdfPage + 1)}`];
  if (citation.productUrl !== undefined) bits.push(citation.productUrl);
  return bits.join(" · ");
}

/** Fallback citation, so `get` still cites a page if the retriever hands back a bare product. */
function citationFor(product: SickProduct): Citation {
  return {
    orderNumber: product.orderNumber,
    ...(product.typeCode !== undefined ? { typeCode: product.typeCode } : {}),
    ...(product.family !== undefined ? { family: product.family } : {}),
    sourcePage: product.sourcePage,
    pdfPage: product.pdfPage,
    ...(product.productUrl !== undefined ? { productUrl: product.productUrl } : {}),
  };
}

// ---------------------------------------------------------------------------
// Index loading
// ---------------------------------------------------------------------------

function resolveIndexPath(argv: Argv): string {
  const explicit = one(argv, "index");
  if (explicit !== undefined) return resolve(explicit);
  const fromEnv = process.env["SICK_RAG_INDEX"];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv.trim());
  return DEFAULT_INDEX_PATH;
}

/**
 * Load the artifact, turning a missing file into the one instruction that fixes
 * it. "ENOENT" is not an answer; "run `sick-rag index`" is.
 */
async function loadIndex(argv: Argv): Promise<{ path: string; index: SerializedIndex }> {
  const path = resolveIndexPath(argv);
  try {
    return { path, index: await readIndex(path) };
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    if (code === "ENOENT") {
      throw new CliError(
        `no index artifact at ${path}\n  Build one with:  sick-rag index\n  Or point at another file with --index <file> or SICK_RAG_INDEX.`,
      );
    }
    throw new CliError(
      `could not read the index at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

async function openRetriever(argv: Argv): Promise<{
  path: string;
  index: SerializedIndex;
  retriever: Retriever;
}> {
  const { path, index } = await loadIndex(argv);
  // Construction is where BM25 tokenization and vector decoding happen, so it is
  // done once per invocation and never inside a command's inner loop.
  return { path, index, retriever: createRetriever(index) };
}

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

async function cmdIndex(argv: Argv): Promise<void> {
  const datasetDir = resolve(one(argv, "dataset") ?? DEFAULT_DATASET_DIR);
  const outPath = resolve(one(argv, "out") ?? resolveIndexPath(argv));
  const embed = !has(argv, "no-embed");

  const index = await buildIndex({
    datasetDir,
    embed,
    // Progress goes to stderr so `sick-rag index --out - > file` style piping
    // and CI log capture stay clean.
    onProgress: (msg) => note(`  ${msg}`),
  });

  await writeIndex(outPath, index);

  const p = index.provenance;
  const skus = index.products.filter((prod) => prod.rowType === "product").length;
  out(`wrote ${outPath}`);
  out(`  chunks       ${String(p.chunkCount)}`);
  out(`  documents    ${String(p.documentCount)}`);
  out(
    `  products     ${String(p.productCount)} (${String(skus)} variants, ${String(p.productCount - skus)} accessories)`,
  );
  out(`  families     ${String(index.families.length)}`);
  out(
    p.embeddingModel === null
      ? "  dense lane   OFF — lexical-only index (BM25 + deterministic solver)"
      : `  dense lane   ON — ${p.embeddingModel}, dim ${String(p.embeddingDimension ?? 0)}, ${String(p.embeddedChunkCount)} chunks embedded`,
  );
  out(`  built at     ${p.builtAt}`);
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async function cmdSearch(argv: Argv): Promise<void> {
  // Bare words are joined so both `search "a b c"` and `search a b c` work — a
  // paste out of a BOM row rarely arrives quoted.
  const query = argv.positionals.join(" ").trim();
  if (query === "") {
    throw new CliError('search needs a query, e.g. sick-rag search "retroreflective sensor M12"');
  }

  const { index, retriever } = await openRetriever(argv);
  const constraints = buildConstraints(argv);
  const topK = num(argv, "top") ?? 10;

  const opts: SearchOptions = {
    topK,
    ...(constraintCount(constraints) > 0 ? { constraints } : {}),
    ...(has(argv, "no-rerank") ? { noRerank: true } : {}),
    ...(has(argv, "no-dense") ? { noDense: true } : {}),
  };
  const results = await retriever.search(query, opts);

  if (has(argv, "json")) {
    json({ query, constraints, topK, results });
    return;
  }

  // Lane availability is derived from what actually came back, not from what we
  // hoped would run — the trace has to describe the search that happened.
  const ran = (pick: (r: RetrievalResult) => number | null): boolean =>
    results.some((r) => pick(r) !== null);
  const bm25On = ran((r) => r.signals.bm25Rank);
  const denseOn = ran((r) => r.signals.denseRank);
  const rerankOn = ran((r) => r.signals.rerankRank);

  out(`query        ${query}`);
  out(`constraints  ${describeConstraints(constraints)}`);
  out(
    `lanes        bm25 ${bm25On ? "on" : "off"} · dense ${
      denseOn
        ? "on"
        : index.provenance.embeddedChunkCount === 0
          ? "off (index has no vectors)"
          : "off"
    } · rerank ${rerankOn ? "on" : "off"}`,
  );
  out(`results      ${String(results.length)}`);
  out();

  if (results.length === 0) {
    out("no candidates. Loosen a constraint, or search a broader phrase.");
    return;
  }

  out(
    `${pad("#", 4)}${pad("TYPE CODE", 20)}${pad("ORDER", 9)}${pad("FAMILY", 12)}${pad("PAGE", 8)}${pad("BM25", 16)}${pad("DENSE", 16)}${pad("RERANK", 16)}RRF`,
  );
  results.forEach((result, i) => {
    const s = result.signals;
    const chunk = result.chunk;
    out(
      pad(String(i + 1), 4) +
        pad(result.product?.typeCode ?? (chunk.kind === "family" ? "(family card)" : "—"), 20) +
        pad(chunk.orderNumber ?? "—", 9) +
        pad(chunk.family ?? "—", 12) +
        pad(chunk.sourcePage, 8) +
        pad(lane(s.bm25Rank, s.bm25Score), 16) +
        pad(lane(s.denseRank, s.denseScore), 16) +
        pad(lane(s.rerankRank, s.rerankScore), 16) +
        score(s.rrfScore),
    );
    out(`    ${citationLine(result.citation)}`);
  });

  out();
  out("These are candidates, not a recommendation. Run `sick-rag solve` to decide.");
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

/** Labels for the structured fields, in the order an engineer reads a datasheet. */
const PRODUCT_FIELD_ORDER: readonly (keyof SickProduct)[] = [
  "typeCode",
  "orderNumber",
  "family",
  "subfamily",
  "rowType",
  "category",
  "section",
  "sourcePage",
  "pdfPage",
  "occurrences",
  "alsoOnPages",
  "productName",
  "shortDescription",
  "sensorPrinciple",
  "detectionPrinciple",
  "lightType",
  "lightSpot",
  "sensingRangeMinMm",
  "sensingRangeMaxMm",
  "switchingOutput",
  "outputFunction",
  "outputCurrentMaxMa",
  "responseTimeMs",
  "switchingFrequencyHz",
  "supplyVoltageMinV",
  "supplyVoltageMaxV",
  "operatingTempMinC",
  "operatingTempMaxC",
  "resolutionValue",
  "resolutionUnit",
  "connection",
  "interface",
  "enclosureRating",
  "housingMaterial",
  "adjustment",
  "scopeOfDelivery",
  "productUrl",
];

/**
 * Labels that need the unit or the base spelled out.
 *
 * `pdfPage` is 0-based in the data but citations print the 1-based number a PDF
 * viewer shows; seeing `pdfPage 16` under `pdf p.17` without this note reads as
 * an off-by-one bug in the citation.
 */
const FIELD_LABEL_NOTE: Readonly<Partial<Record<keyof SickProduct, string>>> = {
  pdfPage: "pdfPage (0-based)",
};

function renderScalar(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.length === 0 ? undefined : value.join(", ");
  if (typeof value === "object") return undefined;
  return String(value);
}

async function cmdGet(argv: Argv): Promise<void> {
  const orderNumber = argv.positionals[0]?.trim();
  if (orderNumber === undefined || orderNumber === "") {
    throw new CliError("get needs an order number, e.g. sick-rag get 1052442");
  }

  const { retriever } = await openRetriever(argv);
  const found = retriever.getProduct(orderNumber);
  if (found === undefined) {
    throw new CliError(
      `order number ${orderNumber} is not in this index. Order numbers are exactly 7 digits (e.g. 1052442).`,
    );
  }

  const { product, spec } = found;
  const citation = citationFor(product);

  if (has(argv, "json")) {
    json({ product, spec, citation });
    return;
  }

  // A field the catalog read from prose rather than a labelled table cell is
  // marked, not hidden: "double-check this line against the page" is actionable.
  const flagged = new Set(product.lowConfidence ?? []);

  out(`${product.typeCode ?? "(no type code)"}  ·  ${product.orderNumber}`);
  out(`${product.category}  ·  section ${product.section}  ·  ${product.rowType}`);
  out(citationLine(citation));
  out();

  out("CATALOG RECORD  (* = read from prose/bullets, verify against the page)");
  for (const field of PRODUCT_FIELD_ORDER) {
    const rendered = renderScalar(product[field]);
    if (rendered === undefined) continue;
    const label = FIELD_LABEL_NOTE[field] ?? field;
    out(`  ${pad(`${label}${flagged.has(field) ? " *" : ""}`, 24)}${rendered}`);
  }

  if (product.otherSpecs !== undefined) {
    out();
    out("OTHER SPECS  (labelled on the page, not mapped to a named column)");
    for (const [key, value] of Object.entries(product.otherSpecs)) {
      out(`  ${pad(key, 24)}${value}`);
    }
  }

  out();
  out("NORMALIZED SPEC  (what the solver compares — absent means the catalog is silent)");
  const specFlags = new Set(spec.lowConfidence);
  let printedSpecFields = 0;
  for (const [key, value] of Object.entries(spec)) {
    if (key === "orderNumber" || key === "lowConfidence") continue;
    const rendered = renderScalar(value);
    if (rendered === undefined) continue;
    out(`  ${pad(`${key}${specFlags.has(key) ? " *" : ""}`, 24)}${rendered}`);
    printedSpecFields += 1;
  }
  if (printedSpecFields === 0) {
    out("  (nothing normalizable — every constraint against this SKU resolves to `unknown`)");
  }

  if (product.provenance !== undefined) {
    out();
    out("PROVENANCE  (verbatim source text for each field)");
    for (const [key, value] of Object.entries(product.provenance)) {
      out(`  ${pad(key, 24)}${value}`);
    }
  }
}

// ---------------------------------------------------------------------------
// solve
// ---------------------------------------------------------------------------

const VERDICT_MARK: Readonly<Record<ConstraintVerdict["status"], string>> = {
  pass: "PASS   ",
  fail: "FAIL   ",
  unknown: "UNKNOWN",
};

async function cmdSolve(argv: Argv): Promise<void> {
  const constraints = buildConstraints(argv);
  if (constraintCount(constraints) === 0) {
    throw new CliError(
      "solve needs at least one constraint, e.g. --pnp --ip 67 --response-max 12. Run `sick-rag --help` for the list.",
    );
  }

  const { retriever } = await openRetriever(argv);
  const topK = num(argv, "top") ?? 10;
  // Solved over the WHOLE catalog, not over a search result set: this command is
  // the deterministic path, and seeding it from a similarity ranking would let a
  // score decide which parts got to be evaluated at all.
  const all = retriever.solveConstraints(constraints);
  const results = all.slice(0, topK);

  if (has(argv, "json")) {
    json({ constraints, evaluated: all.length, results });
    return;
  }

  const viable = all.filter((r) => r.viable).length;
  const fullyVerified = all.filter((r) => r.viable && r.unknown === 0).length;

  out(`constraints  ${describeConstraints(constraints)}`);
  out(`evaluated    ${String(all.length)} candidates`);
  out(`viable       ${String(viable)} (no printed spec contradicts the request)`);
  out(`verified     ${String(fullyVerified)} (every requested spec is actually printed)`);
  out();

  if (results.length === 0) {
    out("no candidates. Every SKU in the index has a printed spec that violates a constraint.");
    return;
  }

  results.forEach((result, i) => {
    renderSolveResult(result, i + 1);
    out();
  });

  out(
    "`unknown` means the summary catalog does not print that spec for that SKU — it is NOT a pass.",
  );
  out("Verify every unknown row against the cited page before quoting a replacement.");
}

/** One candidate plus its verdict table — the block a judge re-derives by hand. */
function renderSolveResult(result: SolveResult, rank: number): void {
  const p = result.product;
  out(
    `#${pad(String(rank), 3)}${pad(p.typeCode ?? "—", 20)}${pad(p.orderNumber, 9)}${pad(
      p.family ?? "—",
      12,
    )}${pad(`page ${p.sourcePage}`, 12)}${
      result.viable ? (result.unknown === 0 ? "VERIFIED" : "VIABLE") : "REJECTED"
    }`,
  );
  out(
    `     ${String(result.passed)} pass · ${String(result.failed)} fail · ${String(result.unknown)} unknown`,
  );
  for (const verdict of result.verdicts) {
    out(
      `     ${VERDICT_MARK[verdict.status]}  ${pad(verdict.field, 22)}${verdict.detail}${
        verdict.lowConfidence === true ? "  [low confidence]" : ""
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

/**
 * Fields whose coverage is worth reporting, because a constraint on a field the
 * catalog rarely prints will mostly return `unknown` — and an operator should
 * learn that from `stats`, not from a mysteriously empty solve.
 */
const COVERAGE_FIELDS: readonly (keyof NormalizedSpec)[] = [
  "outputType",
  "connector",
  "ipRating",
  "ip69k",
  "sensingRangeMaxMm",
  "responseTimeMs",
  "switchingFrequencyHz",
  "supplyVoltageMaxV",
  "operatingTempMaxC",
  "principle",
  "housing",
  "light",
];

async function cmdStats(argv: Argv): Promise<void> {
  const { path, index, retriever } = await openRetriever(argv);
  const stats = retriever.stats();
  const p = index.provenance;

  const coverage = COVERAGE_FIELDS.map((field) => ({
    field,
    stated: index.specs.filter((spec) => spec[field] !== undefined).length,
  }));

  if (has(argv, "json")) {
    json({ path, retriever: stats, coverage });
    return;
  }

  const bySection = new Map<string, number>();
  for (const product of index.products) {
    bySection.set(product.section, (bySection.get(product.section) ?? 0) + 1);
  }
  const variants = index.products.filter((product) => product.rowType === "product").length;

  out(`index        ${path}`);
  out(`built at     ${p.builtAt}`);
  out(`dataset      ${p.sourceDir}`);
  out(`chunks       ${String(p.chunkCount)} in ${String(p.documentCount)} documents`);
  out(
    `products     ${String(p.productCount)} (${String(variants)} variants, ${String(p.productCount - variants)} accessories)`,
  );
  out(`families     ${String(index.families.length)}`);
  out(
    stats.denseAvailable
      ? `dense lane   vectors present — ${String(p.embeddingModel ?? "unknown model")}, dim ${String(p.embeddingDimension ?? 0)}, ${String(p.embeddedChunkCount)}/${String(p.chunkCount)} chunks embedded`
      : "dense lane   OFF — lexical-only. Semantic paraphrase recall is degraded; exact part numbers and the deterministic solver are unaffected.",
  );
  // Vectors in the artifact are necessary but not sufficient: the query still has
  // to be embedded at search time, which needs a live key. Saying "dense is on"
  // without that caveat overstates what a given search will actually do.
  if (stats.denseAvailable) {
    out(
      "             The dense lane only runs when a VOYAGE_API_KEY is set at query time; without one, `search` silently reports denseRank -.",
    );
  }
  out();

  out("SKUS PER SECTION");
  for (const [section, count] of [...bySection.entries()].sort()) {
    out(`  ${pad(section, 4)}${String(count)}`);
  }
  out();

  out("SPEC COVERAGE  (how many of the indexed SKUs actually print each spec)");
  out("  A constraint on a sparse field mostly yields `unknown`, never `fail`.");
  for (const { field, stated } of coverage) {
    const pct = p.productCount === 0 ? 0 : Math.round((stated / p.productCount) * 100);
    out(`  ${pad(field, 24)}${pad(String(stated), 7)}${String(pct)}%`);
  }
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

const USAGE = `sick-rag — hybrid retrieval over the SICK 2015/2016 catalog

USAGE
  sick-rag index  [--dataset <dir>] [--out <file>] [--no-embed]
  sick-rag search <query...>       [options] [constraints]
  sick-rag get    <orderNumber>    [--index <file>] [--json]
  sick-rag solve  <constraints>    [--index <file>] [--top <n>] [--json]
  sick-rag stats                   [--index <file>] [--json]

COMMANDS
  index    Build the index artifact and write it to disk.
           Without a VOYAGE_API_KEY (or with --no-embed) it builds a
           lexical-only index, which is a fully working product: BM25 answers
           part numbers better than any embedding, and the solver is unaffected.
  search   Rank candidates for a natural-language query or a competitor part
           number. Prints every lane's rank and score; a lane that did not run
           shows "-". Search produces candidates, never a decision.
  get      Print one SKU: full catalog record, normalized spec, citation.
  solve    Deterministic constraint solve. Prints a pass/fail/unknown verdict
           per constraint per candidate — the table a skeptic re-derives by hand.
  stats    What the artifact contains, including per-spec catalog coverage.

OPTIONS
  --index <file>       Index artifact. Default: $SICK_RAG_INDEX, else
                       <repo>/sick-catalog-dataset/rag-index.json
  --dataset <dir>      Dataset directory (index only).
                       Default: <repo>/sick-catalog-dataset
  --out <file>         Where to write the artifact (index only). Default: --index
  --no-embed           Force a lexical-only build, even with an API key.
  --top <n>            Results to show. Default 10.
  --json               Machine-readable output.
  --no-rerank          Skip the cross-encoder rerank pass (search).
  --no-dense           Skip the dense lane even if the index has vectors (search).

CONSTRAINTS  (search and solve)
  --pnp                PNP switching output (also accepts PNP/NPN selectable).
  --npn                NPN switching output (also accepts PNP/NPN selectable).
  --ip <n>             Minimum enclosure rating, e.g. --ip 67.
  --ip69k              Requires an explicit IP69K rating.
  --range-min <mm>     Nearest distance the sensor must still detect at.
  --range-max <mm>     Farthest distance the sensor must reach. This is the
                       REQUIRED detection distance, not a cap on the rating:
                       a sensor whose printed maximum is shorter fails.
  --response-max <ms>  Maximum acceptable response time.
  --connector <t>      M5 | M8 | M12 | cable | terminal | other. Repeatable.
  --section <letter>   Catalog section B..N. Repeatable.
  --family <name>      Product family, e.g. --family G6. Repeatable.
  --products-only      Exclude accessory rows (brackets, cordsets, reflectors).

A spec the catalog does not print is reported as \`unknown\`, never as a failure.
This is the summary catalog: supply voltage is printed for 41 of 1,776 SKUs and
response time for 96. Treat every \`unknown\` as "verify against the page".

EXAMPLES
  sick-rag index --no-embed
  sick-rag search "retroreflective sensor that sees a box at 40 cm" --pnp --ip 67
  sick-rag search QS18VN6LV --products-only --top 5
  sick-rag get 1052442
  sick-rag solve --pnp --ip69k --response-max 12 --section B --top 5
`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(tokens: readonly string[]): Promise<void> {
  const argv = parseArgv(tokens);

  if (has(argv, "help") || argv.command === undefined || argv.command === "help") {
    out(USAGE);
    return;
  }

  switch (argv.command) {
    case "index":
      await cmdIndex(argv);
      return;
    case "search":
      await cmdSearch(argv);
      return;
    case "get":
      await cmdGet(argv);
      return;
    case "solve":
      await cmdSolve(argv);
      return;
    case "stats":
      await cmdStats(argv);
      return;
    default:
      // An unknown command is a typo, not a crash: show the menu, exit 0.
      out(USAGE);
      note(`sick-rag: unknown command "${argv.command}"`);
      return;
  }
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  note(`sick-rag: ${message}`);
  if (process.env["SICK_RAG_DEBUG"] !== undefined && error instanceof Error && error.stack) {
    note(error.stack);
  }
  process.exitCode = 1;
});

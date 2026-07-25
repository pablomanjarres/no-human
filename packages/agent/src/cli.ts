#!/usr/bin/env node
/**
 * `sick-agent` — the operator and demo surface for the runtime agent layer.
 *
 * Three commands. `migrate` takes a competitor part number, a description, a
 * nameplate photo or a whole BOM and returns the SICK equivalent — or an honest
 * refusal. `consult` takes a described problem and behaves like an application
 * engineer: it asks before it designs. `trace replay` re-runs a recorded run at a
 * chosen speed, so a rehearsed demo is reproducible without an API key.
 *
 * ## What the flags are actually for
 *
 * `--trace` is the demo view, and it is not a debug flag. It streams every
 * {@link TraceEvent} to stderr *as it is emitted*, so the audience watches the
 * resolver narrow, the solver return verdicts, and the challenger try to kill
 * the winner — in real time, in order. The trace is this product's evidence that
 * the agents did real work; a run nobody can watch is a run nobody believes.
 * Events go to **stderr** on purpose, so `--trace --json` still pipes clean JSON.
 *
 * `--json` emits the whole report object, trace array included, for the web UI
 * and for `trace replay` to consume later.
 *
 * ## Conventions
 *
 * Argv is parsed by hand — no dependency, and the flag set is small enough that a
 * parser is cheaper than a library. Human output goes to stdout, progress and
 * diagnostics to stderr. `--help` and an unknown command exit 0 with usage; a
 * real failure exits 1 with one actionable line and no stack trace (set
 * `SICK_AGENT_DEBUG=1` for the stack). A missing `ANTHROPIC_API_KEY` is checked
 * before any index is loaded, because "ENOENT on a 40 MB read, then a 401" is a
 * worse first experience than one sentence naming the variable to export.
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import { createRetriever, readIndex, type Retriever } from "@no-human/rag";

import { createClaudeClient, type LlmClient } from "./claude.js";
import { loadCompetitorIndex, type CompetitorIndex } from "./competitors.js";
import type { VisionClient } from "./inputs/vision.js";
import { consult } from "./consultant.js";
import { runBomAudit, runMigration } from "./orchestrator.js";
import { renderMarkdown, renderTraceSummary } from "./report.js";
import { createTrace, fromNdjson, replayTrace, type Trace } from "./trace.js";
import type { AgentInput, ConsultOutcome, MigrationReport, TraceEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * `packages/agent/src` (or `.../dist` after a build) → repo root.
 *
 * Derived from `import.meta.url`, never `process.cwd()`: the default index and
 * the competitor dataset have to mean the same files whether the CLI is run from
 * the repo root, from the package directory, or through a `node_modules/.bin`
 * shim.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const DEFAULT_INDEX_PATH = join(REPO_ROOT, "sick-catalog-dataset", "rag-index.json");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failure the user can act on: a bad flag, a missing artifact, no API key.
 *
 * Separated from a genuine crash so the top-level handler prints one line
 * instead of a stack trace. A stack trace as the primary error message tells an
 * operator nothing about what to type next.
 */
class CliError extends Error {
  override readonly name = "CliError";
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

/** Flags that consume a value, either `--flag value` or `--flag=value`. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "image",
  "bom",
  "vendor",
  "index",
  "top",
  "speed",
  "answer",
]);

/** Presence-only flags. */
const BOOL_FLAGS: ReadonlySet<string> = new Set(["trace", "json", "help"]);

interface Argv {
  command: string | undefined;
  /** Everything that was not a flag, in order, command excluded. */
  positional: string[];
  /** Repeatable value flags keep every occurrence — `--answer` needs that. */
  values: Map<string, string[]>;
  flags: Set<string>;
}

function parseArgv(tokens: readonly string[]): Argv {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);

    if (BOOL_FLAGS.has(name)) {
      if (inline !== undefined) throw new CliError(`--${name} does not take a value`);
      flags.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new CliError(`unknown option --${name}. Run \`sick-agent --help\` for the flag list.`);
    }
    const value = inline ?? tokens[i + 1];
    if (inline === undefined) i += 1;
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`--${name} needs a value`);
    }
    const bucket = values.get(name);
    if (bucket === undefined) values.set(name, [value]);
    else bucket.push(value);
  }

  const [command, ...rest] = positional;
  return { command, positional: rest, values, flags };
}

function one(argv: Argv, name: string): string | undefined {
  return argv.values.get(name)?.[0];
}

function all(argv: Argv, name: string): string[] {
  return argv.values.get(name) ?? [];
}

function has(argv: Argv, name: string): boolean {
  return argv.flags.has(name);
}

/** A positive integer flag, or `undefined` when absent. Junk is an error, not a
 *  silent default — a mistyped `--top` should not quietly change the output. */
function intFlag(argv: Argv, name: string): number | undefined {
  const raw = one(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new CliError(`--${name} must be a positive number`);
  return Math.floor(n);
}

function numberFlag(argv: Argv, name: string): number | undefined {
  const raw = one(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`--${name} must be a positive number`);
  return n;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Diagnostics and the live trace. Never stdout — `--json` must stay pipeable. */
function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

function json(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

/**
 * One trace event, as the demo view renders it.
 *
 * Fixed-width clock and type columns so a fast run reads as a timeline rather
 * than a wall of text, plus one extra line for the events a viewer actually
 * leans in for: the questions, the attacks, the promotions.
 */
function printTraceEvent(event: TraceEvent): void {
  const clock = `${String(Math.round(event.at)).padStart(6)}ms`;
  note(`[${clock}] ${event.type.padEnd(22)} ${event.label}`);

  switch (event.type) {
    case "resolver.question":
      for (const q of event.questions) note(`             ? ${q.field}: ${q.question}\n               why: ${q.why}`);
      return;
    case "resolver.constraints":
      note(`             constraints: ${JSON.stringify(event.constraints)}`);
      if (event.missing.length > 0) note(`             missing: ${event.missing.join(", ")}`);
      return;
    case "solver.verdicts":
      // The unknown count is printed on the same line as the passes on purpose:
      // separating them is how "3 passed" comes to read as "verified".
      note(
        `             ${event.orderNumber}: ${String(event.passed)} pass · ${String(event.failed)} fail · ${String(event.unknown)} UNKNOWN (unverified, not pass)`,
      );
      return;
    case "challenger.attack":
      note(`             [${event.challenge.verdict}/${event.challenge.severity}] ${event.challenge.claim}`);
      return;
    case "candidate.promoted":
      note(`             ${event.from} → ${event.to}: ${event.because}`);
      return;
    case "tool.result":
      note(`             ${event.summary.slice(0, 160)}`);
      return;
    case "error":
      note(`             ${event.recoverable ? "recovered" : "fatal"}: ${event.message}`);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Fail before doing any work when there is no credential.
 *
 * The SDK also accepts `ANTHROPIC_AUTH_TOKEN`, so both are checked — telling a
 * user to export a key they have already exported under the other name is worse
 * than saying nothing.
 */
function requireCredential(): void {
  const key = process.env["ANTHROPIC_API_KEY"] ?? process.env["ANTHROPIC_AUTH_TOKEN"];
  if (typeof key === "string" && key.trim() !== "") return;
  throw new CliError(
    "ANTHROPIC_API_KEY is not set — export your Anthropic API key and re-run, e.g. `export ANTHROPIC_API_KEY=sk-ant-...`.",
  );
}

function resolveIndexPath(argv: Argv): string {
  const explicit = one(argv, "index");
  if (explicit !== undefined) return resolve(explicit);
  const fromEnv = process.env["SICK_RAG_INDEX"];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv.trim());
  return DEFAULT_INDEX_PATH;
}

/** Load the catalog index, turning ENOENT into the command that fixes it. */
async function openRetriever(argv: Argv): Promise<Retriever> {
  const path = resolveIndexPath(argv);
  try {
    return createRetriever(await readIndex(path));
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "ENOENT") {
      throw new CliError(
        `no catalog index at ${path} — build one with \`sick-rag index\`, or point at another file with --index <file>.`,
      );
    }
    throw new CliError(
      `could not read the catalog index at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

interface RunContext {
  client: LlmClient;
  /** Raw SDK client for the nameplate-photo path (image content blocks). */
  vision: VisionClient;
  retriever: Retriever;
  competitors: CompetitorIndex;
  trace: Trace;
  signal: AbortSignal;
}

/**
 * Build everything a run needs.
 *
 * The trace bus is always created, `--trace` or not: the report carries the full
 * event log either way, and the flag only decides whether it is also printed
 * live. A demo that has to be re-run to get its trace is not a demo.
 */
async function openRun(argv: Argv, signal: AbortSignal): Promise<RunContext> {
  requireCredential();
  const retriever = await openRetriever(argv);
  const competitors = await loadCompetitorIndex(REPO_ROOT);
  const trace = createTrace(has(argv, "trace") ? { onEvent: printTraceEvent } : undefined);
  // The vision path needs the raw SDK surface (image content blocks), which the
  // structured LlmClient wrapper deliberately does not model. Constructed here
  // rather than lazily inside the resolver so `--image` fails at startup on a
  // missing credential, not three steps into a run.
  const vision = new Anthropic() as unknown as VisionClient;
  return { client: createClaudeClient(), vision, retriever, competitors, trace, signal };
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

/** The media types the vision path accepts, keyed by file extension. */
type ImageMediaType = Extract<AgentInput, { kind: "image" }>["mediaType"];

const IMAGE_TYPES: Readonly<Record<string, ImageMediaType>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/**
 * Media type from the extension, not from sniffing the bytes.
 *
 * A mislabelled file is rejected by the API rather than silently mis-decoded,
 * which is the right place for that failure — guessing here would mean shipping
 * a nameplate photo the model reads as garbage and then "identifies".
 */
function imageMediaType(path: string): ImageMediaType {
  const found = IMAGE_TYPES[extname(path).toLowerCase()];
  if (found !== undefined) return found;
  throw new CliError(
    `unsupported image type for "${basename(path)}" — the vision path accepts .png, .jpg/.jpeg and .webp.`,
  );
}

async function readTextArg(path: string, what: string): Promise<string> {
  try {
    return await readFile(resolve(path), "utf8");
  } catch (cause) {
    throw new CliError(
      `could not read the ${what} at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Turn the flags into exactly one {@link AgentInput}.
 *
 * The four modalities are mutually exclusive and the ambiguity is rejected
 * rather than resolved by precedence. `migrate QS18VN6LV --image label.jpg` is a
 * user who does not know which one they meant, and silently picking either
 * produces a report about the wrong part.
 */
async function buildMigrateInput(argv: Argv): Promise<AgentInput> {
  const imagePath = one(argv, "image");
  const bomPath = one(argv, "bom");
  const freeText = argv.positional.join(" ").trim();

  const given = [imagePath !== undefined, bomPath !== undefined, freeText !== ""].filter(Boolean);
  if (given.length === 0) {
    throw new CliError(
      "migrate needs something to work from: a part number or description, --image <path>, or --bom <path>.",
    );
  }
  if (given.length > 1) {
    throw new CliError(
      "migrate takes one input at a time. Give a part number or description, OR --image, OR --bom.",
    );
  }

  if (imagePath !== undefined) {
    const mediaType = imageMediaType(imagePath);
    let bytes: Buffer;
    try {
      bytes = await readFile(resolve(imagePath));
    } catch (cause) {
      throw new CliError(
        `could not read the image at ${imagePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const vendorHint = one(argv, "vendor");
    return {
      kind: "image",
      mediaType,
      base64: bytes.toString("base64"),
      ...(vendorHint !== undefined ? { note: `Vendor hint from the operator: ${vendorHint}` } : {}),
    };
  }

  if (bomPath !== undefined) {
    return { kind: "bom", csv: await readTextArg(bomPath, "BOM") };
  }

  // A part number is a description with no spaces. Rather than guess with a
  // regex — Banner, Keyence and Balluff all spell part numbers differently — the
  // Resolver is told which one we think it is and is free to disagree.
  const vendorHint = one(argv, "vendor");
  if (/\s/.test(freeText)) return { kind: "description", value: freeText };
  return {
    kind: "part_number",
    value: freeText,
    ...(vendorHint !== undefined ? { vendorHint } : {}),
  };
}

/**
 * Apply `--top` to a finished report.
 *
 * A display cap, applied after the run rather than inside it. Truncating the
 * candidate set *before* the challenger would change which part wins, and a flag
 * whose name says "show me fewer" must not be able to change the answer.
 */
function limitRecommendations(report: MigrationReport, top: number | undefined): MigrationReport {
  if (top === undefined || report.outcome.kind !== "recommendation") return report;
  return {
    ...report,
    outcome: { kind: "recommendation", recommendations: report.outcome.recommendations.slice(0, top) },
  };
}

async function cmdMigrate(argv: Argv, signal: AbortSignal): Promise<void> {
  const input = await buildMigrateInput(argv);
  const ctx = await openRun(argv, signal);
  const deps = {
    client: ctx.client,
    vision: ctx.vision,
    retriever: ctx.retriever,
    competitors: ctx.competitors,
    trace: ctx.trace,
    signal: ctx.signal,
  };

  // A BOM is many independent resolutions, not one — `runMigration` rejects it
  // by design. Route it to the auditor here rather than making the operator
  // know that: `--bom` is a documented flag, so it has to do something.
  if (input.kind === "bom") {
    const entries = await runBomAudit(input.csv, deps);
    if (has(argv, "json")) {
      json(entries);
      return;
    }
    for (const entry of entries) {
      out(`\n## BOM line ${entry.row.line}${entry.row.partNumber ? ` · ${entry.row.partNumber}` : ""}`);
      out(renderMarkdown(entry.report));
    }
    note(`\n${entries.length} row(s) audited.`);
    return;
  }

  const report = limitRecommendations(await runMigration(input, deps), intFlag(argv, "top"));

  if (has(argv, "json")) {
    json(report);
    return;
  }
  out(renderMarkdown(report));
  if (has(argv, "trace")) {
    note("");
    note(renderTraceSummary(report));
  }
}

// ---------------------------------------------------------------------------
// consult
// ---------------------------------------------------------------------------

/** `--answer field=value`, repeatable. */
function parseAnswers(argv: Argv): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const raw of all(argv, "answer")) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new CliError(
        `--answer expects field=value, got "${raw}". The field is the one printed with each question.`,
      );
    }
    answers[raw.slice(0, eq).trim()] = raw.slice(eq + 1).trim();
  }
  return answers;
}

/**
 * Render a consultation for a human.
 *
 * Lives here rather than in `report.ts` because it is presentation for this
 * terminal, not part of the report contract. Two shapes, and the questions one
 * is not a lesser outcome — it is the run doing its job, so it is rendered with
 * the same weight as a design.
 */
function renderConsult(outcome: ConsultOutcome): string {
  if (outcome.kind === "needs_input") {
    const lines = [
      "# More information needed",
      "",
      "Answering these changes the recommendation. Re-run with `--answer field=value` for each.",
      "",
    ];
    for (const q of outcome.questions) {
      lines.push(`## ${q.field}`, "", q.question, "", `**Why it matters.** ${q.why}`);
      if (q.options !== undefined && q.options.length > 0) {
        lines.push("", `Options: ${q.options.join(" · ")}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  const d = outcome.design;
  const lines = ["# Proposed solution", "", d.problem, "", "## Approach", "", d.approach, ""];

  if (d.requirements.length > 0) {
    lines.push("## Requirements", "", ...d.requirements.map((r) => `- ${r}`), "");
  }
  if (d.assumptions.length > 0) {
    lines.push("## Assumptions (reject any of these and the design changes)", "", ...d.assumptions.map((a) => `- ${a}`), "");
  }

  lines.push("## Bill of materials", "");
  for (const item of d.billOfMaterials) {
    const page = `page ${item.citation.sourcePage}, pdf p.${String(item.citation.pdfPage + 1)}`;
    lines.push(
      `- **${item.product.orderNumber}** ${item.product.typeCode ?? item.product.productName ?? ""} — ${String(item.quantity)} × ${item.role}`,
      `  - ${item.why}`,
      `  - cited: ${page}${item.citation.productUrl !== undefined ? ` · ${item.citation.productUrl}` : ""}`,
    );
  }
  lines.push("");

  lines.push("## Compatibility", "");
  for (const c of d.compatibility) {
    const mark = c.status === "ok" ? "OK" : c.status === "warning" ? "WARNING" : "UNVERIFIED";
    lines.push(`- **${mark}** — ${c.check}`, `  - ${c.detail}`);
  }
  lines.push("");

  if (d.alternativesConsidered.length > 0) {
    lines.push("## Alternatives considered and rejected", "");
    for (const a of d.alternativesConsidered) lines.push(`- **${a.approach}** — ${a.rejectedBecause}`);
    lines.push("");
  }

  if (d.limitations.length > 0) {
    lines.push("## Limitations", "", ...d.limitations.map((l) => `- ${l}`), "");
  }

  lines.push(
    `**Confidence: ${d.confidence}.** Every \`UNVERIFIED\` row above is a spec this catalog does not print. It is an open risk, not a pass.`,
    "",
  );
  return lines.join("\n");
}

async function cmdConsult(argv: Argv, signal: AbortSignal): Promise<void> {
  const problem = argv.positional.join(" ").trim();
  if (problem === "") {
    throw new CliError('consult needs a problem, e.g. sick-agent consult "detect black boxes on a conveyor"');
  }
  const answers = parseAnswers(argv);
  const ctx = await openRun(argv, signal);

  const outcome = await consult(
    { problem, ...(Object.keys(answers).length > 0 ? { answers } : {}) },
    { client: ctx.client, retriever: ctx.retriever, trace: ctx.trace, signal: ctx.signal },
  );

  if (has(argv, "json")) {
    json({ input: { problem, answers }, outcome, trace: [...ctx.trace.events()] });
    return;
  }
  out(renderConsult(outcome));
}

// ---------------------------------------------------------------------------
// trace replay
// ---------------------------------------------------------------------------

/**
 * Replay a recorded run.
 *
 * No API key, no index, no network — the pacing comes from the recording, so a
 * rehearsed run animates identically every time. This is the command to use on
 * stage when the venue's wifi is the venue's wifi.
 */
async function cmdTrace(argv: Argv, signal: AbortSignal): Promise<void> {
  const [sub, file] = argv.positional;
  if (sub !== "replay") {
    throw new CliError(`unknown trace subcommand "${sub ?? "(none)"}". The only one is: trace replay <file.ndjson>`);
  }
  if (file === undefined) throw new CliError("trace replay needs a file, e.g. trace replay run.ndjson");

  const text = await readTextArg(file, "trace file");
  let events: TraceEvent[];
  try {
    events = fromNdjson(text);
  } catch (cause) {
    throw new CliError(`${file} is not a readable trace: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (events.length === 0) {
    throw new CliError(`${file} contains no trace events`);
  }

  const speed = numberFlag(argv, "speed");
  await replayTrace(events, {
    onEvent: printTraceEvent,
    ...(speed !== undefined ? { speed } : {}),
    signal,
  });
}

// ---------------------------------------------------------------------------
// usage
// ---------------------------------------------------------------------------

const USAGE = `sick-agent — cross-brand sensor equivalence over the SICK 2015/2016 catalog

USAGE
  sick-agent migrate <part-number-or-text> [options]
  sick-agent migrate --image <path>        [options]
  sick-agent migrate --bom <path>          [options]
  sick-agent consult "<problem>" [--answer field=value ...] [options]
  sick-agent trace replay <file.ndjson> [--speed <n>]

COMMANDS
  migrate  Find the SICK equivalent of a competitor part, parameter by
           parameter, cited to the catalog page. When there is no honest
           equivalent it says so and quantifies what you lose — that is a
           successful run, not an error.
  consult  Describe a sensing problem instead of a part. The agent asks what it
           needs to know before it designs, then returns a complete
           installation: sensor, bracket, cordset, connector.
  trace    replay <file.ndjson> — re-run a recorded trace at --speed. Needs no
           API key and no index.

OPTIONS
  --image <path>       Photo of a nameplate (.png, .jpg, .webp).
  --bom <path>         CSV bill of materials, audited row by row.
  --vendor <name>      Vendor hint: Banner, Keyence, Pepperl+Fuchs, Balluff.
  --answer field=value Answer a clarifying question. Repeatable (consult).
  --trace              Stream trace events live to stderr as they are emitted.
                       This is the demo view.
  --json               Emit the full report object on stdout.
  --index <file>       Catalog index artifact. Default: $SICK_RAG_INDEX, else
                       <repo>/sick-catalog-dataset/rag-index.json
  --top <n>            Show at most n recommendations. Display only — it cannot
                       change which part wins.
  --speed <n>          Replay rate multiplier (trace replay). Default 1.
  --help               This message.

A spec the catalog does not print is reported as unverified, never as a pass.
This is the summary catalog: supply voltage is printed for 41 of 1,776 SKUs.

ENVIRONMENT
  ANTHROPIC_API_KEY    Required for migrate and consult.
  SICK_RAG_INDEX       Default catalog index path.
  SICK_AGENT_DEBUG=1   Print stack traces instead of one-line errors.

EXAMPLES
  sick-agent migrate QS18VN6LV --vendor Banner --trace
  sick-agent migrate "rectangular, PNP, sees a box at 40 cm"
  sick-agent migrate --image ./label.jpg --json
  sick-agent consult "I need to detect black boxes on a conveyor" --trace
  sick-agent consult "count transparent bottles" --answer targetSurface=transparent
  sick-agent trace replay run.ndjson --speed 2
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

  // Ctrl-C aborts the run rather than killing the process mid-write, so a
  // partially rendered report never reaches stdout looking complete.
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    note("sick-agent: interrupted");
  });

  switch (argv.command) {
    case "migrate":
      await cmdMigrate(argv, controller.signal);
      return;
    case "consult":
      await cmdConsult(argv, controller.signal);
      return;
    case "trace":
      await cmdTrace(argv, controller.signal);
      return;
    default:
      // A typo is not a crash: show the menu and exit 0.
      out(USAGE);
      note(`sick-agent: unknown command "${argv.command}"`);
      return;
  }
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  note(`sick-agent: ${message}`);
  if (process.env["SICK_AGENT_DEBUG"] !== undefined && error instanceof Error && error.stack !== undefined) {
    note(error.stack);
  }
  process.exitCode = 1;
});

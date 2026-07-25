/**
 * The one place in this package that talks to Anthropic.
 *
 * Every agent — Resolver, Challenger, consultant — goes through {@link LlmClient}.
 * Nothing else constructs an SDK client. That is not tidiness: the model id, the
 * thinking mode, the effort level, refusal handling and token accounting are all
 * things this codebase has to get right *uniformly*, and the only way to keep
 * them uniform is to have exactly one implementation of them. A second call site
 * that forgets `stop_reason === "refusal"` reads `content[0]` of an empty array
 * and crashes a run that the API handled correctly.
 *
 * ## What this module refuses to do
 *
 * - **It does not pick parts.** `structured` returns whatever the schema shaped;
 *   `withTools` returns text and a tool-call count. Neither knows what a SICK
 *   order number is. Rule 1 of `types.ts` is enforced by the *callers'* schemas
 *   (candidate indices, never order numbers), and this layer stays ignorant on
 *   purpose so it cannot be the thing that leaks a model-chosen part number.
 * - **It does not throw on refusal.** A safety classifier declining a request is
 *   a normal outcome to report to the user, exactly like a `no_equivalent`
 *   outcome. It comes back as data (`{ refused: true, reason, usage }`) so a
 *   caller has to make a decision about it rather than catch-and-swallow it.
 *   {@link RefusalError} exists for callers that genuinely cannot continue and
 *   want to escalate — this module never throws it.
 * - **It does not stream.** Non-streaming caps out around 16 000 output tokens
 *   before HTTP timeouts start biting, so anything larger is rejected loudly
 *   ({@link MAX_NON_STREAMING_TOKENS}) rather than silently truncated.
 *
 * ## API shape notes that are easy to get wrong
 *
 * `thinking: { type: "adaptive" }` — `budget_tokens` is removed on this model and
 * returns 400. `output_config: { effort }` — effort is *inside* `output_config`,
 * not top-level. `temperature` / `top_p` / `top_k` are removed and return 400, so
 * they are absent from {@link MessageCreateBody} entirely: a field that cannot be
 * spelled cannot be sent by accident. Assistant-turn prefill also 400s, which is
 * why `structured` uses `output_config.format` rather than seeding the answer.
 */

import { env } from "node:process";

import type Anthropic from "@anthropic-ai/sdk";

import { AGENT_MODEL } from "./types.js";

// ---------------------------------------------------------------------------
// Public value types
// ---------------------------------------------------------------------------

/**
 * A message in the conversation, re-exported from the SDK.
 *
 * Aliased here so every other module in this package imports it from one place.
 * It has to be the SDK's own type rather than a hand-rolled minimal shape,
 * because the Resolver sends nameplate photos and the image content block is
 * genuinely intricate.
 */
export type MessageParam = Anthropic.MessageParam;

/**
 * How hard the model should work on one call.
 *
 * `high` is the API default and what {@link AGENT_MODEL} runs at when this is
 * omitted. Both agents in this package pin their own value in `types.ts` —
 * see `RESOLVER_EFFORT` / `CHALLENGER_EFFORT`.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Token accounting for one logical call, summed across every HTTP request the
 * call made (tool-loop turns and `pause_turn` resumptions included).
 *
 * `inputTokens` is the *total* prompt size: uncached tokens plus cache reads
 * plus cache writes. The API reports those in three separate fields, and
 * summing them is the only number that means "how much context did this cost".
 * Reading `input_tokens` alone under-reports a long agentic run by an order of
 * magnitude, which then shows up as a suspiciously cheap trace panel.
 */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The model declined. A reportable outcome, not an error path. */
export interface Refused {
  readonly refused: true;
  /** Human-readable statement of what was declined, for the user and the trace. */
  readonly reason: string;
  /** Tokens spent before the decline. A pre-output refusal is not billed, but a
   *  mid-stream one is, and a run's accounting must not silently lose it. */
  readonly usage: Usage;
}

/** A successful structured call. */
export interface StructuredOk<T> {
  /**
   * The parsed JSON, asserted to `T`.
   *
   * The schema constrained generation, so the *shape* is enforced by the API —
   * but a schema cannot enforce meaning. A caller that needs "this array is
   * non-empty" or "this field names a real constraint" still has to check.
   */
  readonly value: T;
  readonly usage: Usage;
}

/** A successful tool-use loop. */
export interface ToolLoopOk {
  /** Concatenated text of the model's final turn. */
  readonly text: string;
  readonly usage: Usage;
  /** How many `tool_use` blocks were executed across the whole loop. */
  readonly toolCalls: number;
}

/**
 * A refusal raised as an exception.
 *
 * This module never throws it — a refusal comes back as {@link Refused} data so
 * it reaches the user as a finding. The class exists for the boundary where a
 * caller has decided a refusal is unrecoverable for *its* step and wants normal
 * exception propagation. Throwing it means "I chose to give up here", which is
 * a different and more honest statement than a swallowed `catch`.
 */
export class RefusalError extends Error {
  override readonly name = "RefusalError";
  readonly usage: Usage;

  constructor(reason: string, usage: Usage) {
    super(reason);
    this.usage = usage;
  }

  /** Build one from a {@link Refused} result. */
  static from(refused: Refused): RefusalError {
    return new RefusalError(refused.reason, refused.usage);
  }
}

/** Narrow a client result to the refusal branch. */
export function isRefused(result: { refused?: true } | object): result is Refused {
  return (result as { refused?: unknown }).refused === true;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * A tool the loop can dispatch.
 *
 * Declared structurally so `CatalogTool` from `@no-human/rag` satisfies it
 * without this package importing the concrete class. `input_schema` is passed
 * to the API verbatim; the rag package already guarantees it carries
 * `additionalProperties: false` and an explicit `required` array.
 */
export interface LlmTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: object;
  /** Execute the tool. May throw — the loop reports the throw back to the model
   *  as an `is_error` tool_result rather than aborting the run. */
  run(input: unknown): Promise<unknown> | unknown;
}

/** One dispatched tool call, reported before execution so a trace can show it. */
export interface ToolCallEvent {
  readonly name: string;
  readonly input: unknown;
  /** 0-based loop turn this call was issued on. */
  readonly iteration: number;
}

/** The outcome of one dispatched tool call, reported after execution. */
export interface ToolResultEvent extends ToolCallEvent {
  /** True when `run` threw, or the tool name was not registered. */
  readonly isError: boolean;
  /** Serialized result, or the error message. Already truncated for display. */
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Request options
// ---------------------------------------------------------------------------

/** Options for {@link LlmClient.structured}. */
export interface StructuredRequest {
  readonly system: string;
  readonly messages: readonly MessageParam[];
  /** JSON Schema the response must satisfy. Sent as `output_config.format`. */
  readonly schema: object;
  readonly effort?: Effort;
  /** Output-token ceiling. Defaults to {@link DEFAULT_MAX_TOKENS}. */
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/** Options for {@link LlmClient.withTools}. */
export interface ToolLoopRequest {
  readonly system: string;
  readonly messages: readonly MessageParam[];
  readonly tools: readonly LlmTool[];
  /** Hard cap on model turns. Defaults to {@link DEFAULT_MAX_ITERATIONS}. */
  readonly maxIterations?: number;
  readonly effort?: Effort;
  readonly maxTokens?: number;
  /** Called before each tool executes. Exceptions from it are swallowed — an
   *  observer must never be able to fail a run. */
  readonly onToolCall?: (event: ToolCallEvent) => void;
  /** Called after each tool executes, for the `tool.result` trace event. */
  readonly onToolResult?: (event: ToolResultEvent) => void;
  readonly signal?: AbortSignal;
}

/**
 * The only interface any agent in this package depends on.
 *
 * Two methods, because there are exactly two ways this system uses a model:
 * turn messy input into a fixed-shape object ({@link structured}), or let it
 * investigate the catalog through `@no-human/rag`'s tools and report back
 * ({@link withTools}). Anything else — free-text completion, model-picked
 * answers — is deliberately not expressible here.
 */
export interface LlmClient {
  /**
   * One structured-output call.
   *
   * Uses `output_config.format` so the model cannot free-text its way out of
   * the contract. Assistant prefill, the old way of forcing shape, returns 400
   * on this model.
   */
  structured<T>(opts: StructuredRequest): Promise<StructuredOk<T> | Refused>;

  /**
   * A capped tool-use loop over `@no-human/rag`'s catalog tools.
   *
   * Terminates when the model stops asking for tools, or throws when the
   * iteration cap is reached.
   */
  withTools(opts: ToolLoopRequest): Promise<ToolLoopOk | Refused>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Output-token ceiling for a non-streaming request.
 *
 * Above roughly this, the SDK's HTTP timeout starts firing before the response
 * completes. This wrapper does not stream, so it rejects larger asks instead of
 * letting them fail slowly and non-deterministically.
 */
export const MAX_NON_STREAMING_TOKENS = 16_000;

/** Default output-token ceiling. */
export const DEFAULT_MAX_TOKENS = 16_000;

/**
 * Default cap on model turns in {@link LlmClient.withTools}.
 *
 * Twelve is enough for a real investigation (search → inspect two or three
 * candidates → solve → compare) with room to recover from a bad query, and
 * small enough that a model stuck in a search/re-search cycle stops costing
 * money within a minute rather than a workday.
 */
export const DEFAULT_MAX_ITERATIONS = 12;

// ---------------------------------------------------------------------------
// The SDK surface this module actually uses
// ---------------------------------------------------------------------------

/**
 * The request body, spelled out here rather than taken from the SDK's params
 * type.
 *
 * Two reasons. First, `output_config` and adaptive `thinking` land in SDK
 * typings on their own schedule, and a wrapper whose job is to pin the current
 * API shape should not be blocked by that. Second, and more importantly: the
 * removed sampling parameters are *absent from this type*. They return 400 on
 * {@link AGENT_MODEL}, and the cheapest way to guarantee this package never
 * sends one is to make it un-spellable.
 */
export interface MessageCreateBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: readonly MessageParam[];
  /** Adaptive only. `{ type: "enabled", budget_tokens: N }` returns 400 here. */
  thinking: { type: "adaptive" };
  output_config?: {
    effort?: Effort;
    format?: { type: "json_schema"; schema: object };
  };
  tools?: readonly { name: string; description: string; input_schema: object }[];
}

/**
 * The slice of the Anthropic SDK this module calls.
 *
 * Structural and minimal so a test can inject a plain object. Declared with
 * method shorthand deliberately — that gives bivariant parameter checking, so a
 * real `Anthropic` instance (whose `create` takes the SDK's own params type)
 * satisfies this without a cast at the caller's site.
 */
export interface AnthropicMessagesClient {
  messages: {
    create(body: MessageCreateBody, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
}

/** Options for {@link createClaudeClient}. */
export interface ClaudeClientOptions {
  /** Overrides `ANTHROPIC_API_KEY`. Omit to resolve credentials per call. */
  readonly apiKey?: string;
  /** Overrides {@link AGENT_MODEL}. Present for pinning during an incident,
   *  not for routine model shopping — the constant is the contract. */
  readonly model?: string;
  /** Inject an SDK client. Tests pass a fake; nothing hits the network. */
  readonly client?: AnthropicMessagesClient;
}

// ---------------------------------------------------------------------------
// Response reading (defensive on purpose)
// ---------------------------------------------------------------------------

interface RawBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
}

interface RawMessage {
  readonly stop_reason?: unknown;
  readonly stop_details?: unknown;
  readonly content?: unknown;
  readonly usage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asMessage(value: unknown): RawMessage {
  if (!isRecord(value)) {
    throw new Error(`Anthropic returned ${value === null ? "null" : typeof value}, not a message object.`);
  }
  return value as RawMessage;
}

function contentBlocks(message: RawMessage): readonly RawBlock[] {
  return Array.isArray(message.content) ? (message.content as RawBlock[]) : [];
}

function stopReason(message: RawMessage): string | null {
  return typeof message.stop_reason === "string" ? message.stop_reason : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Read usage, counting cached tokens.
 *
 * See {@link Usage} for why all three input fields are summed.
 */
function readUsage(message: RawMessage): Usage {
  const u = isRecord(message.usage) ? message.usage : {};
  return {
    inputTokens:
      finiteNumber(u["input_tokens"]) +
      finiteNumber(u["cache_read_input_tokens"]) +
      finiteNumber(u["cache_creation_input_tokens"]),
    outputTokens: finiteNumber(u["output_tokens"]),
  };
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/** Concatenated text of every `text` block, in order. */
function textOf(message: RawMessage): string {
  return contentBlocks(message)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * Turn a refusal into something a user can read.
 *
 * `stop_details` is only populated on a refusal and can still be `null`, and
 * `explanation` is not guaranteed — hence every field being probed rather than
 * indexed.
 */
function refusalReason(message: RawMessage): string {
  const details = isRecord(message.stop_details) ? message.stop_details : {};
  const category = typeof details["category"] === "string" ? details["category"] : null;
  const explanation = typeof details["explanation"] === "string" ? details["explanation"] : null;
  if (explanation !== null && category !== null) return `${explanation} (safety category: ${category})`;
  if (explanation !== null) return explanation;
  if (category !== null) return `The model declined this request (safety category: ${category}).`;
  return "The model declined this request and gave no category.";
}

function refused(message: RawMessage, usage: Usage): Refused {
  return { refused: true, reason: refusalReason(message), usage };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("The run was aborted.");
}

function resolveMaxTokens(requested: number | undefined): number {
  const maxTokens = requested ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new Error(`maxTokens must be a positive integer, got ${String(requested)}.`);
  }
  if (maxTokens > MAX_NON_STREAMING_TOKENS) {
    throw new Error(
      `maxTokens ${maxTokens} exceeds the non-streaming ceiling of ${MAX_NON_STREAMING_TOKENS}. ` +
        `Requests above that must stream, which this wrapper does not implement — split the work instead.`,
    );
  }
  return maxTokens;
}

/** Fire an observer callback without letting it take down the run. */
function notify<E>(fn: ((event: E) => void) | undefined, event: E): void {
  if (fn === undefined) return;
  try {
    fn(event);
  } catch {
    // A broken trace consumer must not fail a run that is otherwise succeeding.
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// The real client
// ---------------------------------------------------------------------------

/**
 * Build the production {@link LlmClient}.
 *
 * The SDK is imported lazily and the API key is resolved on every call, so a
 * long-lived process picks up a rotated key without a restart and a test that
 * injects `client` never touches the SDK at all. An unset `ANTHROPIC_API_KEY` is
 * not an error: the SDK also resolves `ANTHROPIC_AUTH_TOKEN` and `ant auth
 * login` profiles, so the key is passed through only when it is actually set.
 *
 * @example
 * ```ts
 * const llm = createClaudeClient();
 * const out = await llm.structured<ResolvedInput>({ system, messages, schema, effort: RESOLVER_EFFORT });
 * if (isRefused(out)) return { kind: "no_equivalent", reason: out.reason, lost: [] };
 * ```
 */
export function createClaudeClient(opts: ClaudeClientOptions = {}): LlmClient {
  const model = opts.model ?? AGENT_MODEL;

  let cached: { key: string | undefined; client: AnthropicMessagesClient } | undefined;

  const getClient = async (): Promise<AnthropicMessagesClient> => {
    if (opts.client !== undefined) return opts.client;
    const key = opts.apiKey ?? env["ANTHROPIC_API_KEY"];
    if (cached !== undefined && cached.key === key) return cached.client;
    const mod = await import("@anthropic-ai/sdk");
    const Ctor = mod.default;
    const client = new Ctor({ ...(key !== undefined ? { apiKey: key } : {}) }) as unknown as AnthropicMessagesClient;
    cached = { key, client };
    return client;
  };

  const send = async (body: MessageCreateBody, signal: AbortSignal | undefined): Promise<RawMessage> => {
    throwIfAborted(signal);
    const client = await getClient();
    const raw = await client.messages.create(body, signal !== undefined ? { signal } : undefined);
    return asMessage(raw);
  };

  return {
    async structured<T>(request: StructuredRequest): Promise<StructuredOk<T> | Refused> {
      const body: MessageCreateBody = {
        model,
        max_tokens: resolveMaxTokens(request.maxTokens),
        system: request.system,
        messages: request.messages,
        thinking: { type: "adaptive" },
        output_config: {
          ...(request.effort !== undefined ? { effort: request.effort } : {}),
          format: { type: "json_schema", schema: request.schema },
        },
      };

      const message = await send(body, request.signal);
      const usage = readUsage(message);

      // Before content, always: on a refusal `content` can be empty, and
      // indexing it is the crash this ordering exists to prevent.
      if (stopReason(message) === "refusal") return refused(message, usage);

      if (stopReason(message) === "max_tokens") {
        throw new Error(
          "The structured response hit max_tokens and is truncated. Raise maxTokens or ask for a smaller object — " +
            "a partially parsed object would look like a complete answer.",
        );
      }

      const text = textOf(message).trim();
      if (text === "") {
        throw new Error(`Anthropic returned no text block (stop_reason: ${stopReason(message) ?? "none"}).`);
      }
      try {
        return { value: JSON.parse(text) as T, usage };
      } catch (error) {
        throw new Error(
          `Anthropic returned text that is not JSON despite a json_schema output format: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },

    async withTools(request: ToolLoopRequest): Promise<ToolLoopOk | Refused> {
      const maxIterations = request.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      if (!Number.isInteger(maxIterations) || maxIterations < 1) {
        throw new Error(`maxIterations must be a positive integer, got ${String(request.maxIterations)}.`);
      }
      const maxTokens = resolveMaxTokens(request.maxTokens);
      const byName = new Map(request.tools.map((t) => [t.name, t]));

      const history: MessageParam[] = [...request.messages];
      let usage: Usage = ZERO_USAGE;
      let toolCalls = 0;

      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const body: MessageCreateBody = {
          model,
          max_tokens: maxTokens,
          system: request.system,
          // A snapshot, not the live array. `history` is appended to below, and
          // handing the same reference to the transport would make the request
          // body mutate after it was built — harmless for a client that
          // serializes immediately, quietly wrong for anything that queues,
          // retries, or logs it.
          messages: [...history],
          thinking: { type: "adaptive" },
          ...(request.effort !== undefined ? { output_config: { effort: request.effort } } : {}),
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
        };

        const message = await send(body, request.signal);
        usage = addUsage(usage, readUsage(message));

        if (stopReason(message) === "refusal") return { ...refused(message, usage) };

        if (stopReason(message) === "max_tokens") {
          throw new Error(
            "A tool-loop turn hit max_tokens. Its tool_use arguments are truncated and cannot be executed safely.",
          );
        }

        // The FULL content, never just the text. Dropping thinking or tool_use
        // blocks here corrupts the conversation: the next turn's tool_result
        // would reference a tool_use the model can no longer see.
        history.push({ role: "assistant", content: message.content as Anthropic.ContentBlockParam[] });

        // A server-side tool paused the turn. Re-send the same history; the API
        // resumes on its own. Do NOT append a "continue" user message.
        if (stopReason(message) === "pause_turn") continue;

        const calls = contentBlocks(message).filter(
          (b) => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string",
        );

        if (calls.length === 0) {
          return { text: textOf(message), usage, toolCalls };
        }

        // All results for one turn go back in ONE user message. Splitting them
        // across messages is accepted by the API and silently trains the model
        // out of parallel tool use, which shows up weeks later as a slow agent.
        const results: Anthropic.ContentBlockParam[] = [];
        for (const call of calls) {
          const name = call.name as string;
          const id = call.id as string;
          const event: ToolCallEvent = { name, input: call.input, iteration };
          notify(request.onToolCall, event);
          toolCalls += 1;

          const tool = byName.get(name);
          let isError = false;
          let payload: string;
          if (tool === undefined) {
            isError = true;
            payload = `No tool named "${name}" is available. Available: ${[...byName.keys()].join(", ") || "(none)"}.`;
          } else {
            try {
              const value = await tool.run(call.input);
              payload = JSON.stringify(value ?? null);
            } catch (error) {
              isError = true;
              payload = error instanceof Error ? error.message : String(error);
            }
          }

          notify(request.onToolResult, { ...event, isError, summary: truncate(payload, 400) });
          results.push({
            type: "tool_result",
            tool_use_id: id,
            content: [{ type: "text", text: payload }],
            ...(isError ? { is_error: true } : {}),
          });
        }
        history.push({ role: "user", content: results });
      }

      throw new Error(
        `The tool loop hit its ${maxIterations}-iteration cap without the model finishing. ` +
          `Returning the partial transcript would present an unfinished investigation as an answer.`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The test double
// ---------------------------------------------------------------------------

/**
 * One scripted response.
 *
 * Deliberately expressed in {@link LlmClient}'s *output* vocabulary rather than
 * the wire format: a Resolver test should say "the model refuses here", not
 * hand-assemble a `stop_details` object. Wire-level fidelity is this module's
 * own tests' problem, and they inject a fake SDK client instead.
 */
export type ScriptedResponse =
  | { readonly type: "structured"; readonly value: unknown; readonly usage?: Partial<Usage> }
  | { readonly type: "text"; readonly text: string; readonly toolCalls?: number; readonly usage?: Partial<Usage> }
  | { readonly type: "refusal"; readonly reason: string; readonly usage?: Partial<Usage> }
  /** Simulate a transport or parse failure. */
  | { readonly type: "throw"; readonly error: unknown };

/** What a fake client was asked to do, for assertions. */
export interface FakeCall {
  readonly kind: "structured" | "withTools";
  readonly system: string;
  readonly messages: readonly MessageParam[];
  readonly schema?: object;
  readonly toolNames?: readonly string[];
  readonly effort?: Effort;
}

/** An {@link LlmClient} that records what it was asked and replays a script. */
export interface FakeLlmClient extends LlmClient {
  readonly calls: readonly FakeCall[];
  /** Script entries not yet consumed. Assert `0` to prove every leg ran. */
  readonly remaining: number;
}

function fakeUsage(partial: Partial<Usage> | undefined): Usage {
  return { inputTokens: partial?.inputTokens ?? 0, outputTokens: partial?.outputTokens ?? 0 };
}

/**
 * Build a scripted {@link LlmClient} for tests.
 *
 * Exported from this module rather than a test helper file so every other
 * module's tests can use it without adding a dependency on the network, an API
 * key, or the SDK. A test that reaches the real API is a test that fails in CI
 * for reasons unrelated to the code under test.
 *
 * Mis-scripting is loud: asking for a structured call when the next entry is a
 * `text` entry throws rather than coercing, because a silently coerced double
 * lets a test pass against behaviour the production client would never produce.
 * `withTools` does **not** execute tools — it replays the final text. Test the
 * loop itself against `createClaudeClient({ client: fakeSdk })`.
 *
 * @example
 * ```ts
 * const llm = createFakeClient([{ type: "refusal", reason: "declined" }]);
 * const out = await resolve(llm, input);
 * expect(out.outcome.kind).toBe("no_equivalent");
 * ```
 */
export function createFakeClient(script: readonly ScriptedResponse[]): FakeLlmClient {
  const queue = [...script];
  const calls: FakeCall[] = [];

  const next = (kind: FakeCall["kind"]): ScriptedResponse => {
    const entry = queue.shift();
    if (entry === undefined) {
      throw new Error(`createFakeClient: script exhausted — an unscripted ${kind} call was made (call #${calls.length}).`);
    }
    if (entry.type === "throw") throw entry.error;
    return entry;
  };

  return {
    get calls(): readonly FakeCall[] {
      return calls;
    },
    get remaining(): number {
      return queue.length;
    },

    async structured<T>(request: StructuredRequest): Promise<StructuredOk<T> | Refused> {
      calls.push({
        kind: "structured",
        system: request.system,
        messages: request.messages,
        schema: request.schema,
        ...(request.effort !== undefined ? { effort: request.effort } : {}),
      });
      const entry = next("structured");
      if (entry.type === "refusal") {
        return { refused: true, reason: entry.reason, usage: fakeUsage(entry.usage) };
      }
      if (entry.type !== "structured") {
        throw new Error(`createFakeClient: structured() got a "${entry.type}" script entry.`);
      }
      return { value: entry.value as T, usage: fakeUsage(entry.usage) };
    },

    async withTools(request: ToolLoopRequest): Promise<ToolLoopOk | Refused> {
      calls.push({
        kind: "withTools",
        system: request.system,
        messages: request.messages,
        toolNames: request.tools.map((t) => t.name),
        ...(request.effort !== undefined ? { effort: request.effort } : {}),
      });
      const entry = next("withTools");
      if (entry.type === "refusal") {
        return { refused: true, reason: entry.reason, usage: fakeUsage(entry.usage) };
      }
      if (entry.type !== "text") {
        throw new Error(`createFakeClient: withTools() got a "${entry.type}" script entry.`);
      }
      return { text: entry.text, usage: fakeUsage(entry.usage), toolCalls: entry.toolCalls ?? 0 };
    },
  };
}

/**
 * Tests for the Anthropic wrapper.
 *
 * Everything runs against an injected fake SDK client — no network, no API key,
 * no `@anthropic-ai/sdk` import at runtime. The fake speaks the *wire* shape
 * (raw message objects with `stop_reason` / `content` / `usage`) rather than the
 * client's output shape, because the behaviour worth testing here lives exactly
 * in the translation between the two: refusal ordering, conversation-history
 * fidelity, and the single-user-message rule for tool results.
 */

import { describe, expect, it } from "vitest";

import {
  createClaudeClient,
  createFakeClient,
  DEFAULT_MAX_ITERATIONS,
  isRefused,
  MAX_NON_STREAMING_TOKENS,
  RefusalError,
  type AnthropicMessagesClient,
  type LlmTool,
  type MessageCreateBody,
} from "./claude.js";
import { AGENT_MODEL } from "./types.js";

// ---------------------------------------------------------------------------
// Wire-level fake
// ---------------------------------------------------------------------------

interface FakeSdk extends AnthropicMessagesClient {
  readonly bodies: readonly MessageCreateBody[];
}

/** An SDK client that replays raw message objects and records every request. */
function fakeSdk(responses: readonly unknown[]): FakeSdk {
  const bodies: MessageCreateBody[] = [];
  return {
    get bodies(): readonly MessageCreateBody[] {
      return bodies;
    },
    messages: {
      create(body: MessageCreateBody): Promise<unknown> {
        bodies.push(body);
        const next = responses[bodies.length - 1];
        if (next === undefined) {
          return Promise.reject(new Error(`fake SDK: no scripted response #${bodies.length - 1}`));
        }
        return Promise.resolve(next);
      },
    },
  };
}

/** A raw assistant message, with sane defaults for the fields tests ignore. */
function message(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: AGENT_MODEL,
    content: [],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...partial,
  };
}

function textBlock(text: string): Record<string, unknown> {
  return { type: "text", text };
}

function toolUseBlock(id: string, name: string, input: unknown): Record<string, unknown> {
  return { type: "tool_use", id, name, input };
}

/** Index without `noUncheckedIndexedAccess` noise, failing loudly if absent. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`expected an item at index ${index}, got ${items.length} items`);
  return value;
}

function toolNamed(name: string, run: (input: unknown) => Promise<unknown> | unknown): LlmTool {
  return {
    name,
    description: `test tool ${name}`,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    run,
  };
}

const SCHEMA = {
  type: "object",
  properties: { sufficient: { type: "boolean" } },
  required: ["sufficient"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// structured
// ---------------------------------------------------------------------------

describe("structured", () => {
  it("parses the JSON body and sums cached input tokens", async () => {
    const sdk = fakeSdk([
      message({
        content: [textBlock('{"sufficient":true}')],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
        },
      }),
    ]);
    const llm = createClaudeClient({ client: sdk });

    const result = await llm.structured<{ sufficient: boolean }>({
      system: "you are a resolver",
      messages: [{ role: "user", content: "QS18VP6LP" }],
      schema: SCHEMA,
      effort: "high",
    });

    if (isRefused(result)) throw new Error("expected a value, got a refusal");
    expect(result.value).toEqual({ sufficient: true });
    // 100 uncached + 900 cache reads + 50 cache writes: the real prompt cost.
    expect(result.usage).toEqual({ inputTokens: 1050, outputTokens: 20 });
  });

  it("sends the current API shape and none of the removed parameters", async () => {
    const sdk = fakeSdk([message({ content: [textBlock("{}")] })]);
    const llm = createClaudeClient({ client: sdk });

    await llm.structured({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      schema: SCHEMA,
      effort: "xhigh",
    });

    const body = at(sdk.bodies, 0) as unknown as Record<string, unknown>;
    expect(body["model"]).toBe(AGENT_MODEL);
    expect(body["thinking"]).toEqual({ type: "adaptive" });
    expect(body["output_config"]).toEqual({
      effort: "xhigh",
      format: { type: "json_schema", schema: SCHEMA },
    });
    // All four return 400 on this model. Absence is the point.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect((body["thinking"] as Record<string, unknown>)["budget_tokens"]).toBeUndefined();
  });

  it("reports a refusal as data without touching content", async () => {
    const sdk = fakeSdk([
      message({
        stop_reason: "refusal",
        // A pre-output refusal really does come back with an empty array. Code
        // that reads content[0] before checking stop_reason crashes right here.
        content: [],
        stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ]);
    const llm = createClaudeClient({ client: sdk });

    const result = await llm.structured({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      schema: SCHEMA,
    });

    expect(isRefused(result)).toBe(true);
    if (!isRefused(result)) throw new Error("unreachable");
    expect(result.reason).toContain("declined");
    expect(result.reason).toContain("cyber");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("refuses without a category rather than inventing one", async () => {
    const sdk = fakeSdk([message({ stop_reason: "refusal", content: [], stop_details: null })]);
    const llm = createClaudeClient({ client: sdk });

    const result = await llm.structured({ system: "s", messages: [], schema: SCHEMA });

    if (!isRefused(result)) throw new Error("expected a refusal");
    expect(result.reason).toMatch(/no category/i);
  });

  it("throws rather than parsing a truncated object", async () => {
    const sdk = fakeSdk([message({ stop_reason: "max_tokens", content: [textBlock('{"sufficient":')] })]);
    const llm = createClaudeClient({ client: sdk });

    await expect(llm.structured({ system: "s", messages: [], schema: SCHEMA })).rejects.toThrow(/max_tokens/);
  });

  it("rejects a maxTokens that would need streaming", async () => {
    const llm = createClaudeClient({ client: fakeSdk([]) });

    await expect(
      llm.structured({ system: "s", messages: [], schema: SCHEMA, maxTokens: MAX_NON_STREAMING_TOKENS + 1 }),
    ).rejects.toThrow(/stream/);
  });
});

// ---------------------------------------------------------------------------
// withTools
// ---------------------------------------------------------------------------

describe("withTools", () => {
  it("runs parallel tools, returns every result in ONE user message, and stops on end_turn", async () => {
    const sdk = fakeSdk([
      message({
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "" },
          textBlock("Looking at two candidates."),
          toolUseBlock("toolu_1", "get_product", { orderNumber: "1058200" }),
          toolUseBlock("toolu_2", "get_product", { orderNumber: "1058201" }),
        ],
      }),
      message({ stop_reason: "end_turn", content: [textBlock("Both are viable.")] }),
    ]);
    const llm = createClaudeClient({ client: sdk });
    const seen: string[] = [];

    const result = await llm.withTools({
      system: "s",
      messages: [{ role: "user", content: "compare" }],
      tools: [toolNamed("get_product", (input) => ({ echoed: input }))],
      onToolCall: (event) => seen.push(`call:${event.name}:${event.iteration}`),
      onToolResult: (event) => seen.push(`result:${event.name}:${event.isError ? "error" : "ok"}`),
    });

    if (isRefused(result)) throw new Error("expected text, got a refusal");
    expect(result.text).toBe("Both are viable.");
    expect(result.toolCalls).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(seen).toEqual([
      "call:get_product:0",
      "result:get_product:ok",
      "call:get_product:0",
      "result:get_product:ok",
    ]);

    const second = at(sdk.bodies, 1);
    // [user, assistant, user] — the two tool_results share ONE user message.
    // Splitting them silently trains the model out of parallel tool use.
    expect(second.messages).toHaveLength(3);
    const toolTurn = at(second.messages, 2) as { role: string; content: unknown };
    expect(toolTurn.role).toBe("user");
    const blocks = toolTurn.content as { type: string; tool_use_id: string }[];
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["toolu_1", "toolu_2"]);

    // The assistant turn is echoed back in FULL. Keeping only the text would
    // drop the tool_use blocks the tool_results reference.
    const assistantTurn = at(second.messages, 1) as { role: string; content: { type: string }[] };
    expect(assistantTurn.role).toBe("assistant");
    expect(assistantTurn.content.map((b) => b.type)).toEqual(["thinking", "text", "tool_use", "tool_use"]);
  });

  it("resumes a pause_turn by re-sending, with no synthetic user message", async () => {
    const sdk = fakeSdk([
      message({ stop_reason: "pause_turn", content: [textBlock("mid-search")] }),
      message({ stop_reason: "end_turn", content: [textBlock("done")] }),
    ]);
    const llm = createClaudeClient({ client: sdk });

    const result = await llm.withTools({
      system: "s",
      messages: [{ role: "user", content: "search" }],
      tools: [],
    });

    if (isRefused(result)) throw new Error("expected text, got a refusal");
    expect(result.text).toBe("done");
    expect(result.toolCalls).toBe(0);
    expect(sdk.bodies).toHaveLength(2);

    const resend = at(sdk.bodies, 1);
    // [user, assistant] — the paused turn is appended and re-sent as-is. An
    // injected "continue" user message would derail the resumption.
    expect(resend.messages).toHaveLength(2);
    expect((at(resend.messages, 1) as { role: string }).role).toBe("assistant");
  });

  it("reports a refusal mid-loop and keeps the tokens already spent", async () => {
    const sdk = fakeSdk([
      message({
        stop_reason: "tool_use",
        content: [toolUseBlock("toolu_1", "search_catalog", { query: "x" })],
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
      message({
        stop_reason: "refusal",
        content: [],
        stop_details: { category: "cyber", explanation: "nope" },
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ]);
    const llm = createClaudeClient({ client: sdk });

    const result = await llm.withTools({
      system: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [toolNamed("search_catalog", () => ({ candidates: [] }))],
    });

    if (!isRefused(result)) throw new Error("expected a refusal");
    expect(result.reason).toContain("nope");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("feeds a thrown tool error back as is_error instead of failing the run", async () => {
    const sdk = fakeSdk([
      message({ stop_reason: "tool_use", content: [toolUseBlock("toolu_1", "solve_constraints", {})] }),
      message({ stop_reason: "end_turn", content: [textBlock("recovered")] }),
    ]);
    const llm = createClaudeClient({ client: sdk });

    const result = await llm.withTools({
      system: "s",
      messages: [],
      tools: [
        toolNamed("solve_constraints", () => {
          throw new Error("constraints: unknown field \"ipRatingg\".");
        }),
      ],
    });

    if (isRefused(result)) throw new Error("expected text, got a refusal");
    expect(result.text).toBe("recovered");
    const block = at(
      at(sdk.bodies, 1).messages,
      1,
    ) as { content: { is_error?: boolean; content: { text: string }[] }[] };
    expect(at(block.content, 0).is_error).toBe(true);
    expect(at(at(block.content, 0).content, 0).text).toContain("ipRatingg");
  });

  it("reports an unknown tool name back to the model rather than crashing", async () => {
    const sdk = fakeSdk([
      message({ stop_reason: "tool_use", content: [toolUseBlock("toolu_1", "no_such_tool", {})] }),
      message({ stop_reason: "end_turn", content: [textBlock("ok")] }),
    ]);
    const llm = createClaudeClient({ client: sdk });

    const result = await llm.withTools({
      system: "s",
      messages: [],
      tools: [toolNamed("search_catalog", () => ({}))],
    });

    if (isRefused(result)) throw new Error("expected text, got a refusal");
    const toolTurn = at(at(sdk.bodies, 1).messages, 1) as {
      content: { is_error?: boolean; content: { text: string }[] }[];
    };
    expect(at(toolTurn.content, 0).is_error).toBe(true);
    expect(at(at(toolTurn.content, 0).content, 0).text).toContain("no_such_tool");
  });

  it("stops at the iteration cap instead of looping forever", async () => {
    const forever = Array.from({ length: 10 }, () =>
      message({ stop_reason: "tool_use", content: [toolUseBlock("toolu_x", "search_catalog", {})] }),
    );
    const sdk = fakeSdk(forever);
    const llm = createClaudeClient({ client: sdk });

    await expect(
      llm.withTools({
        system: "s",
        messages: [],
        tools: [toolNamed("search_catalog", () => ({}))],
        maxIterations: 3,
      }),
    ).rejects.toThrow(/3-iteration cap/);
    // Exactly the cap — not one more request, and not a partial answer returned
    // as if the investigation had finished.
    expect(sdk.bodies).toHaveLength(3);
  });

  it("defaults the cap to DEFAULT_MAX_ITERATIONS", async () => {
    const forever = Array.from({ length: DEFAULT_MAX_ITERATIONS + 2 }, () =>
      message({ stop_reason: "tool_use", content: [toolUseBlock("toolu_x", "t", {})] }),
    );
    const sdk = fakeSdk(forever);
    const llm = createClaudeClient({ client: sdk });

    await expect(
      llm.withTools({ system: "s", messages: [], tools: [toolNamed("t", () => ({}))] }),
    ).rejects.toThrow(new RegExp(`${DEFAULT_MAX_ITERATIONS}-iteration cap`));
    expect(sdk.bodies).toHaveLength(DEFAULT_MAX_ITERATIONS);
  });

  it("does not let a broken observer take down a healthy run", async () => {
    const sdk = fakeSdk([
      message({ stop_reason: "tool_use", content: [toolUseBlock("toolu_1", "t", {})] }),
      message({ stop_reason: "end_turn", content: [textBlock("fine")] }),
    ]);
    const llm = createClaudeClient({ client: sdk });

    const result = await llm.withTools({
      system: "s",
      messages: [],
      tools: [toolNamed("t", () => ({}))],
      onToolCall: () => {
        throw new Error("the trace panel exploded");
      },
    });

    if (isRefused(result)) throw new Error("expected text, got a refusal");
    expect(result.text).toBe("fine");
  });

  it("refuses to start when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sdk = fakeSdk([message({ content: [textBlock("never")] })]);
    const llm = createClaudeClient({ client: sdk });

    await expect(
      llm.withTools({ system: "s", messages: [], tools: [], signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect(sdk.bodies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The test double
// ---------------------------------------------------------------------------

describe("createFakeClient", () => {
  it("replays structured values and records what it was asked", async () => {
    const llm = createFakeClient([
      { type: "structured", value: { sufficient: false }, usage: { inputTokens: 3, outputTokens: 4 } },
    ]);

    const result = await llm.structured<{ sufficient: boolean }>({
      system: "resolver",
      messages: [{ role: "user", content: "vague" }],
      schema: SCHEMA,
      effort: "high",
    });

    if (isRefused(result)) throw new Error("expected a value");
    expect(result.value.sufficient).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(at(llm.calls, 0).kind).toBe("structured");
    expect(at(llm.calls, 0).effort).toBe("high");
    expect(llm.remaining).toBe(0);
  });

  it("replays refusals on both methods", async () => {
    const llm = createFakeClient([
      { type: "refusal", reason: "declined the photo" },
      { type: "refusal", reason: "declined the search" },
    ]);

    const structured = await llm.structured({ system: "s", messages: [], schema: SCHEMA });
    const tools = await llm.withTools({ system: "s", messages: [], tools: [] });

    expect(isRefused(structured)).toBe(true);
    expect(isRefused(tools)).toBe(true);
    if (!isRefused(tools)) throw new Error("unreachable");
    expect(tools.reason).toBe("declined the search");
  });

  it("throws on a mis-scripted call rather than coercing it", async () => {
    const llm = createFakeClient([{ type: "text", text: "wrong shape" }]);

    await expect(llm.structured({ system: "s", messages: [], schema: SCHEMA })).rejects.toThrow(/"text"/);
  });

  it("throws when the script runs out", async () => {
    const llm = createFakeClient([]);

    await expect(llm.withTools({ system: "s", messages: [], tools: [] })).rejects.toThrow(/exhausted/);
  });

  it("propagates a scripted transport failure", async () => {
    const llm = createFakeClient([{ type: "throw", error: new Error("ECONNRESET") }]);

    await expect(llm.structured({ system: "s", messages: [], schema: SCHEMA })).rejects.toThrow("ECONNRESET");
  });

  it("records tool names for withTools assertions", async () => {
    const llm = createFakeClient([{ type: "text", text: "done", toolCalls: 2 }]);

    const result = await llm.withTools({
      system: "challenger",
      messages: [],
      tools: [toolNamed("get_product", () => ({})), toolNamed("compare_products", () => ({}))],
    });

    if (isRefused(result)) throw new Error("expected text");
    expect(result.toolCalls).toBe(2);
    expect(at(llm.calls, 0).toolNames).toEqual(["get_product", "compare_products"]);
  });
});

// ---------------------------------------------------------------------------
// RefusalError
// ---------------------------------------------------------------------------

describe("RefusalError", () => {
  it("carries the reason and the tokens spent, for callers that escalate", () => {
    const error = RefusalError.from({
      refused: true,
      reason: "declined",
      usage: { inputTokens: 5, outputTokens: 0 },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RefusalError");
    expect(error.message).toBe("declined");
    expect(error.usage.inputTokens).toBe(5);
  });
});

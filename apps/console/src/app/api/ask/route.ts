/**
 * Live application-engineer endpoint.
 *
 * The rest of the console renders a *deterministic* solve — no model in the
 * loop. This route is the one place a model runs, and it exists so the console
 * can answer an open question ("what do I use to count clear bottles?") rather
 * than only replay a canned run.
 *
 * The rule the whole product rests on still holds here, and is enforced
 * structurally rather than asked for in the prompt: **the model never picks the
 * part.** It may only call `search_catalog` / `solve_constraints` /
 * `get_product` / `compare_products` / `list_family` from `@no-human/rag`, and
 * every part number it can see came out of the deterministic index. It has no
 * way to emit a SKU that is not in the catalog, because it never gets to write
 * one — it reads them out of tool results that carry citations.
 *
 * Streaming shape: newline-delimited JSON, one event per line, so the client can
 * render the trace as it happens instead of waiting for the whole turn. Each
 * line is `{ type: "text" | "tool" | "done" | "error", ... }`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createCatalogTools,
  createRetriever,
  type SerializedIndex,
} from "@no-human/rag";

/** Reading a 4 MB index off disk needs the Node runtime, not Edge. */
export const runtime = "nodejs";
/** A tool loop with several turns can outrun the default 10 s ceiling. */
export const maxDuration = 60;

const MODEL = "claude-opus-5";
const MAX_ITERATIONS = 8;

/**
 * The index is ~4 MB of JSON and building the BM25 lane over 1,886 chunks costs
 * real milliseconds. Warm instances reuse both — a cold start pays once.
 */
let retrieverPromise: ReturnType<typeof buildRetriever> | undefined;

async function buildRetriever() {
  // Resolved relative to the repo root so it works in `next dev` and in the
  // traced serverless bundle (see `outputFileTracingIncludes` in next.config).
  const indexPath =
    process.env["SICK_RAG_INDEX"] ??
    path.join(process.cwd(), "..", "..", "sick-catalog-dataset", "rag-index.json");
  const raw = await readFile(indexPath, "utf8");
  const index = JSON.parse(raw) as SerializedIndex;
  return createRetriever(index);
}

function getRetriever() {
  retrieverPromise ??= buildRetriever();
  return retrieverPromise;
}

const SYSTEM = `You are a SICK Application Engineer. You help engineers, integrators and customers
either (a) migrate a competitor sensor to a SICK equivalent, or (b) design a working automation
solution from a described problem.

You behave like an engineer, not a search box:

- You reason before you answer. Understand the goal, work out what you know, work out what is
  missing, get it, then decide.
- **When information you need is missing, you ask for it instead of guessing.** Detection distance,
  target object and material, surface (matte black, glossy, transparent — this changes everything
  for a photoelectric), line speed, ambient conditions (dust, washdown, vibration, ambient light),
  mounting space, PLC and required output type, supply voltage, budget. Ask the two or three
  questions that would actually change your answer, and say why each one matters. Do not ask for
  things that would not change the recommendation.
- **You never invent a part number.** Every SICK part you name must have come from a tool result in
  this conversation. If a tool did not return it, it does not exist as far as you are concerned.
- **You distinguish three states, never two.** A spec can be verified to meet a requirement,
  verified to violate it, or *not printed in the catalog at all*. The catalog here is SICK's summary
  catalogue, so most electrical specs are genuinely absent — an \`unknown\` is an unverified risk you
  must report as one. Never present an unknown as if it passed.
- **You cite.** Every specification you assert carries its catalog page.
- **You are willing to say there is no good match.** "The closest is X, but you lose the M12
  connector and 8 ms of response time" is a better answer than a confident bad one.

Use \`search_catalog\` to find candidates — its ranking is a text-similarity heuristic and is NOT
evidence of technical equivalence. Use \`solve_constraints\` to decide, because that is a
deterministic check against the printed specs. Use \`compare_products\` when weighing alternatives,
and \`list_family\` to find the brackets, cables and connectors that turn a sensor into a working
installation.

Structure a full answer as: the problem as you understood it, requirements you detected, anything
you assumed, the recommendation with its technical reasons, the alternatives you rejected and why,
compatibility notes, limitations, and your confidence. Be concise — an engineer is reading this.
Answer in the language the user wrote in.`;

interface AskBody {
  question?: string;
  history?: Anthropic.MessageParam[];
}

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not set on the server." },
      { status: 503 },
    );
  }

  let body: AskBody;
  try {
    body = (await req.json()) as AskBody;
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const question = body.question?.trim();
  if (!question) {
    return Response.json({ error: "`question` is required." }, { status: 400 });
  }

  const retriever = await getRetriever();
  const tools = createCatalogTools(retriever);
  const byName = new Map(tools.map((t) => [t.name, t]));
  // `@no-human/rag` declares its schemas readonly so a caller cannot mutate the
  // shared definitions; the SDK's `InputSchema` wants mutable arrays. Copy the
  // one field that differs rather than casting through `unknown`, which would
  // silence any *real* shape mismatch here too.
  const toolDefs: Anthropic.Tool[] = tools.map((t) => {
    const { required, ...rest } = t.input_schema;
    return {
      name: t.name,
      description: t.description,
      input_schema: {
        ...rest,
        ...(required !== undefined ? { required: [...required] } : {}),
      } as Anthropic.Tool.InputSchema,
    };
  });

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [
    ...(body.history ?? []),
    { role: "user", content: question },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        let toolCalls = 0;

        for (let i = 0; i < MAX_ITERATIONS; i++) {
          const response = await client.messages.create({
            model: MODEL,
            max_tokens: 16000,
            system: SYSTEM,
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
            tools: toolDefs,
            messages,
          });

          // Safety classifiers can decline; `content` may be empty. Check the
          // stop reason before reading it or this throws on an empty array.
          if (response.stop_reason === "refusal") {
            send({ type: "error", message: "The model declined to answer this request." });
            break;
          }

          for (const block of response.content) {
            if (block.type === "text" && block.text) {
              send({ type: "text", text: block.text });
            }
          }

          // A server-side tool loop paused; re-send to let it continue.
          if (response.stop_reason === "pause_turn") {
            messages.push({ role: "assistant", content: response.content });
            continue;
          }

          if (response.stop_reason !== "tool_use") {
            send({ type: "done", toolCalls });
            break;
          }

          // Append the FULL content — dropping the tool_use blocks here would
          // corrupt the conversation on the next turn.
          messages.push({ role: "assistant", content: response.content });

          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            toolCalls++;
            const tool = byName.get(block.name);
            send({ type: "tool", name: block.name, input: block.input });

            if (!tool) {
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: `Unknown tool: ${block.name}`,
                is_error: true,
              });
              continue;
            }

            try {
              const out = await tool.run(block.input);
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify(out),
              });
            } catch (err) {
              // Hand the failure back to the model rather than aborting the
              // turn — it can usually recover by adjusting its arguments.
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: err instanceof Error ? err.message : String(err),
                is_error: true,
              });
            }
          }

          // All results for a turn go back in ONE user message. Splitting them
          // trains the model out of parallel tool use.
          messages.push({ role: "user", content: results });

          if (i === MAX_ITERATIONS - 1) {
            send({ type: "done", toolCalls, truncated: true });
          }
        }
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

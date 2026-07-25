/**
 * Consultancy endpoint for the Vercel deployment.
 *
 * The standalone node:http server in apps/consultancy-api cannot run on Vercel,
 * which serves functions rather than long-lived processes. This is the same
 * engine behind a route handler; both surfaces share
 * `@no-human/consultancy-engine` so there is one implementation of the scoring.
 *
 * The catalogue is imported (not read from disk) so Next bundles it into the
 * function — no output-file tracing to get wrong.
 */
import { Catalog, consult } from "@no-human/consultancy-engine";
import type { ConsultInput, EnrichedProduct } from "@no-human/consultancy-engine";
import { createAnthropicClient } from "@no-human/consultancy-llm";

import rows from "../../../data/consult-catalog.generated.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two model calls — parse then adjudicate — and the adjudication runs at high
// effort. Hobby plans cap this at 60s regardless of what is requested here.
export const maxDuration = 300;

const catalog = new Catalog(rows as unknown as EnrichedProduct[]);

const apiKey = process.env.ANTHROPIC_API_KEY;
const llm = apiKey ? createAnthropicClient(apiKey) : null;

function parseInput(body: unknown): ConsultInput {
  if (typeof body !== "object" || body === null) throw new Error("Body must be a JSON object");
  const b = body as Record<string, unknown>;
  const problem = b["problem_description"];
  if (typeof problem !== "string" || problem.trim() === "") {
    throw new Error("problem_description is required");
  }
  return {
    problem_description: problem.slice(0, 8000),
    industry: typeof b["industry"] === "string" ? b["industry"] : null,
    application: typeof b["application"] === "string" ? b["application"] : null,
    constraints:
      typeof b["constraints"] === "object" && b["constraints"] !== null
        ? (b["constraints"] as Record<string, unknown>)
        : null,
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = parseInput(await request.json());
    const result = await consult(catalog, input, llm);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 400 });
  }
}

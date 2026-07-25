/**
 * The only part of the consultancy tool that talks to a model.
 *
 * Everything the model is asked and everything it is allowed to answer lives in
 * `@no-human/consultancy-engine`; this file is transport. Keeping the split here
 * means the prompts and the anti-hallucination validation are unit-tested
 * without a network, and the API key never leaves the server.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient } from '@no-human/consultancy-engine';

const MODEL = 'claude-opus-5';

/** Server-side refusal fallback. Opt-in by default per Anthropic guidance for Opus 5. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class ModelRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`Model declined the request${category ? ` (${category})` : ''}`);
    this.name = 'ModelRefusalError';
  }
}

/** Pull the JSON payload out of a structured-output response. */
function extractJson(content: readonly { type: string; text?: string }[]): unknown {
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  if (text.trim() === '') throw new Error('Model returned no text content');
  return JSON.parse(text);
}

export function createAnthropicClient(apiKey?: string): LlmClient {
  const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();

  // Server-side fallbacks are a beta surface. If this deployment's SDK or
  // account rejects the parameter, drop it once rather than failing every call.
  let useFallbacks = true;

  return {
    async structured({ system, user, schema, purpose }) {
      const request = {
        model: MODEL,
        // Both responses are small structured objects — a requirement is a few
        // hundred tokens, an adjudication under a thousand. The old 16k ceiling
        // bought nothing and left room for the model to think far past the point
        // of usefulness.
        max_tokens: purpose === 'adjudicate' ? 6_000 : 3_000,
        system,
        messages: [{ role: 'user' as const, content: user }],
        output_config: {
          format: { type: 'json_schema' as const, schema },
          // Measured on the deployment: medium/high took 62s for one
          // consultation — over the 60s function ceiling on a Hobby plan and a
          // poor wait even where it fits. Parsing is structured extraction, which
          // Opus 5 handles well at low effort; adjudication keeps the higher tier
          // because choosing between near-equivalent SKUs is the judgement call.
          effort: purpose === 'adjudicate' ? ('medium' as const) : ('low' as const),
        },
      };

      // Bound each call so a slow model degrades into a deterministic answer
      // instead of running the serverless function past its ceiling, where the
      // caller gets a 504 with no body and no explanation. The two calls are
      // sequential, so these have to sum to less than the function limit.
      const timeout = purpose === 'adjudicate' ? 30_000 : 18_000;

      const send = async (withFallbacks: boolean) => {
        if (!withFallbacks) return client.messages.create(request, { timeout });
        return client.beta.messages.create(
          { ...request, betas: [FALLBACK_BETA], fallbacks: 'default' } as never,
          { timeout },
        );
      };

      let response;
      try {
        response = await send(useFallbacks);
      } catch (error) {
        const isBadRequest = error instanceof Anthropic.BadRequestError;
        if (useFallbacks && isBadRequest) {
          useFallbacks = false;
          response = await send(false);
        } else {
          throw error;
        }
      }

      // Check stop_reason before touching content: on a refusal the content
      // array is empty (pre-output) or partial (mid-stream).
      if (response.stop_reason === 'refusal') {
        throw new ModelRefusalError(response.stop_details?.category ?? null);
      }

      return extractJson(response.content as readonly { type: string; text?: string }[]);
    },
  };
}

export { extractJson };

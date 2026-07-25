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
        max_tokens: 16_000,
        system,
        messages: [{ role: 'user' as const, content: user }],
        output_config: {
          format: { type: 'json_schema' as const, schema },
          // Parsing a problem statement is a lighter task than adjudicating a
          // shortlist, and the shortlist is where judgement actually matters.
          effort: purpose === 'adjudicate' ? ('high' as const) : ('medium' as const),
        },
      };

      const send = async (withFallbacks: boolean) => {
        if (!withFallbacks) return client.messages.create(request);
        return client.beta.messages.create({
          ...request,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
        } as never);
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

/**
 * Input modality: a photograph of a nameplate.
 *
 * This is the messiest way in. The plate is stamped, then it spends four years
 * in a wash-down cell: glare, paint overspray, scratches through the middle of
 * the type code, half a character rubbed off by a cable tie. The model is very
 * good at reading these — and very good at *finishing* them from memory, which
 * is the failure this module exists to prevent.
 *
 * The rule enforced here, in the prompt and again deterministically in code:
 * **a character that was inferred is not a character that was read.** A part
 * number completed from product knowledge produces a downstream comparison
 * against the wrong product, and that comparison *looks correct* — every
 * citation resolves, every spec lines up, and the customer buys the wrong
 * sensor. An honest `legible: false` costs one clarifying question. That trade
 * is never close.
 *
 * Nothing here selects a part or reaches the catalog. `readLabel` returns text
 * and an honesty rating; the Resolver turns that into constraints, and the
 * deterministic solver in `@no-human/rag` does the picking (rule 1).
 */

import { AGENT_MODEL } from "../types.js";
import type { AgentInput } from "../types.js";

/** The image formats {@link AgentInput} admits, kept tied to the contract so a
 *  change there is a compile error here rather than a 400 at runtime. */
export type LabelImageMediaType = Extract<AgentInput, { kind: "image" }>["mediaType"];

/**
 * What a photograph of a nameplate actually yielded.
 *
 * Read `legible` before anything else. It does **not** mean "the photo was
 * sharp" — it means *this part number can be used as an exact identifier
 * without asking the user to confirm it*. It is false whenever any character
 * was guessed, whenever `partNumber` carries a `?` placeholder, whenever a
 * glyph pair was ambiguous, and whenever no part number was found at all.
 *
 * A `legible: false` reading is still useful and must not be discarded: the
 * partial string plus `otherText` (voltage, IP rating, cable colors) is often
 * enough to build a constraint set, and the Resolver should use it that way —
 * as evidence to ask a question with, never as an identification.
 */
export interface LabelReading {
  /** Vendor, only when branding is printed on the plate. Absent ≠ unbranded. */
  vendor?: string;
  /**
   * Best transcription of the part number. May contain `?` at positions that
   * could not be read at all. Never a completion of a partial reading — if the
   * plate stops mid-code, so does this string.
   */
  partNumber?: string;
  /** Every other legible string on the plate, verbatim, one entry each. This is
   *  the fallback path when the part number is destroyed. */
  otherText: string[];
  /** True only when the part number was read character by character with no
   *  guesses and no ambiguities. See the interface doc — this is a trust flag,
   *  not an image-quality flag. */
  legible: boolean;
  /** Confidence in the *transcription*. Clamped downward by
   *  {@link readLabel} whenever the model reports ambiguity, so a model that
   *  says "high" while listing uncertain glyphs cannot smuggle that through. */
  confidence: "high" | "medium" | "low";
  /**
   * Ambiguous glyphs, as `<1-based index into partNumber>:<candidates>`, e.g.
   * `4:0|O`. Populated instead of silently committing to one reading. A
   * consumer that ignores this field is doing exactly what this module was
   * built to stop.
   */
  uncertainCharacters: string[];
}

/** Why a label read produced nothing usable. Distinguishing these matters: a
 *  safety refusal is an operational problem, an unreadable plate is a product
 *  outcome, and collapsing the two hides the former as the latter. */
export type LabelReadingFailure = "refusal" | "empty" | "malformed";

/**
 * Thrown when the model returned no usable structured reading at all.
 *
 * Deliberately *not* converted into an illegible {@link LabelReading}: that
 * would report "we looked at the plate and could not read it" when in fact we
 * never got a reading. The orchestrator should catch this and emit an `error`
 * trace event so the run stays honest about what happened.
 */
export class LabelReadingError extends Error {
  readonly reason: LabelReadingFailure;

  constructor(reason: LabelReadingFailure, message: string) {
    super(message);
    this.name = "LabelReadingError";
    this.reason = reason;
  }
}

/**
 * The slice of the Anthropic SDK client this module needs.
 *
 * Declared structurally and loosely on purpose: an `Anthropic` instance, and
 * any shared `LlmClient` wrapper that exposes `messages.create`, satisfies it
 * without a nominal dependency — which is what keeps tests able to inject a
 * fake with three lines and no network.
 */
export interface VisionClient {
  messages: {
    create(body: VisionRequest, options?: { signal?: AbortSignal }): Promise<VisionResponse>;
  };
}

/** Request body shape, kept wide enough that the SDK's own param type is
 *  assignable to it — the point is compatibility, not re-typing the SDK. */
export interface VisionRequest {
  model: string;
  max_tokens: number;
  messages: unknown[];
  system?: unknown;
  thinking?: unknown;
  output_config?: unknown;
}

/** Response shape. `stop_reason` is read *before* `content` — safety
 *  classifiers can decline and leave `content` empty, and indexing into it
 *  first is a crash, not an error path. */
export interface VisionResponse {
  stop_reason?: string | null;
  content?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Non-streaming ceiling. A nameplate transcription is a few hundred tokens;
 *  this is headroom for adaptive thinking, not a target. */
const MAX_TOKENS = 4096;

/**
 * JSON Schema for the structured output.
 *
 * Every field is `required` and absent values are `null` rather than omitted —
 * models comply far more reliably with "always emit the key" than with
 * optionality, and {@link toReading} drops the nulls afterwards so
 * `exactOptionalPropertyTypes` stays satisfied.
 */
const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["vendor", "partNumber", "otherText", "legible", "confidence", "uncertainCharacters"],
  properties: {
    vendor: {
      type: ["string", "null"],
      description: "Manufacturer name as printed on the plate. null if no branding is visible.",
    },
    partNumber: {
      type: ["string", "null"],
      description:
        "Part/type code exactly as visible. Use '?' for each character position you cannot read. Never complete or correct it from product knowledge. null if no part number is visible at all.",
    },
    otherText: {
      type: "array",
      items: { type: "string" },
      description:
        "Every other legible string on the plate, verbatim, one per entry: voltage, current, IP rating, wiring, date codes, certification marks, cable colors.",
    },
    legible: {
      type: "boolean",
      description:
        "True ONLY if the full part number was read character by character with zero '?' and zero entries in uncertainCharacters.",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description:
        "high = crisp plate, every glyph unambiguous. medium = readable but one or more ambiguous glyph pairs. low = anything inferred, cropped, or reconstructed.",
    },
    uncertainCharacters: {
      type: "array",
      items: { type: "string" },
      description:
        "Ambiguous glyphs as '<1-based index into partNumber>:<candidates separated by |>', e.g. '4:0|O'.",
    },
  },
} as const;

const SYSTEM_PROMPT = `You are transcribing a photograph of an industrial sensor nameplate. Plates are scratched, glared, painted over, cable-tied across, and rubbed out. Your only job is to report what is physically visible and to be explicit about what is not.

1. Transcribe glyphs you can SEE. Never complete, correct, or "recognize" a part number from product knowledge. If the plate reads QS18VN6 and you believe the real product is QS18VN6D, you report QS18VN6 — the completion is a fabrication.
2. A character position you cannot read at all becomes the single character '?' in partNumber. Do not omit it and do not pick the most likely glyph.
3. A character you CAN read but whose glyph is ambiguous: keep your best reading in partNumber AND record the ambiguity in uncertainCharacters as '<1-based index into partNumber>:<candidates separated by |>', e.g. '4:0|O'. Watch specifically for 0/O/Q, 1/I/l/7, 5/S, 8/B/6, 2/Z, 6/G, U/V, D/O, M/W, and for '-' vs '.' vs a scratch.
4. legible is true ONLY IF the complete part number was read character by character with zero '?' and zero entries in uncertainCharacters. A reading that required a guess is not legible, however plausible the guess.
5. confidence: "high" = crisp plate, every glyph unambiguous. "medium" = fully readable but at least one ambiguous glyph pair. "low" = anything inferred, missing, cropped, or reconstructed.
6. vendor only when branding is actually printed on the plate. A housing shape or connector style you recognise is not evidence of a vendor.
7. otherText: every other legible string, verbatim, one entry each — supply voltage, output type, IP rating, wiring, date codes, approval marks, cable colors. When the part number is destroyed these strings are the entire recovery path, so transcribe them rather than summarising them.

A confidently wrong part number is the worst output available to you: downstream it becomes a spec comparison against the wrong product, and that comparison looks completely correct — every number lines up, every citation resolves, and the customer buys the wrong sensor. An honest "legible": false costs one clarifying question. Choose it every time.`;

/** Strip a `data:` URL wrapper and whitespace. Pasted base64 arrives both ways
 *  and the API rejects the wrapped form with a 400 that reads like a auth bug. */
function cleanBase64(raw: string): string {
  return raw.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
}

/** Raw structured-output payload, before the honesty clamps are applied. */
interface RawLabel {
  vendor?: string | null;
  partNumber?: string | null;
  otherText?: unknown;
  legible?: unknown;
  confidence?: unknown;
  uncertainCharacters?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}

function asConfidence(value: unknown): LabelReading["confidence"] {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

/** Ranking used by the clamp. Higher index = more confident. */
const CONFIDENCE_ORDER = ["low", "medium", "high"] as const;

function clampConfidence(
  reported: LabelReading["confidence"],
  ceiling: LabelReading["confidence"],
): LabelReading["confidence"] {
  return CONFIDENCE_ORDER.indexOf(reported) <= CONFIDENCE_ORDER.indexOf(ceiling)
    ? reported
    : ceiling;
}

/**
 * Apply the honesty invariants in code, not just in the prompt.
 *
 * The prompt asks the model to downgrade itself; this makes it impossible not
 * to. A model that lists `["3:8|B"]` and then claims `legible: true,
 * confidence: "high"` is describing a coin flip on a character of the part
 * number, and downstream that coin flip becomes a wrong product. So:
 *
 * - no part number, or a `?` in it  → `legible: false`, `confidence: "low"`
 * - any uncertain character         → `legible: false`, confidence ≤ `medium`
 *
 * Exported for tests — the clamp is the safety property of this module and is
 * worth asserting directly.
 */
export function applyHonestyClamps(reading: LabelReading): LabelReading {
  const hasPlaceholder = reading.partNumber !== undefined && reading.partNumber.includes("?");
  const hasPartNumber = reading.partNumber !== undefined && reading.partNumber.length > 0;

  if (!hasPartNumber || hasPlaceholder) {
    return { ...reading, legible: false, confidence: "low" };
  }
  if (reading.uncertainCharacters.length > 0) {
    return {
      ...reading,
      legible: false,
      confidence: clampConfidence(reading.confidence, "medium"),
    };
  }
  return reading;
}

function toReading(raw: RawLabel): LabelReading {
  const vendor = typeof raw.vendor === "string" ? raw.vendor.trim() : "";
  const partNumber = typeof raw.partNumber === "string" ? raw.partNumber.trim() : "";

  return applyHonestyClamps({
    ...(vendor.length > 0 ? { vendor } : {}),
    ...(partNumber.length > 0 ? { partNumber } : {}),
    otherText: asStringArray(raw.otherText),
    legible: raw.legible === true,
    confidence: asConfidence(raw.confidence),
    uncertainCharacters: asStringArray(raw.uncertainCharacters),
  });
}

/** Pull the JSON payload out of the response. Thinking blocks come first on
 *  this model, so the structured result is the *last* text block, not `[0]`. */
function extractJsonText(content: unknown): string {
  if (!Array.isArray(content)) {
    throw new LabelReadingError("empty", "Model response carried no content blocks.");
  }
  const texts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const text = (block as { text: string }).text.trim();
      if (text.length > 0) texts.push(text);
    }
  }
  const last = texts[texts.length - 1];
  if (last === undefined) {
    throw new LabelReadingError("empty", "Model response contained no text block to parse.");
  }
  return last;
}

function parseLabel(jsonText: string): RawLabel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new LabelReadingError(
      "malformed",
      `Structured output was not valid JSON: ${jsonText.slice(0, 200)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LabelReadingError("malformed", "Structured output was not a JSON object.");
  }
  return parsed as RawLabel;
}

/**
 * Read a nameplate photo into a {@link LabelReading}.
 *
 * The image goes in as a base64 `image` block followed by the instruction text
 * — image first, because the model should look before it is told what to look
 * for. The result comes back through a JSON schema so there is no prose to
 * parse and no assistant prefill (which 400s on this model anyway).
 *
 * Throws {@link LabelReadingError} when there is no reading at all — a safety
 * refusal, an empty response, or unparseable output. It never invents an
 * "illegible" reading to paper over those, because "we read the plate and it
 * was unreadable" and "we never got an answer" are different facts and the
 * trace has to be able to tell them apart.
 *
 * @param client - anything exposing `messages.create`; inject a fake in tests.
 * @param image - `base64` may be raw or a `data:` URL; both are accepted.
 * @param opts.note - what the user said about the photo ("only the top half is
 *   readable", "it's a Banner"). Passed as context, never as a fact.
 */
export async function readLabel(
  client: VisionClient,
  image: { mediaType: LabelImageMediaType; base64: string },
  opts?: { note?: string; signal?: AbortSignal },
): Promise<LabelReading> {
  const data = cleanBase64(image.base64);
  if (data.length === 0) {
    throw new LabelReadingError("empty", "No image data was supplied.");
  }

  const instruction =
    opts?.note !== undefined && opts.note.trim().length > 0
      ? `Transcribe this nameplate. The person who took the photo says: ${opts.note.trim()}\n\nTreat that note as context, not as fact — if it conflicts with what you can actually see on the plate, report what you see.`
      : "Transcribe this nameplate.";

  const messages = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data } },
        { type: "text", text: instruction },
      ],
    },
  ];

  const response = await client.messages.create(
    {
      model: AGENT_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: LABEL_SCHEMA },
      },
    },
    { ...(opts?.signal !== undefined ? { signal: opts.signal } : {}) },
  );

  // Checked BEFORE `content` is touched: on a refusal the content array can be
  // empty, and reading it first turns a policy outcome into a TypeError.
  if (response.stop_reason === "refusal") {
    throw new LabelReadingError(
      "refusal",
      "The model declined to transcribe this image; no reading was produced.",
    );
  }

  return toReading(parseLabel(extractJsonText(response.content)));
}

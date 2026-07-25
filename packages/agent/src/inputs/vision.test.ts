import { describe, it, expect } from "vitest";

import { AGENT_MODEL } from "../types.js";
import { LabelReadingError, applyHonestyClamps, readLabel } from "./vision.js";
import type { LabelReading, VisionClient, VisionRequest, VisionResponse } from "./vision.js";

interface RecordedCall {
  body: VisionRequest;
  options: { signal?: AbortSignal } | undefined;
}

/** A client that returns a canned response and records exactly what was sent.
 *  No network, ever — the point of injecting this is that the request shape is
 *  itself an assertion target. */
function fakeClient(response: VisionResponse): { client: VisionClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    client: {
      messages: {
        create(body, options) {
          calls.push({ body, options });
          return Promise.resolve(response);
        },
      },
    },
  };
}

/** Structured output arrives as the last text block, after thinking blocks. */
function structured(payload: Record<string, unknown>): VisionResponse {
  return {
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "squinting at the plate" },
      { type: "text", text: JSON.stringify(payload) },
    ],
  };
}

const CLEAN_PLATE = {
  vendor: "Banner",
  partNumber: "QS18VN6D",
  otherText: ["10-30V DC", "IP67"],
  legible: true,
  confidence: "high",
  uncertainCharacters: [],
};

const IMAGE = { mediaType: "image/jpeg", base64: "aGVsbG8=" } as const;

/** Pull the user message's content blocks out of a recorded request. */
function blocks(call: RecordedCall | undefined): Record<string, unknown>[] {
  const message = (call?.body.messages[0] ?? {}) as { content?: unknown };
  return (message.content ?? []) as Record<string, unknown>[];
}

describe("readLabel", () => {
  it("sends the image block first, then the instruction, on the agent model", async () => {
    const { client, calls } = fakeClient(structured(CLEAN_PLATE));
    await readLabel(client, IMAGE);

    const call = calls[0];
    expect(calls).toHaveLength(1);
    expect(call?.body.model).toBe(AGENT_MODEL);

    const content = blocks(call);
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" },
    });
    expect(content[1]?.["type"]).toBe("text");
    expect(String(content[1]?.["text"])).toContain("Transcribe this nameplate");
  });

  it("uses adaptive thinking, high effort, and a json_schema format — and never sends sampling params", async () => {
    const { client, calls } = fakeClient(structured(CLEAN_PLATE));
    await readLabel(client, IMAGE);

    const body = calls[0]?.body as Record<string, unknown> | undefined;
    expect(body?.["thinking"]).toEqual({ type: "adaptive" });

    const outputConfig = body?.["output_config"] as { effort?: string; format?: { type?: string } };
    expect(outputConfig.effort).toBe("high");
    expect(outputConfig.format?.type).toBe("json_schema");

    // These are removed on this model and return 400 if sent.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
  });

  it("accepts a data: URL and forwards the abort signal", async () => {
    const { client, calls } = fakeClient(structured(CLEAN_PLATE));
    const controller = new AbortController();

    await readLabel(
      client,
      { mediaType: "image/png", base64: "data:image/png;base64,aGVs\nbG8=" },
      { signal: controller.signal, note: "top half is scratched" },
    );

    expect((blocks(calls[0])[0] as { source: { data: string } }).source.data).toBe("aGVsbG8=");
    expect(calls[0]?.options?.signal).toBe(controller.signal);
    expect(String(blocks(calls[0])[1]?.["text"])).toContain("top half is scratched");
  });

  it("passes a genuinely clean reading through untouched", async () => {
    const { client } = fakeClient(structured(CLEAN_PLATE));
    const reading = await readLabel(client, IMAGE);

    expect(reading).toEqual({
      vendor: "Banner",
      partNumber: "QS18VN6D",
      otherText: ["10-30V DC", "IP67"],
      legible: true,
      confidence: "high",
      uncertainCharacters: [],
    });
  });

  it("demotes a reading the model calls legible while reporting ambiguous glyphs", async () => {
    const { client } = fakeClient(
      structured({
        ...CLEAN_PLATE,
        partNumber: "QS18VN6D",
        uncertainCharacters: ["3:8|B", "7:6|G"],
        legible: true,
        confidence: "high",
      }),
    );

    const reading = await readLabel(client, IMAGE);

    // 0/O and 8/B coin flips are how a wrong part number gets a right-looking
    // comparison. The model does not get to claim high confidence through them.
    expect(reading.legible).toBe(false);
    expect(reading.confidence).toBe("medium");
    expect(reading.uncertainCharacters).toEqual(["3:8|B", "7:6|G"]);
    expect(reading.partNumber).toBe("QS18VN6D");
  });

  it("treats a '?' placeholder as an unusable identifier", async () => {
    const { client } = fakeClient(
      structured({ ...CLEAN_PLATE, partNumber: "QS18V?6D", legible: true, confidence: "high" }),
    );

    const reading = await readLabel(client, IMAGE);

    expect(reading.legible).toBe(false);
    expect(reading.confidence).toBe("low");
    // The partial reading survives — it is evidence to ask a question with.
    expect(reading.partNumber).toBe("QS18V?6D");
  });

  it("reports an unreadable plate as illegible while keeping the surrounding text", async () => {
    const { client } = fakeClient(
      structured({
        vendor: "Keyence",
        partNumber: null,
        otherText: ["12-24 VDC", "NPN", "IP67", "MADE IN JAPAN"],
        legible: false,
        confidence: "low",
        uncertainCharacters: [],
      }),
    );

    const reading = await readLabel(client, IMAGE);

    expect(reading.legible).toBe(false);
    expect(reading.confidence).toBe("low");
    expect("partNumber" in reading).toBe(false);
    expect(reading.vendor).toBe("Keyence");
    // otherText is the whole recovery path when the code is gone; it must not
    // be summarised away.
    expect(reading.otherText).toEqual(["12-24 VDC", "NPN", "IP67", "MADE IN JAPAN"]);
  });

  it("checks stop_reason before touching content on a refusal", async () => {
    const response: VisionResponse = { stop_reason: "refusal" };
    Object.defineProperty(response, "content", {
      get() {
        throw new Error("content was read before stop_reason was checked");
      },
    });
    const { client } = fakeClient(response);

    await expect(readLabel(client, IMAGE)).rejects.toMatchObject({
      name: "LabelReadingError",
      reason: "refusal",
    });
  });

  it("throws rather than inventing an illegible reading when output is unusable", async () => {
    const malformed = fakeClient({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Sorry, I can't make out the label." }],
    });
    await expect(readLabel(malformed.client, IMAGE)).rejects.toBeInstanceOf(LabelReadingError);
    await expect(readLabel(malformed.client, IMAGE)).rejects.toMatchObject({ reason: "malformed" });

    const empty = fakeClient({ stop_reason: "end_turn", content: [] });
    await expect(readLabel(empty.client, IMAGE)).rejects.toMatchObject({ reason: "empty" });
  });

  it("refuses to call the model with no image data", async () => {
    const { client, calls } = fakeClient(structured(CLEAN_PLATE));
    await expect(
      readLabel(client, { mediaType: "image/webp", base64: "   " }),
    ).rejects.toMatchObject({
      reason: "empty",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("applyHonestyClamps", () => {
  const base: LabelReading = {
    partNumber: "GTB6-P4212",
    otherText: [],
    legible: true,
    confidence: "high",
    uncertainCharacters: [],
  };

  it("leaves a fully-read part number alone", () => {
    expect(applyHonestyClamps(base)).toEqual(base);
  });

  it("never raises a confidence the model reported low", () => {
    const clamped = applyHonestyClamps({
      ...base,
      confidence: "low",
      uncertainCharacters: ["1:6|G"],
    });
    expect(clamped.confidence).toBe("low");
    expect(clamped.legible).toBe(false);
  });

  it("treats a missing part number as unusable regardless of what the model claimed", () => {
    // `exactOptionalPropertyTypes`: omit the key, never assign undefined to it.
    const { partNumber: _omitted, ...withoutPartNumber } = base;
    const clamped = applyHonestyClamps(withoutPartNumber);
    expect(clamped.legible).toBe(false);
    expect(clamped.confidence).toBe("low");
  });
});

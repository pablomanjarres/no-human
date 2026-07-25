import { describe, expect, it } from "vitest";
import { type AskTurn, applyEvent, createAskParser, toHistory } from "@/lib/ask";

const empty = (): AskTurn => ({ role: "assistant", text: "", tools: [] });

describe("createAskParser", () => {
  it("emits one event per complete line", () => {
    const p = createAskParser();
    const events = p.push('{"type":"text","text":"a"}\n{"type":"done","toolCalls":0}\n');
    expect(events).toEqual([
      { type: "text", text: "a" },
      { type: "done", toolCalls: 0 },
    ]);
  });

  it("holds a partial line until its newline arrives", () => {
    const p = createAskParser();
    // This is the case that matters: chunk boundaries do not respect lines.
    expect(p.push('{"type":"text",')).toEqual([]);
    expect(p.push('"text":"split"}')).toEqual([]);
    expect(p.push("\n")).toEqual([{ type: "text", text: "split" }]);
  });

  it("reassembles a line split across many chunks", () => {
    const p = createAskParser();
    const line = '{"type":"text","text":"hello world"}\n';
    const out = [...line].flatMap((ch) => p.push(ch));
    expect(out).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("returns a trailing line with no newline only on flush", () => {
    const p = createAskParser();
    expect(p.push('{"type":"done","toolCalls":2}')).toEqual([]);
    expect(p.flush()).toEqual([{ type: "done", toolCalls: 2 }]);
  });

  it("flushes nothing when the stream ended cleanly", () => {
    const p = createAskParser();
    p.push('{"type":"done","toolCalls":0}\n');
    expect(p.flush()).toEqual([]);
  });

  it("skips blank lines", () => {
    const p = createAskParser();
    expect(p.push('\n\n{"type":"text","text":"x"}\n\n')).toEqual([{ type: "text", text: "x" }]);
  });

  it("surfaces a malformed line instead of dropping it", () => {
    const p = createAskParser();
    const [event] = p.push("not json\n");
    expect(event?.type).toBe("error");
    expect((event as { message: string }).message).toContain("Malformed");
  });

  it("rejects well-formed JSON that is not an event", () => {
    const p = createAskParser();
    const [event] = p.push('{"hello":"world"}\n');
    expect(event?.type).toBe("error");
    expect((event as { message: string }).message).toContain("Unrecognised");
  });
});

describe("applyEvent", () => {
  it("separates consecutive text blocks with a blank line", () => {
    let t = empty();
    t = applyEvent(t, { type: "text", text: "First." });
    t = applyEvent(t, { type: "text", text: "Second." });
    expect(t.text).toBe("First.\n\nSecond.");
  });

  it("does not lead with a blank line on the first block", () => {
    const t = applyEvent(empty(), { type: "text", text: "Only." });
    expect(t.text).toBe("Only.");
  });

  it("records tool calls in order", () => {
    let t = empty();
    t = applyEvent(t, { type: "tool", name: "search_catalog", input: { q: "x" } });
    t = applyEvent(t, { type: "tool", name: "solve_constraints", input: { mm: 400 } });
    expect(t.tools.map((c) => c.name)).toEqual(["search_catalog", "solve_constraints"]);
  });

  it("marks the turn failed on an error", () => {
    const t = applyEvent(empty(), { type: "error", message: "boom" });
    expect(t.failed).toBe(true);
    expect(t.text).toBe("boom");
  });

  it("leaves the turn untouched on done", () => {
    const before = applyEvent(empty(), { type: "text", text: "answer" });
    expect(applyEvent(before, { type: "done", toolCalls: 3 })).toEqual(before);
  });
});

describe("toHistory", () => {
  it("keeps roles and drops the tool calls the API cannot accept back", () => {
    const turns: AskTurn[] = [
      { role: "user", text: "q", tools: [] },
      { role: "assistant", text: "a", tools: [{ name: "search_catalog", input: {} }] },
    ];
    expect(toHistory(turns)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("drops empty and failed turns so a retry is not poisoned", () => {
    const turns: AskTurn[] = [
      { role: "user", text: "q", tools: [] },
      { role: "assistant", text: "", tools: [] },
      { role: "assistant", text: "server exploded", tools: [], failed: true },
    ];
    expect(toHistory(turns)).toEqual([{ role: "user", content: "q" }]);
  });
});

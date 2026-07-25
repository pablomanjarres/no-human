"use client";

import { useEffect, useRef, useState } from "react";
import { type AskTurn, applyEvent, createAskParser, toHistory } from "@/lib/ask";
import { Panel, PanelHead } from "./primitives";

/**
 * The live application-engineer lane.
 *
 * Everywhere else in this console the answer is computed and a model is nowhere
 * near it. Here a model runs — and the thing worth putting on screen is not the
 * prose, it is the tool calls underneath it. Every part number in the answer came
 * out of `search_catalog` / `solve_constraints` against the deterministic index,
 * so the trace is the evidence that the model narrated a solve rather than
 * performed one. That is why tool calls render inline, in order, as they arrive,
 * rather than being hidden behind a disclosure.
 */

const SUGGESTIONS = [
  "Necesito detectar cajas de cartón a 40 cm en una cinta transportadora",
  "¿Qué uso para contar botellas transparentes?",
  "Sensor con salida PNP, IP67, que detecte a 400 mm",
];

type Status = "idle" | "streaming" | "error";

export function AskPanel() {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // `status` is state, so two calls landing in the same tick would both read
  // "idle" and both start a stream, and `updateLast` would then interleave two
  // answers into one turn. A ref flips synchronously and cannot be raced.
  const busy = useRef(false);
  const streaming = status === "streaming";

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  async function ask(question: string) {
    if (busy.current || question.trim() === "") return;
    busy.current = true;
    setNotice(null);
    setStatus("streaming");

    // Snapshot before appending: history is the conversation *before* this turn.
    const history = toHistory(turns);
    const asked: AskTurn = { role: "user", text: question, tools: [] };
    setTurns((prev) => [...prev, asked, { role: "assistant", text: "", tools: [] }]);

    // Only the assistant turn moves while the stream runs, so every update
    // rewrites the last element rather than rebuilding the list.
    const updateLast = (fn: (t: AskTurn) => AskTurn) =>
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last) next[next.length - 1] = fn(last);
        return next;
      });

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, history }),
      });

      if (!res.ok || !res.body) {
        // 503 is the documented no-credential case and deserves plain language
        // rather than a status code the visitor has to look up.
        const detail = await res
          .json()
          .then((d: { error?: string }) => d.error)
          .catch(() => null);
        const message =
          res.status === 503
            ? "The server has no ANTHROPIC_API_KEY set, so the live lane is off. Every other lane in this console is deterministic and still works."
            : (detail ?? `The request failed (${res.status}).`);
        updateLast((t) => ({ ...t, failed: true, text: message }));
        setStatus("error");
        setNotice(message);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createAskParser();
      let failed = false;

      const handle = (events: ReturnType<typeof parser.push>) => {
        for (const event of events) {
          if (event.type === "error") failed = true;
          updateLast((t) => applyEvent(t, event));
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        handle(parser.push(decoder.decode(value, { stream: true })));
      }
      handle(parser.flush());

      setStatus(failed ? "error" : "idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateLast((t) => ({ ...t, failed: true, text: message }));
      setStatus("error");
      setNotice(message);
    } finally {
      // Every exit path, including the early return on a non-OK response —
      // leaking this leaves the panel permanently unable to ask again.
      busy.current = false;
    }
  }

  return (
    <Panel>
      <PanelHead
        eyebrow="Application engineer"
        title="live · claude-opus-5"
        right={
          turns.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setTurns([]);
                setNotice(null);
                setStatus("idle");
              }}
              disabled={streaming}
              className="border border-cab-600 px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:border-sick hover:text-sick disabled:opacity-40"
            >
              New thread
            </button>
          ) : null
        }
      />

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {turns.length === 0 ? (
          <EmptyState onPick={(s) => void ask(s)} disabled={streaming} />
        ) : (
          <div className="space-y-3.5">
            {turns.map((turn, i) => (
              <Turn
                key={i}
                turn={turn}
                working={streaming && i === turns.length - 1 && turn.role === "assistant"}
              />
            ))}
          </div>
        )}
      </div>

      {notice ? (
        <div
          role="status"
          className="shrink-0 border-t px-3.5 py-2 text-[11.5px] leading-[1.5]"
          style={{
            borderColor: "color-mix(in oklab, var(--color-halt) 30%, transparent)",
            background: "var(--color-halt-wash)",
            color: "var(--color-halt)",
          }}
        >
          {notice}
        </div>
      ) : null}

      <form
        className="shrink-0 border-t border-rail bg-cab-850 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text) return;
          setDraft("");
          void ask(text);
        }}
      >
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={streaming}
            placeholder={streaming ? "Working…" : "Describe the application, or ask a question…"}
            aria-label="Ask the application engineer"
            className="min-w-0 flex-1 bg-transparent font-sans text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={streaming || draft.trim() === ""}
            className="shrink-0 border border-cab-600 px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-sick hover:text-sick disabled:opacity-40 disabled:hover:border-cab-600 disabled:hover:text-ink-dim"
          >
            {streaming ? "…" : "Send →"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function EmptyState({ onPick, disabled }: { onPick: (s: string) => void; disabled: boolean }) {
  return (
    <div className="py-6">
      <p className="text-[13px] leading-[1.6] text-ink-dim">
        This is the one lane with a model in it. It reads the catalogue through the same
        deterministic solver the rest of the console uses, so it cannot name a part the index did
        not return — every tool call it makes is printed below its answer.
      </p>
      <p className="mt-2.5 text-[12.5px] leading-[1.6] text-ink-faint">
        It asks before it guesses. If you leave out the target material or the distance, expect a
        question rather than a recommendation.
      </p>
      <div className="mt-4 flex flex-col gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s)}
            className="border border-cab-600 px-2.5 py-1.5 text-left text-[12.5px] leading-[1.4] text-ink-dim transition-colors hover:border-sick hover:bg-sick-wash hover:text-ink disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Turn({ turn, working }: { turn: AskTurn; working: boolean }) {
  if (turn.role === "user") {
    return (
      <div className="anim-in flex justify-end">
        <div
          className="max-w-[85%] border px-2.5 py-1.5"
          style={{
            background: "var(--color-sick-wash)",
            borderColor: "color-mix(in oklab, var(--color-sick) 22%, transparent)",
          }}
        >
          <p className="font-mono text-[12px] leading-[1.5] text-ink">{turn.text}</p>
        </div>
      </div>
    );
  }

  const border = turn.failed ? "var(--color-halt)" : "var(--color-cab-600)";

  return (
    <div className="anim-in border-l-2 pl-3" style={{ borderColor: border }}>
      <div className="flex items-baseline gap-2">
        <span
          className="font-mono text-[9.5px] uppercase tracking-[0.14em]"
          style={{ color: turn.failed ? "var(--color-halt)" : "var(--color-sick)" }}
        >
          application engineer
        </span>
        {turn.tools.length > 0 ? (
          <span className="font-mono text-[9.5px] text-ink-faint">
            {turn.tools.length} tool {turn.tools.length === 1 ? "call" : "calls"}
          </span>
        ) : null}
      </div>

      {turn.tools.length > 0 ? (
        <ol className="mt-2 space-y-1">
          {turn.tools.map((call, i) => (
            <li
              key={i}
              className="border border-cab-700 bg-cab-800 px-2 py-1.5 font-mono text-[10px] leading-[1.5]"
            >
              <span className="text-sick">{call.name}</span>
              <span className="text-ink-faint">({summarise(call.input)})</span>
            </li>
          ))}
        </ol>
      ) : null}

      {turn.text ? (
        <div className="mt-2 space-y-2">
          {turn.text.split("\n\n").map((para, i) => (
            <p
              key={i}
              className="text-[13px] leading-[1.6] whitespace-pre-wrap"
              style={{ color: turn.failed ? "var(--color-halt)" : "var(--color-ink-dim)" }}
            >
              {para}
            </p>
          ))}
        </div>
      ) : null}

      {working ? <div className="sweep mt-2 h-[2px] w-full bg-cab-700" /> : null}
    </div>
  );
}

/** Tool arguments, short enough to sit on one line of the trace. */
function summarise(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return String(input);
  const parts = Object.entries(input as Record<string, unknown>).map(
    ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
  );
  const joined = parts.join(", ");
  return joined.length > 110 ? `${joined.slice(0, 107)}…` : joined;
}

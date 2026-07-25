"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentName, Citation, SolveRun, ThreadMessage, TraceEvent } from "@/lib/types";
import { CiteLink, Chip, Panel, PanelHead } from "./primitives";

/**
 * Who is speaking. These are label inks, so every one of them is a text-safe
 * tone: the challenger and the verifier take the darkened amber, and the
 * extractor takes ink-faint rather than rail-bright, which is a border tone and
 * cannot carry a 9.5px badge.
 */
const AGENT_ACCENT: Record<AgentName, string> = {
  resolver: "var(--color-sick)",
  solver: "var(--color-ink-dim)",
  challenger: "var(--color-signal)",
  verifier: "var(--color-signal)",
  extractor: "var(--color-ink-faint)",
};

const STATUS_ACCENT: Record<TraceEvent["status"], string> = {
  ok: "var(--color-sick)",
  warn: "var(--color-signal)",
  halt: "var(--color-halt)",
};

type View = "thread" | "trace";

/**
 * The consultation column.
 *
 * The brief says a chat window hides the agents. It is also true that someone who
 * does not know what sensor they need has a conversation, not a query. So this is a
 * thread — but no agent turn is a bare paragraph. Each one carries the trace of what
 * it did, a question renders as answerable options with the effect of each answer
 * spelled out, and an underspecified input returns a question rather than a guess.
 */
export function ConsultationPanel({
  run,
  elapsed,
  working,
  onCite,
  onAsk,
  onAnswer,
}: {
  run: SolveRun | null;
  elapsed: number;
  working: boolean;
  onCite?: (c: Citation) => void;
  onAsk: (text: string) => void;
  onAnswer: (value: string, label: string) => void;
}) {
  const [view, setView] = useState<View>("thread");
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  const messages = run ? run.thread.filter((m) => m.at <= elapsed) : [];
  const events = run ? run.trace.filter((e) => e.at <= elapsed) : [];
  const live = run ? run.trace.filter((e) => e.at > elapsed)[0] : undefined;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, events.length, view]);

  return (
    <Panel>
      <PanelHead
        eyebrow="Consultation"
        right={
          <div className="flex rounded-[2px] border border-cab-600" role="tablist" aria-label="Consultation view">
            {(["thread", "trace"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className="px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.12em] transition-colors"
                style={{
                  background: view === v ? "var(--color-cab-600)" : "transparent",
                  color: view === v ? "var(--color-ink)" : "var(--color-ink-faint)",
                }}
              >
                {v === "thread" ? "Thread" : "Raw trace"}
              </button>
            ))}
          </div>
        }
      />

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {!run ? (
          <EmptyState />
        ) : view === "thread" ? (
          <div className="space-y-3.5">
            {messages.map((m) => (
              <ThreadTurn key={m.id} message={m} onCite={onCite} onAnswer={onAnswer} />
            ))}
            {working && live ? <Working event={live} /> : null}
          </div>
        ) : (
          <TraceList events={events} live={working ? live : undefined} />
        )}
      </div>

      <form
        className="shrink-0 border-t border-rail bg-cab-850 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text) return;
          onAsk(text);
          setDraft("");
        }}
      >
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask, or describe the application…"
            aria-label="Ask the application engineer"
            className="min-w-0 flex-1 bg-transparent font-sans text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button
            type="submit"
            className="shrink-0 border border-cab-600 px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-sick hover:text-sick"
          >
            Send →
          </button>
        </div>
      </form>
    </Panel>
  );
}

function EmptyState() {
  return (
    <div className="py-8">
      <p className="text-[13px] leading-[1.6] text-ink-dim">
        A line is down. The sensor is a Banner. The distributor has SICK in stock.
      </p>
      <p className="mt-2.5 text-[12.5px] leading-[1.6] text-ink-faint">
        Type the part number above, or describe what you need to detect. If the description is
        underspecified, this column asks a question instead of guessing — that is the point.
      </p>
    </div>
  );
}

function AgentBadge({ agent }: { agent: AgentName }) {
  return (
    <span
      className="font-mono text-[9.5px] uppercase tracking-[0.14em]"
      style={{ color: AGENT_ACCENT[agent] }}
    >
      {agent}
    </span>
  );
}

function ThreadTurn({
  message,
  onCite,
  onAnswer,
}: {
  message: ThreadMessage;
  onCite?: ((c: Citation) => void) | undefined;
  onAnswer: (value: string, label: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="anim-in flex justify-end">
        {/* The human's turn: a tinted plate, not a filled slab. Blue because the
            person asking is the one the brand belongs to. */}
        <div
          className="max-w-[85%] border px-2.5 py-1.5"
          style={{
            background: "var(--color-sick-wash)",
            borderColor: "color-mix(in oklab, var(--color-sick) 22%, transparent)",
          }}
        >
          <p className="font-mono text-[12px] leading-[1.5] text-ink">{message.text}</p>
        </div>
      </div>
    );
  }

  if (message.role === "question") {
    return (
      <div
        className="anim-in border-l-2 pl-3"
        style={{ borderColor: "var(--color-signal)" }}
      >
        <div className="flex items-baseline gap-2">
          <AgentBadge agent={message.agent} />
          <span className="eyebrow" style={{ color: "var(--color-signal)" }}>
            asking, not guessing
          </span>
        </div>
        <p className="mt-1.5 text-[13.5px] font-medium leading-[1.5] text-ink">{message.text}</p>
        <p className="mt-1.5 text-[11.5px] leading-[1.55] text-ink-faint">{message.why}</p>
        {/* The effect sits on its own line rather than in a shrink-0 span beside
            the label: at every width from 375px up it was being cut off, and the
            effect is the half of the option that says what answering costs. */}
        <div className="mt-2.5 flex flex-col gap-1.5">
          {message.options.map((o) => (
            <button
              key={o.value + o.label}
              type="button"
              onClick={() => onAnswer(o.value, o.label)}
              className="group flex w-full flex-col items-start gap-0.5 border border-cab-600 px-2.5 py-1.5 text-left transition-colors hover:border-signal hover:bg-signal-wash"
            >
              <span className="text-[12.5px] leading-[1.4] text-ink-dim group-hover:text-ink">
                {o.label}
              </span>
              <span className="font-mono text-[9.5px] leading-[1.45] text-ink-faint">
                {o.effect}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const tone = message.tone ?? "neutral";
  const border =
    tone === "halt"
      ? "var(--color-halt)"
      : tone === "caution"
        ? "var(--color-signal)"
        : "var(--color-cab-600)";

  return (
    <div className="anim-in border-l-2 pl-3" style={{ borderColor: border }}>
      <div className="flex items-baseline gap-2">
        <AgentBadge agent={message.agent} />
        <span className="font-mono text-[9.5px] text-ink-faint">
          {(message.at / 1000).toFixed(2)}s
        </span>
      </div>

      <p className="mt-1.5 text-[13px] leading-[1.6] text-ink-dim">{message.text}</p>

      {message.did?.length ? (
        <ul className="mt-2 space-y-0.5">
          {message.did.map((d) => (
            <li key={d} className="flex gap-1.5 font-mono text-[10.5px] leading-[1.45] text-ink-faint">
              <span aria-hidden>├</span>
              <span className="flex-1">{d}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {message.chips?.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {message.chips.map((c) => (
            <Chip key={c} accent="sick">
              {c}
            </Chip>
          ))}
        </div>
      ) : null}

      {message.citations?.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          {message.citations.map((c) => (
            <span key={c.docId + c.page} className="flex items-center gap-1.5">
              <span className="font-mono text-[9.5px] text-ink-faint">{c.docTitle.split(" — ")[0]}</span>
              <CiteLink citation={c} {...(onCite ? { onOpen: onCite } : {})} />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Working({ event }: { event: TraceEvent }) {
  return (
    <div className="border-l-2 border-cab-600 pl-3">
      <div className="flex items-baseline gap-2">
        <AgentBadge agent={event.agent} />
        <span className="font-mono text-[9.5px] text-ink-faint">working…</span>
      </div>
      <div className="sweep mt-2 h-[2px] w-full bg-cab-700" />
    </div>
  );
}

export function TraceList({ events, live }: { events: TraceEvent[]; live?: TraceEvent | undefined }) {
  return (
    <ol className="relative pl-5">
      <span className="trace-spine" aria-hidden />
      {events.map((e) => (
        <li key={e.id} className="anim-in relative pb-3.5 last:pb-0">
          <span
            className="trace-node"
            style={{ "--node-accent": STATUS_ACCENT[e.status] } as React.CSSProperties}
            aria-hidden
          />
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[9.5px] tabular-nums text-ink-faint">
              {(e.at / 1000).toFixed(2)}
            </span>
            <span
              className="font-mono text-[9.5px] uppercase tracking-[0.14em]"
              style={{ color: AGENT_ACCENT[e.agent] }}
            >
              {e.agent}
            </span>
          </div>
          <p className="mt-0.5 text-[12.5px] leading-[1.45]" style={{ color: STATUS_ACCENT[e.status] }}>
            {e.title}
          </p>
          {e.detail ? (
            <p className="mt-0.5 text-[11.5px] leading-[1.5] text-ink-faint">{e.detail}</p>
          ) : null}
          {/* Recessed tool call. cab-950 is the page ground now rather than the
              darkest surface — the recessed tone on a white panel is 800. */}
          {e.tool ? (
            <div className="mt-1.5 border border-cab-700 bg-cab-800 px-2 py-1.5 font-mono text-[10px] leading-[1.5]">
              <div className="text-ink-dim">
                <span className="text-sick">{e.tool.name}</span>
                <span className="text-ink-faint">({e.tool.args})</span>
              </div>
              <div className="mt-0.5 flex gap-1.5 text-ink-faint">
                <span aria-hidden>→</span>
                <span>{e.tool.result}</span>
              </div>
            </div>
          ) : null}
          {e.chips?.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {e.chips.map((c) => (
                <Chip key={c}>{c}</Chip>
              ))}
            </div>
          ) : null}
        </li>
      ))}
      {live ? (
        <li className="relative pb-0">
          <span
            className="trace-node"
            data-live="true"
            style={{ "--node-accent": STATUS_ACCENT[live.status] } as React.CSSProperties}
            aria-hidden
          />
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-faint">
            {live.agent} working…
          </span>
        </li>
      ) : null}
    </ol>
  );
}

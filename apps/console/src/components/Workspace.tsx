"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildMissRun, solve } from "@/lib/engine";
import type { Citation, CorpusStats, InputMode, SolveRun } from "@/lib/types";
import { ConsultationPanel } from "./ConsultationPanel";
import { ConstraintStrip, InputBar } from "./InputBar";
import { EquivalentPanel } from "./EquivalentPanel";
import { SourcePanel } from "./SourcePanel";
import { TelemetryRail } from "./TelemetryRail";

const TAIL_MS = 500;

export function Workspace({
  stats,
  initialRun = null,
  initialMode = "part",
  initialAt,
}: {
  stats: CorpusStats;
  /** Resolved on the server so a deep link renders the solve on first paint. */
  initialRun?: SolveRun | null;
  initialMode?: InputMode;
  /** Freeze the replay at this millisecond instead of playing it. "end" jumps to the verdict. */
  initialAt?: number | "end";
}) {
  const [mode, setMode] = useState<InputMode>(initialMode);
  const [run, setRun] = useState<SolveRun | null>(initialRun);
  const [elapsed, setElapsed] = useState(() => {
    if (!initialRun) return 0;
    const end = initialRun.stats.durationMs + TAIL_MS;
    if (initialAt === "end") return end;
    return typeof initialAt === "number" ? initialAt : 0;
  });
  const [playing, setPlaying] = useState(() => Boolean(initialRun) && initialAt === undefined);
  const [cite, setCite] = useState<Citation | null>(null);
  const raf = useRef(0);

  const total = run ? run.stats.durationMs + TAIL_MS : 0;

  const start = useCallback((next: SolveRun, freezeAt?: number | "end") => {
    setRun(next);
    setCite(null);
    const end = next.stats.durationMs + TAIL_MS;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (freezeAt !== undefined) {
      setElapsed(freezeAt === "end" ? end : freezeAt);
      setPlaying(false);
    } else if (reduced) {
      setElapsed(end);
      setPlaying(false);
    } else {
      setElapsed(0);
      setPlaying(true);
    }
  }, []);

  // Replay driver. The whole solve is deterministic, so it can be scrubbed and
  // re-run on demand — the presenter needs the challenger kill on a button.
  useEffect(() => {
    if (!playing || !run) return;
    let t0 = 0;
    const step = (ts: number) => {
      if (!t0) t0 = ts;
      const e = ts - t0;
      setElapsed(e);
      if (e < total) raf.current = requestAnimationFrame(step);
      else setPlaying(false);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, run, total]);

  const handleSolve = useCallback(
    (m: InputMode, raw: string) => {
      const input = { mode: m, raw };
      start(solve(input) ?? buildMissRun(input));
    },
    [start],
  );


  const handleAsk = useCallback(
    (text: string) => {
      const looksLikePart = /^[A-Za-z0-9][A-Za-z0-9\-/. ]{3,}$/.test(text) && /\d/.test(text);
      const input = { mode: looksLikePart ? ("part" as const) : ("describe" as const), raw: text };
      setMode(input.mode);
      start(solve(input) ?? buildMissRun(input));
    },
    [start],
  );

  // Answering a clarifying question is what runs the solve. That is the product:
  // an underspecified input returns a question, and the answer returns a part.
  const handleAnswer = useCallback(
    (_value: string, label: string) => {
      if (run?.id === "run-describe") {
        start(solve({ mode: "part", raw: "QS18VN6LV" }) ?? buildMissRun({ mode: "part", raw: "" }));
        return;
      }
      if (run && !playing) {
        setElapsed(0);
        setPlaying(true);
      }
      void label;
    },
    [run, playing, start],
  );

  const working = playing && run !== null && elapsed < run.stats.durationMs;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TelemetryRail stats={stats} />
      <InputBar mode={mode} onModeChange={setMode} onSolve={handleSolve} busy={working} />
      {run && run.constraints.length > 0 ? <ConstraintStrip constraints={run.constraints} /> : null}

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-y-auto bg-rail lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)] lg:overflow-hidden">
        {run ? (
          <SourcePanel part={run.source} onCite={setCite} />
        ) : (
          <Placeholder eyebrow="Source" line="The part being replaced lands here." />
        )}

        {run ? (
          <EquivalentPanel run={run} elapsed={elapsed} onCite={setCite} />
        ) : (
          <Placeholder
            eyebrow="SICK equivalent"
            line="Every spec is drawn as a constraint rail: the bracket is the window the solver requires, the tick is the candidate. The model never picks the part."
          />
        )}

        <ConsultationPanel
          run={run}
          elapsed={elapsed}
          working={working}
          onCite={setCite}
          onAsk={handleAsk}
          onAnswer={handleAnswer}
        />
      </main>

      <Transport
        run={run}
        elapsed={elapsed}
        total={total}
        playing={playing}
        onScrub={(v) => {
          setPlaying(false);
          setElapsed(v);
        }}
        onReplay={() => {
          setElapsed(0);
          setPlaying(true);
        }}
      />

      {cite ? <CitationDrawer citation={cite} onClose={() => setCite(null)} /> : null}
    </div>
  );
}

function Placeholder({ eyebrow, line }: { eyebrow: string; line: string }) {
  return (
    <section className="panel flex min-h-0 flex-col">
      <header className="panel-head shrink-0">
        <span className="eyebrow">{eyebrow}</span>
      </header>
      <div className="flex-1 px-4 pt-4">
        <p className="max-w-[38ch] text-[12.5px] leading-[1.6] text-ink-faint">{line}</p>
      </div>
    </section>
  );
}

function Transport({
  run,
  elapsed,
  total,
  playing,
  onScrub,
  onReplay,
}: {
  run: SolveRun | null;
  elapsed: number;
  total: number;
  playing: boolean;
  onScrub: (v: number) => void;
  onReplay: () => void;
}) {
  const current = run?.trace.filter((e) => e.at <= elapsed).at(-1);
  const kill = run?.promotion;

  return (
    <footer className="flex shrink-0 items-center gap-3 border-t border-rail bg-cab-900 px-3.5 py-1.5">
      <button
        type="button"
        onClick={onReplay}
        disabled={!run}
        className="shrink-0 border border-cab-600 px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-sick hover:text-sick disabled:opacity-40"
      >
        ⟲ Replay
      </button>

      {kill ? (
        <button
          type="button"
          onClick={() => onScrub(Math.max(kill.at - 260, 0))}
          className="shrink-0 border px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.12em] transition-opacity hover:opacity-80"
          style={{ borderColor: "var(--color-halt-deep)", color: "var(--color-halt)" }}
          title="Jump to the moment the challenger kills rank 1"
        >
          ⏵ The kill
        </button>
      ) : null}

      <input
        type="range"
        min={0}
        max={Math.max(total, 1)}
        value={Math.min(elapsed, total)}
        onChange={(e) => onScrub(Number(e.target.value))}
        disabled={!run}
        aria-label="Scrub the solve"
        className="h-1 min-w-0 flex-1 appearance-none rounded-none bg-cab-700 accent-[var(--color-sick)] disabled:opacity-40"
      />

      <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-ink-faint">
        {(Math.min(elapsed, total) / 1000).toFixed(2)}s / {(total / 1000).toFixed(2)}s
      </span>

      <span className="hidden min-w-0 shrink-0 items-baseline gap-2 md:flex">
        <span className="w-px self-stretch bg-cab-700" aria-hidden />
        <span
          className="truncate font-mono text-[9.5px] uppercase tracking-[0.12em]"
          style={{ color: playing ? "var(--color-sick)" : "var(--color-ink-faint)" }}
        >
          {current ? `${current.agent} · ${current.title}` : "idle"}
        </span>
      </span>
    </footer>
  );
}

/**
 * Grounding you can click. The snippet is the exact line the value was read from;
 * the link goes to the full extracted page.
 */
function CitationDrawer({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Citation: ${citation.docTitle} page ${citation.page}`}
      onClick={onClose}
    >
      <div
        className="panel anim-in w-full max-w-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="eyebrow shrink-0">{citation.brand}</span>
            <span className="truncate font-mono text-[11px] text-ink-dim">{citation.docTitle}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close citation"
            className="shrink-0 font-mono text-[11px] text-ink-faint transition-colors hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="px-4 py-4">
          <span className="eyebrow">Page {citation.page} · extracted text layer</span>
          <blockquote
            className="mt-2 border-l-2 py-1 pl-3 font-mono text-[13px] leading-[1.6]"
            style={{ borderColor: "var(--color-signal)", color: "var(--color-ink)" }}
          >
            {citation.snippet ?? "—"}
          </blockquote>
          <p className="mt-3 text-[11.5px] leading-[1.55] text-ink-faint">
            Read from the locally cached PDF during the offline extraction pass. Nothing is fetched
            at request time.
          </p>
          <Link
            href={citation.href}
            className="mt-3 inline-block font-mono text-[10.5px] uppercase tracking-[0.12em] text-sick transition-opacity hover:opacity-80"
          >
            Open the full page →
          </Link>
        </div>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DescribeAnswers, buildDescribeRun, parseDescription } from "@/lib/describe";
import { buildMissRun, classifyInput, solve } from "@/lib/engine";
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
  // Bumped on every replay. Without it, clicking Replay mid-playback leaves the
  // already-armed rAF loop holding its original t0, which overwrites elapsed on
  // the very next frame and the button looks broken.
  const [take, setTake] = useState(0);
  // Answers to the Describe lane's clarifying questions, cleared whenever a new
  // input starts so one application's carton never derates the next one's box.
  const [answers, setAnswers] = useState<DescribeAnswers>({});
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
  }, [playing, run, total, take]);

  const handleSolve = useCallback(
    (m: InputMode, raw: string) => {
      // Picking the Part Number tab and then typing a sentence is a description,
      // not a lookup. Reroute rather than answering "not in the corpus" to a
      // question the corpus was never going to contain.
      const mode = m === "part" ? classifyInput(raw) : m;
      const input = { mode, raw };
      // Only move the tab when the reroute actually happened. The Photo and BOM
      // samples submit as "part", and switching the tab out from under them
      // would look like the console losing its place.
      if (mode !== m) setMode(mode);
      setAnswers({});
      start(solve(input) ?? buildMissRun(input));
    },
    [start],
  );

  const handleAsk = useCallback(
    (text: string) => {
      const input = { mode: classifyInput(text), raw: text };
      setMode(input.mode);
      setAnswers({});
      start(solve(input) ?? buildMissRun(input));
    },
    [start],
  );

  // Answering a clarifying question is what runs the solve. That is the product:
  // an underspecified input returns a question, and the answer returns a part —
  // a deterministic pass over 796 SKUs from the SICK short-form catalogue.
  //
  // Which question is on screen is derived from the description rather than
  // tracked separately, so the answer can never be applied to the wrong slot.
  // "I don't know" is a real answer and halts with a reason; it used to hit an
  // early return, leaving the option on screen doing nothing at all.
  const handleAnswer = useCallback(
    (value: string, _label: string) => {
      if (run?.id.startsWith("describe-")) {
        const pending = parseDescription(run.input.raw, answers).remission
          ? "distance"
          : "remission";

        if (value === "unknown") {
          start(buildDescribeRun(run.input, answers, pending));
          return;
        }

        let next: DescribeAnswers;
        if (pending === "remission") {
          next = { ...answers, remission: value };
        } else {
          const distanceMm = Number(value);
          if (!Number.isFinite(distanceMm)) return;
          next = { ...answers, distanceMm };
        }
        setAnswers(next);
        start(buildDescribeRun(run.input, next));
        return;
      }
      if (run) {
        setElapsed(0);
        setPlaying(true);
        setTake((n) => n + 1);
      }
    },
    [run, answers, start],
  );

  const replay = useCallback(() => {
    setElapsed(0);
    setPlaying(true);
    setTake((n) => n + 1);
  }, []);

  // Stable: the drawer's focus manager keys off this identity, and the parent
  // re-renders every animation frame while a replay is playing.
  const closeCite = useCallback(() => setCite(null), []);

  const working = playing && run !== null && elapsed < run.stats.durationMs;

  return (
    // Below lg the console is a document: the page scrolls and every panel is
    // printed at its natural height. Only at lg does it become a fixed-height
    // cabinet with three independently scrolling columns — capping the height on
    // a phone turned each panel into a ~115px porthole over 1500px of content.
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <TelemetryRail stats={stats} />
      <InputBar mode={mode} onModeChange={setMode} onSolve={handleSolve} busy={working} />
      {run && run.constraints.length > 0 ? <ConstraintStrip constraints={run.constraints} /> : null}

      <main className="grid flex-auto grid-cols-1 gap-px bg-rail lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,1fr)] lg:overflow-hidden">
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
        onReplay={replay}
      />

      {cite ? <CitationDrawer citation={cite} onClose={closeCite} /> : null}
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
    // Sticky below lg so the scrub bar stays reachable while the page scrolls;
    // at lg the shell is already viewport-height, so it is simply the bottom edge.
    <footer className="sticky bottom-0 z-20 flex shrink-0 items-center gap-3 border-t border-rail bg-cab-900 px-3.5 py-1.5 lg:static">
      <button
        type="button"
        onClick={onReplay}
        disabled={!run}
        className="shrink-0 border border-rail bg-cab-900 px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-dim transition-colors hover:border-sick hover:bg-sick-wash hover:text-sick disabled:opacity-50"
      >
        ⟲ Replay
      </button>

      {kill ? (
        <button
          type="button"
          onClick={() => onScrub(Math.max(kill.at - 260, 0))}
          className="shrink-0 border border-halt-bright bg-halt-wash px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.12em] text-halt transition-colors hover:border-halt"
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
        className="h-1 min-w-0 flex-1 appearance-none rounded-none bg-rail accent-[var(--color-sick)] disabled:opacity-50"
      />

      <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-ink-faint">
        {(Math.min(elapsed, total) / 1000).toFixed(2)}s / {(total / 1000).toFixed(2)}s
      </span>

      <span className="hidden min-w-0 shrink-0 items-baseline gap-2 md:flex">
        <span className="w-px self-stretch bg-cab-600" aria-hidden />
        <span
          className={`truncate font-mono text-[9.5px] uppercase tracking-[0.12em] ${
            playing ? "text-sick" : "text-ink-faint"
          }`}
        >
          {current ? `${current.agent} · ${current.title}` : "idle"}
        </span>
      </span>
    </footer>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Grounding you can click. The snippet is the exact line the value was read from;
 * the link goes to the full extracted page.
 */
function CitationDrawer({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  // Read through a ref so the focus effect runs once per open. Keying it on the
  // handler would re-run it on every animation frame of a replay, which would
  // yank focus back to the trigger 60 times a second.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialog.current;
      if (!root) return;
      const stops = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = stops[0];
      const last = stops.at(-1);
      if (!first || !last) {
        // Nothing tabbable inside: keep the ring on the dialog itself.
        e.preventDefault();
        root.focus();
        return;
      }
      const active = document.activeElement;
      const inside = root.contains(active);
      if (
        e.shiftKey ? active === first || active === root || !inside : active === last || !inside
      ) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Hand the caret back to whatever cell opened the citation.
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-dim/30 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Citation: ${citation.docTitle} page ${citation.page}`}
        className="panel anim-in w-full max-w-xl shadow-2xl shadow-ink/25 focus:outline-none"
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
          {/* The extracted line, marked the way an engineer marks a spec sheet:
              highlighter fill, saturated rule, ink text. */}
          <blockquote className="mt-2 border-l-2 border-signal-bright bg-signal-wash py-1.5 pr-2 pl-3 font-mono text-[13px] leading-[1.6] text-ink">
            {citation.snippet ?? "—"}
          </blockquote>
          <p className="mt-3 text-[11.5px] leading-[1.55] text-ink-faint">
            Read from the locally cached PDF during the offline extraction pass. Nothing is fetched
            at request time.
          </p>
          <Link
            href={citation.href}
            className="mt-3 inline-block font-mono text-[10.5px] uppercase tracking-[0.12em] text-sick underline-offset-4 transition-colors hover:text-sick-bright hover:underline"
          >
            Open the full page →
          </Link>
        </div>
      </div>
    </div>
  );
}

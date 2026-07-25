"use client";

import Link from "next/link";
import { OUTCOME_COPY } from "@/lib/engine";
import type { Candidate, Citation, Part, SolveRun } from "@/lib/types";
import { RailLegend, SpecDelta } from "./ConstraintRail";
import { ACCENT, BrandMark, Chip, Housing, Panel, PanelHead } from "./primitives";

const KILL_MS = 620;

export function EquivalentPanel({
  run,
  elapsed,
  onCite,
}: {
  run: SolveRun;
  elapsed: number;
  onCite?: (c: Citation) => void;
}) {
  const outcome = OUTCOME_COPY[run.outcome];
  const promotion = run.promotion;

  // The money shot. Before the promotion moment the panel shows rank 1; at the
  // moment the challenger kills it the card drops out and rank 2 slides up.
  const killing = Boolean(promotion && elapsed >= promotion.at && elapsed < promotion.at + KILL_MS);
  const promoted = Boolean(promotion && elapsed >= promotion.at + KILL_MS);

  const active: Candidate | undefined = run.candidates.length
    ? promotion && !promoted
      ? run.candidates[0]
      : (run.candidates.find((c) => c.verdict !== "rejected") ?? run.candidates[0])
    : undefined;

  return (
    <Panel>
      <PanelHead
        eyebrow="SICK equivalent"
        title={run.outcome === "refusal" ? "no defensible match" : "deterministic solve"}
        right={
          <Chip accent={outcome.accent} ink={ACCENT[outcome.accent]} title={outcome.line}>
            {outcome.label}
          </Chip>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {run.outcome === "refusal" && run.refusal ? (
          <RefusalCard run={run} />
        ) : run.outcome === "needs-input" ? (
          <NeedsInputCard run={run} />
        ) : active ? (
          <div
            key={active.part.id}
            className={killing ? "anim-killed" : promoted ? "anim-promoted" : ""}
          >
            <CandidateCard candidate={active} killing={killing} ghost={run.source} />
            <ul>
              {active.evaluations.map((ev) => (
                <SpecDelta key={ev.key} evaluation={ev} {...(onCite ? { onCite } : {})} />
              ))}
            </ul>
            <RailLegend />
            {active.losses.length ? <Losses losses={active.losses} /> : null}
          </div>
        ) : null}

        {run.candidates.length > 1 ? <CandidateLadder run={run} promoted={promoted} /> : null}
      </div>
    </Panel>
  );
}

function CandidateCard({
  candidate,
  killing,
  ghost,
}: {
  candidate: Candidate;
  killing: boolean;
  ghost?: Part;
}) {
  const { part } = candidate;
  const accent = killing ? "halt" : candidate.losses.length ? "signal" : "sick";

  return (
    <div className="border-b border-cab-700 px-3.5 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <BrandMark brand={part.brand} />
        <span className="font-mono text-[10px] text-ink-faint">
          rank {candidate.rank} · score {candidate.score.toFixed(2)}
        </span>
      </div>

      <Link
        href={`/console/product/${part.partNumber}`}
        className="nameplate mt-1 block text-[26px] leading-[1.05] text-ink transition-colors hover:text-sick"
      >
        {part.partNumber}
      </Link>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="eyebrow">{part.family}</span>
        {part.orderNumber ? (
          <span
            className="font-mono text-[11px] text-sick"
            title="SICK order number — this is what you buy"
          >
            order {part.orderNumber}
          </span>
        ) : null}
      </div>

      <div className="mt-3.5">
        <Housing part={part} accent={accent} {...(ghost ? { ghost } : {})} />
      </div>

      <p className="mt-3.5 text-[12.5px] leading-[1.55] text-ink-dim">{part.blurb}</p>
    </div>
  );
}

function Losses({ losses }: { losses: string[] }) {
  return (
    <div
      className="border-t px-3.5 py-3"
      style={{ borderColor: "var(--color-signal-deep)", background: "var(--color-signal-wash)" }}
    >
      <span className="eyebrow" style={{ color: "var(--color-signal)" }}>
        What you give up
      </span>
      <ul className="mt-2 space-y-1.5">
        {losses.map((l) => (
          <li key={l} className="flex gap-2 text-[12.5px] leading-[1.5] text-ink-dim">
            <span
              className="mt-[3px] shrink-0 font-mono text-[10px]"
              style={{ color: "var(--color-signal)" }}
            >
              −
            </span>
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RefusalCard({ run }: { run: SolveRun }) {
  const refusal = run.refusal;
  if (!refusal) return null;
  return (
    <div>
      <div
        className="border-b px-3.5 py-4"
        style={{ borderColor: "var(--color-halt-deep)", background: "var(--color-halt-wash)" }}
      >
        <span className="eyebrow" style={{ color: "var(--color-halt)" }}>
          Refusal
        </span>
        <h2
          className="nameplate mt-1.5 text-[22px] leading-[1.1]"
          style={{ color: "var(--color-halt)" }}
        >
          {refusal.headline}
        </h2>
        {/* Only say the challenger killed candidates when it actually did, and
            only say the solver never ran when it never ran. A part we hold but
            cannot find a stand-in for did reach the solver — reporting that as
            "no spec vector" would be the same unsourced assertion in the other
            direction. `constraints` is the tell: no constraint set, no solve. */}
        <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-dim">
          {run.attacks.some((a) => a.outcome === "kill") && run.stats.afterConstraints > 0
            ? `${run.stats.afterConstraints} candidates passed the base-spec filter. The challenger killed all of them. We will not claim compatibility we cannot source.`
            : run.constraints.length > 0
              ? `The solver ran over ${run.stats.catalogue.toLocaleString("en-US")} parts against ${run.constraints.length} constraints read from the catalogue. None of them cleared it. We will not claim compatibility we cannot source.`
              : "The solver was never invoked — there is no spec vector to solve against. We will not claim compatibility we cannot source."}
        </p>
      </div>

      <div className="px-3.5 py-3">
        <span className="eyebrow">Closest available</span>
        <p className="nameplate mt-1 text-[20px] leading-none text-ink">{refusal.closest}</p>
        <p className="mt-2.5 text-[12px] text-ink-faint">and what it would cost you:</p>
        <ul className="mt-2 space-y-2">
          {refusal.losses.map((l) => (
            <li key={l} className="flex gap-2 text-[12.5px] leading-[1.5] text-ink-dim">
              <span
                className="mt-[3px] shrink-0 font-mono text-[10px]"
                style={{ color: "var(--color-halt)" }}
              >
                −
              </span>
              {l}
            </li>
          ))}
        </ul>
      </div>

      {refusal.suggestions?.length ? <SuggestionList items={refusal.suggestions} /> : null}
    </div>
  );
}

/**
 * Near misses, as a question rather than an answer.
 *
 * Each row is a link that re-runs the console against that exact part number.
 * The type code and order number are both spelled out because that is what the
 * operator has to check against the thing in their hand — the whole reason we
 * are not picking one for them.
 */
function SuggestionList({
  items,
}: {
  items: NonNullable<NonNullable<SolveRun["refusal"]>["suggestions"]>;
}) {
  return (
    <div className="border-t border-rail px-3.5 py-3">
      <span className="eyebrow">Did you mean</span>
      <p className="mt-1.5 text-[12px] leading-[1.5] text-ink-faint">
        Close on the type code, not identical. Nothing here has been chosen for you.
      </p>
      <ul className="mt-2.5 flex flex-col">
        {items.map((s) => (
          <li key={s.partNumber} className="border-b border-rail last:border-b-0">
            <Link
              href={`/console?q=${encodeURIComponent(s.partNumber)}`}
              className="group flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-l-[3px] border-l-cab-600 py-2.5 pl-3 transition-colors hover:border-l-sick hover:bg-sick-wash focus-visible:border-l-sick focus-visible:bg-sick-wash"
            >
              <span className="font-mono text-[13px] text-ink transition-colors group-hover:text-sick-bright">
                {s.partNumber}
              </span>
              <span className="font-mono text-[10px] text-ink-faint">order {s.orderNumber}</span>
              <span className="text-[11.5px] leading-[1.4] text-ink-dim">{s.note}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NeedsInputCard({ run }: { run: SolveRun }) {
  return (
    <div className="px-3.5 py-4">
      <span className="eyebrow" style={{ color: "var(--color-signal)" }}>
        Solver not invoked
      </span>
      <h2 className="nameplate mt-1.5 text-[20px] leading-[1.15] text-ink">
        The binding constraint is missing.
      </h2>
      <p className="mt-2.5 text-[12.5px] leading-[1.55] text-ink-dim">
        {run.constraints.filter((c) => c.origin !== "asked").length} constraints came out of the
        description. The one that decides the answer did not. There is a question waiting in the
        consultation column — answering it runs the solve.
      </p>
      <ul className="mt-3.5 space-y-1.5">
        {run.constraints.map((c) => (
          <li key={c.key} className="flex items-baseline gap-2 text-[12px]">
            <span
              className="font-mono text-[10px]"
              style={{
                color: c.display === "unknown" ? "var(--color-signal)" : "var(--color-ink-faint)",
              }}
            >
              {c.display === "unknown" ? "?" : "■"}
            </span>
            <span className="flex-1 text-ink-dim">{c.label}</span>
            <span
              className="font-mono text-[11px]"
              style={{
                color: c.display === "unknown" ? "var(--color-signal)" : "var(--color-ink)",
              }}
            >
              {c.display}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The ranking, kept visible so the promotion is legible rather than magical. */
function CandidateLadder({ run, promoted }: { run: SolveRun; promoted: boolean }) {
  return (
    <div className="border-t border-cab-700 px-3.5 py-3">
      <span className="eyebrow">
        Solver ranking · {run.stats.afterConstraints} survived the hard filter
      </span>
      <ol className="mt-2 space-y-1">
        {run.candidates.map((c) => {
          const dead = c.verdict === "rejected" && promoted;
          const isActive = promoted
            ? c.verdict !== "rejected" && c.rank === run.promotion?.toRank
            : c.rank === 1;
          return (
            <li
              key={c.part.id}
              className="flex items-baseline gap-2 font-mono text-[11px]"
              style={{ opacity: dead ? 0.45 : 1 }}
            >
              <span className="w-3 text-ink-faint">{c.rank}</span>
              <Link
                href={`/console/product/${c.part.partNumber}`}
                className="flex-1 truncate transition-colors hover:text-sick"
                style={{
                  color: dead
                    ? "var(--color-halt)"
                    : isActive
                      ? "var(--color-sick)"
                      : "var(--color-ink-dim)",
                  textDecoration: dead ? "line-through" : "none",
                }}
              >
                {c.part.partNumber}
              </Link>
              <span className="tabular-nums text-ink-faint">{c.score.toFixed(2)}</span>
              {dead ? (
                <span
                  className="text-[9.5px] tracking-[0.1em]"
                  style={{ color: "var(--color-halt)" }}
                >
                  KILLED
                </span>
              ) : isActive ? (
                <span
                  className="text-[9.5px] tracking-[0.1em]"
                  style={{ color: "var(--color-sick)" }}
                >
                  {promoted ? "PROMOTED" : "PROPOSED"}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

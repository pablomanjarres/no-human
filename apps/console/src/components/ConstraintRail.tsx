"use client";

import { railGeometry } from "@/lib/engine";
import type { Citation, EvalStatus, Evaluation } from "@/lib/types";
import { CiteLink, CriticalityMark, STATUS_ACCENT, StatusTag } from "./primitives";

/**
 * What the rail means, in words. The drawn axis is not the constraint — its ends
 * are just the scale the values are plotted on — so a screen reader gets the
 * evaluation's own strings (which carry their units) and the verdict, never the
 * geometry.
 */
const RAIL_OUTCOME: Record<EvalStatus, string> = {
  pass: "Satisfies the constraint",
  loss: "Satisfies the hard constraints, reported as a quantified loss",
  fail: "Fails the constraint",
  info: "Reported, not scored",
};

/**
 * The signature element.
 *
 * Every spec is drawn as a number line. The bracket is the window the constraint
 * solver requires; the solid tick is the SICK candidate; the hollow diamond is the
 * part being replaced. You can read "does this satisfy the constraint" without
 * reading a single number — which is the whole technical claim of the product
 * rendered as a widget rather than asserted in a sentence.
 */
export function Rail({ evaluation }: { evaluation: Evaluation }) {
  const { rail, status } = evaluation;
  if (!rail) return null;
  const g = railGeometry(rail);
  const accent = STATUS_ACCENT[status];

  const spoken = [
    `${evaluation.label}: candidate ${evaluation.candidateValue}`,
    `replacing ${evaluation.sourceValue}`,
    ...(evaluation.delta ? [`difference ${evaluation.delta}`] : []),
  ].join(", ");

  return (
    <div
      className="rail"
      style={{ "--rail-accent": accent } as React.CSSProperties}
      role="img"
      aria-label={`${spoken}. ${RAIL_OUTCOME[status]}.`}
    >
      <span className="rail-grat" />
      <span className="rail-track" />
      <span
        className="rail-band"
        style={{ "--band-start": g.bandStart, "--band-width": g.bandWidth } as React.CSSProperties}
      />
      <span className="rail-ghost" style={{ "--tick": g.source } as React.CSSProperties} />
      <span className="rail-tick" style={{ "--tick": g.candidate } as React.CSSProperties} />
    </div>
  );
}

export function SpecDelta({
  evaluation,
  onCite,
}: {
  evaluation: Evaluation;
  onCite?: (c: Citation) => void;
}) {
  const accent = STATUS_ACCENT[evaluation.status];
  const failing = evaluation.status === "fail";

  return (
    <li
      className="border-b border-cab-700 px-3.5 py-2.5 last:border-b-0"
      style={failing ? { background: "var(--color-halt-wash)" } : undefined}
    >
      <div className="flex items-baseline gap-2">
        <CriticalityMark criticality={evaluation.criticality} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-dim">
          {evaluation.label}
        </span>
        <span className="font-mono text-[12px] tabular-nums" style={{ color: accent }}>
          {evaluation.candidateValue}
        </span>
        {evaluation.delta ? (
          <span className="font-mono text-[10.5px] tabular-nums text-ink-faint">
            {evaluation.delta}
          </span>
        ) : null}
        <StatusTag status={evaluation.status} />
        <CiteLink citation={evaluation.citation} {...(onCite ? { onOpen: onCite } : {})} />
      </div>

      {evaluation.rail ? (
        <div className="mt-1.5 flex items-center gap-2.5">
          <Rail evaluation={evaluation} />
        </div>
      ) : null}

      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-[10px] text-ink-faint">
          replacing {evaluation.sourceValue}
        </span>
      </div>

      {evaluation.note ? (
        <p
          className="mt-1.5 border-l pl-2 text-[11.5px] leading-[1.5] text-ink-dim"
          style={{ borderColor: accent }}
        >
          {evaluation.note}
        </p>
      ) : null}
    </li>
  );
}

/** Legend. Without it the rail is decoration; with it, it is a diagram. */
export function RailLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-cab-700 px-3.5 py-2 font-mono text-[9.5px] text-ink-faint">
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-[7px] w-6 border-x"
          style={{
            borderColor: "color-mix(in oklab, var(--color-sick) 65%, transparent)",
            background: "color-mix(in oklab, var(--color-sick) 16%, transparent)",
          }}
        />
        required window
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-[3px]" style={{ background: "var(--color-sick)" }} />
        SICK candidate
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-[7px] w-[7px] rotate-45 border"
          style={{ borderColor: "var(--color-ink-faint)" }}
        />
        part being replaced
      </span>
      <span className="ml-auto flex items-center gap-2.5">
        <span title="Hard — a miss is a refusal">■ hard</span>
        <span title="Soft — a miss is a quantified loss">▪ soft</span>
      </span>
    </div>
  );
}

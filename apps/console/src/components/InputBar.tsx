"use client";

import { useState } from "react";
import type { Constraint, InputMode } from "@/lib/types";

const MODES: { id: InputMode; label: string; placeholder: string; hint: string }[] = [
  {
    id: "part",
    label: "Part number",
    placeholder: "QS18VN6LV",
    hint: "Banner, Keyence, Pepperl+Fuchs, Balluff",
  },
  {
    id: "describe",
    label: "Describe",
    placeholder: "rectangular, PNP, sees a box at 40 cm",
    hint: "Plain language. Spanish or English.",
  },
  {
    id: "photo",
    label: "Photo",
    placeholder: "Drop a photo of the nameplate",
    hint: "Worn label, 7-digit order number",
  },
  {
    id: "bom",
    label: "BOM",
    placeholder: "Drop a CSV",
    hint: "Audited row by row",
  },
];

/**
 * Two scripted competitor solves, then a real one.
 *
 * `WTB9-3P2211S14` is a live lookup into the 796-SKU catalogue and `1052171` is
 * the same part by order number — both are here so it is obvious from the bar
 * that the field takes any part we hold, not just the two demo strings.
 */
const SAMPLES = ["QS18VN6LV", "ML100-8-1000-RT/95/103", "WTB9-3P2211S14", "1052171"];

export function InputBar({
  mode,
  onModeChange,
  onSolve,
  busy,
}: {
  mode: InputMode;
  onModeChange: (m: InputMode) => void;
  onSolve: (mode: InputMode, raw: string) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState("");
  const active = MODES.find((m) => m.id === mode) ?? MODES[0]!;
  const isDrop = mode === "photo" || mode === "bom";

  return (
    <div className="shrink-0 border-b border-rail bg-cab-850">
      <form
        className="flex flex-wrap items-stretch gap-0"
        onSubmit={(e) => {
          e.preventDefault();
          if (isDrop) {
            // The sample stands in for a decoded nameplate or a BOM line. It
            // resolves to a real part number so the rest of the run is genuine.
            onSolve("part", mode === "photo" ? "QS18VN6LV" : "ML100-8-1000-RT/95/103");
            return;
          }
          if (!value.trim()) return;
          onSolve(mode, value);
        }}
      >
        <div
          className="flex shrink-0 items-stretch border-r border-rail"
          role="tablist"
          aria-label="Input mode"
        >
          {MODES.map((m) => {
            const on = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => {
                  onModeChange(m.id);
                  setValue("");
                }}
                // Lit key, not dark chip: the active tab is the white one, capped
                // with a 2px blue rail. The bar itself sits on cab-850.
                className={`border-r border-cab-700 px-3 py-2.5 font-mono text-[9.5px] uppercase tracking-[0.12em] transition-colors last:border-r-0 ${
                  on
                    ? "bg-cab-900 font-semibold text-sick shadow-[inset_0_2px_0_0_var(--color-sick)]"
                    : "text-ink-faint hover:bg-cab-800 hover:text-ink-dim"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>

        {/* min-w keeps the field from being crushed into a 70px slot when the row
            wraps on a phone: below the wrap point it takes its own line. */}
        <label className="flex min-w-[12rem] flex-1 items-center gap-2.5 px-3.5 py-2 sm:py-0">
          <span className="sr-only">{active.label}</span>
          {isDrop ? (
            // File input is not wired in this build. Saying so is cheaper than a
            // tab that looks live, submits nothing, and answers "(empty)".
            <span className="flex-1 truncate text-[12.5px] text-ink-faint">
              File upload is not wired in this build.{" "}
              <span className="text-ink-dim">
                {mode === "photo"
                  ? "Run the sample nameplate to see the OCR path end to end."
                  : "Run the sample BOM row to see an audited line."}
              </span>
            </span>
          ) : (
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={active.placeholder}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-mono text-[15px] text-ink placeholder:text-ink-faint focus:outline-none"
            />
          )}
          <span className="hidden shrink-0 font-mono text-[9.5px] text-ink-faint md:block">
            {active.hint}
          </span>
        </label>

        <button
          type="submit"
          disabled={busy || (!isDrop && !value.trim())}
          // Solid, not a wash. This is the only action on the bar, and on a white
          // ground a tinted button reads as already disabled.
          className="shrink-0 bg-sick px-6 py-2.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-white transition-colors enabled:hover:bg-sick-deep disabled:bg-cab-600 disabled:text-ink-faint sm:py-0"
        >
          {busy ? "Solving…" : isDrop ? "Run sample →" : "Solve →"}
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-cab-700 px-3.5 py-1.5">
        <span className="eyebrow">Try</span>
        {SAMPLES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              onModeChange("part");
              setValue(s);
              onSolve("part", s);
            }}
            className="font-mono text-[10.5px] text-ink-dim underline decoration-rail decoration-dotted underline-offset-2 transition-colors hover:text-sick hover:decoration-sick"
          >
            {s}
          </button>
        ))}
        <span className="text-ink-faint" aria-hidden>
          ·
        </span>
        <button
          type="button"
          onClick={() =>
            onSolve("describe", "Necesito detectar cajas negras sobre una banda transportadora")
          }
          className="font-mono text-[10.5px] text-ink-dim underline decoration-cab-600 decoration-dotted underline-offset-2 transition-colors hover:text-sick hover:decoration-sick"
        >
          a description in Spanish
        </button>
      </div>
    </div>
  );
}

/**
 * `accent` paints the chip border and its wash; `ink` carries the label. They are
 * separate because the structural greys are borders, not text — rail-bright as a
 * label on white is ~2.6:1.
 */
const ORIGIN_STYLE: Record<
  Constraint["origin"],
  { accent: string; ink: string; mark: string; title: string }
> = {
  extracted: {
    accent: "var(--color-sick)",
    ink: "var(--color-sick)",
    mark: "",
    title: "Read directly from the source datasheet",
  },
  asked: {
    accent: "var(--color-sick)",
    ink: "var(--color-sick)",
    mark: "answered",
    title: "Answered by the operator, not assumed",
  },
  assumed: {
    accent: "var(--color-signal)",
    ink: "var(--color-signal)",
    mark: "assumed",
    title: "ASSUMED by the resolver. Confirm before ordering.",
  },
  default: {
    accent: "var(--color-rail-bright)",
    ink: "var(--color-ink-dim)",
    mark: "default",
    title: "From the application default profile",
  },
};

/**
 * The hinge of the whole interface: unstructured input on the left of the screen
 * becoming a constraint set the solver can actually run. Assumed constraints are
 * marked in yellow because an unmarked assumption is how you ship the wrong part.
 */
export function ConstraintStrip({ constraints }: { constraints: Constraint[] }) {
  const hard = constraints.filter((c) => c.criticality === "hard").length;
  const soft = constraints.length - hard;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-rail bg-cab-900 px-3.5 py-2">
      <span
        className="eyebrow shrink-0"
        title="Emitted by the resolver agent. The solver runs on these, and only these."
      >
        Constraint set
      </span>
      <span className="shrink-0 font-mono text-[9.5px] text-ink-faint">
        {hard} hard · {soft} soft
      </span>
      <span className="mx-1 h-3 w-px shrink-0 bg-cab-600" aria-hidden />
      {constraints.map((c) => {
        const style = ORIGIN_STYLE[c.origin];
        const unknown = c.display === "unknown";
        const accent = unknown ? "var(--color-signal)" : style.accent;
        const ink = unknown ? "var(--color-signal)" : style.ink;
        return (
          <span
            key={c.key}
            className="chip"
            title={`${c.label} — ${c.rationale}`}
            style={
              {
                "--chip-accent": accent,
                "--chip-ink": ink,
                borderStyle: c.criticality === "hard" ? "solid" : "dashed",
              } as React.CSSProperties
            }
          >
            {c.display}
            {style.mark ? (
              <span className="text-[8.5px] uppercase tracking-[0.1em]">{style.mark}</span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

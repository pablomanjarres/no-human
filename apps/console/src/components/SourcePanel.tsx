"use client";

import type { Citation, Part } from "@/lib/types";
import {
  BrandMark,
  CiteLink,
  Chip,
  ConfidenceMark,
  Housing,
  Panel,
  PanelHead,
} from "./primitives";

export function SourcePanel({
  part,
  onCite,
}: {
  part: Part;
  onCite?: (c: Citation) => void;
}) {
  const disputed = part.specs.filter((s) => s.dispute).length;

  return (
    <Panel>
      <PanelHead
        eyebrow="Source"
        title="the part being replaced"
        right={
          disputed > 0 ? (
            <Chip accent="signal" ink="var(--color-signal)" title="Extractor and verifier disagree on this many rows">
              {disputed} disputed
            </Chip>
          ) : null
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-cab-700 px-3.5 py-3.5">
          <BrandMark brand={part.brand} />
          <h2 className="nameplate mt-1 text-[26px] leading-[1.05] text-ink">{part.partNumber}</h2>
          <p className="eyebrow mt-1.5">{part.family}</p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-dim">{part.principle}</p>

          <div className="mt-3.5">
            <Housing part={part} accent="rail" />
          </div>

          <p className="mt-3.5 text-[12.5px] leading-[1.55] text-ink-dim">{part.blurb}</p>
        </div>

        <div className="px-3.5 pt-2.5 pb-1">
          <span className="eyebrow">Extracted spec vector</span>
        </div>

        <ul>
          {part.specs.map((spec) => (
            <li key={spec.key} className="border-b border-cab-700 px-3.5 py-2 last:border-b-0">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-dim">
                  {spec.label}
                </span>
                <ConfidenceMark confidence={spec.confidence} />
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink">
                  {spec.value}
                </span>
                {spec.unit !== "—" ? (
                  <span className="shrink-0 font-mono text-[10px] text-ink-faint">{spec.unit}</span>
                ) : null}
                <CiteLink citation={spec.citation} {...(onCite ? { onOpen: onCite } : {})} />
              </div>

              {spec.dispute ? (
                <div
                  className="mt-1.5 border-l px-2 py-1.5"
                  style={{
                    borderColor: "var(--color-signal)",
                    background: "var(--color-signal-wash)",
                  }}
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[10px]">
                    <span className="text-ink-faint">
                      extractor <span className="text-ink-dim">{spec.dispute.extracted}</span>
                    </span>
                    <span className="text-ink-faint">
                      verifier{" "}
                      <span style={{ color: "var(--color-signal)" }}>{spec.dispute.verified}</span>
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-[1.5] text-ink-dim">{spec.dispute.note}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

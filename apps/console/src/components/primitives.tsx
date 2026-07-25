import type { Citation, Confidence, Criticality, EvalStatus, Part } from "@/lib/types";

/** Accent tokens. Blue passes, yellow cautions, vermilion halts. No green anywhere. */
export const ACCENT: Record<string, string> = {
  sick: "var(--color-sick)",
  signal: "var(--color-signal)",
  halt: "var(--color-halt)",
  rail: "var(--color-rail-bright)",
};

export const STATUS_ACCENT: Record<EvalStatus, string> = {
  pass: ACCENT.sick!,
  loss: ACCENT.signal!,
  fail: ACCENT.halt!,
  info: ACCENT.rail!,
};

export const STATUS_LABEL: Record<EvalStatus, string> = {
  pass: "PASS",
  loss: "LOSS",
  fail: "FAIL",
  info: "INFO",
};

export function Panel({
  children,
  className = "",
  ...rest
}: React.ComponentProps<"section"> & { className?: string }) {
  return (
    <section className={`panel flex min-h-0 flex-col ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function PanelHead({
  eyebrow,
  title,
  right,
}: {
  eyebrow: string;
  title?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="panel-head shrink-0">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <span className="eyebrow shrink-0">{eyebrow}</span>
        {title ? (
          <span className="truncate font-mono text-[11px] text-ink-dim">{title}</span>
        ) : null}
      </div>
      {right}
    </header>
  );
}

export function Chip({
  children,
  accent = "rail",
  ink,
  title,
}: {
  children: React.ReactNode;
  accent?: keyof typeof ACCENT | undefined;
  ink?: string | undefined;
  title?: string | undefined;
}) {
  return (
    <span
      className="chip"
      title={title}
      style={
        {
          "--chip-accent": ACCENT[accent],
          ...(ink ? { "--chip-ink": ink } : {}),
        } as React.CSSProperties
      }
    >
      {children}
    </span>
  );
}

export function StatusTag({ status }: { status: EvalStatus }) {
  return (
    <span
      className="font-mono text-[10px] font-semibold tracking-[0.12em]"
      style={{ color: STATUS_ACCENT[status] }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

const CRIT_COPY: Record<Criticality, string> = {
  hard: "Hard — a miss is a refusal, not a downgrade",
  soft: "Soft — a miss is reported as a quantified loss",
  informational: "Informational — reported, never scored",
};

export function CriticalityMark({ criticality }: { criticality: Criticality }) {
  const glyph = criticality === "hard" ? "■" : criticality === "soft" ? "▪" : "·";
  return (
    <span
      className="select-none font-mono text-[9px] leading-none"
      title={CRIT_COPY[criticality]}
      style={{
        color: criticality === "hard" ? "var(--color-ink-dim)" : "var(--color-ink-faint)",
      }}
    >
      {glyph}
    </span>
  );
}

const CONFIDENCE_ACCENT: Record<Confidence, string> = {
  high: "var(--color-ink-faint)",
  medium: "var(--color-signal)",
  low: "var(--color-halt)",
};

export function ConfidenceMark({ confidence }: { confidence: Confidence }) {
  if (confidence === "high") return null;
  return (
    <span
      className="font-mono text-[9px] uppercase tracking-[0.1em]"
      style={{ color: CONFIDENCE_ACCENT[confidence] }}
      title={`Extraction confidence: ${confidence}`}
    >
      {confidence}
    </span>
  );
}

/** Clickable grounding. Every value on screen carries one of these. */
export function CiteLink({ citation, onOpen }: { citation: Citation; onOpen?: (c: Citation) => void }) {
  return (
    <button
      type="button"
      onClick={onOpen ? () => onOpen(citation) : undefined}
      className="group inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-ink-faint transition-colors hover:text-sick focus-visible:text-sick"
      title={citation.snippet ? `“${citation.snippet}” — ${citation.docTitle}, p.${citation.page}` : citation.docTitle}
    >
      <span className="underline decoration-cab-600 decoration-dotted underline-offset-2 group-hover:decoration-sick">
        p.{citation.page}
      </span>
      <span aria-hidden>↗</span>
    </button>
  );
}

/**
 * There are no product photographs in this build, and a stock image would be a
 * lie about what the corpus contains. The sensor is drawn from its own
 * dimensional drawing instead — a side elevation at a fixed 2.4 px/mm, so the
 * two columns are directly comparable. Pass `ghost` to overlay the outline of
 * the part being replaced: the 3 mm the replacement costs you becomes visible
 * rather than a number in a table.
 */
const MM = 2.4;
const PAD_X = 10;
const PAD_Y = 9;
const VB_W = 176;
const VB_H = 106;

export function Housing({
  part,
  accent = "rail",
  ghost,
  maxWidth = VB_W,
}: {
  part: Part;
  accent?: keyof typeof ACCENT | undefined;
  ghost?: Part | undefined;
  maxWidth?: number | undefined;
}) {
  const color = ACCENT[accent] ?? ACCENT.rail!;
  const bw = part.dims.l * MM;
  const bh = part.dims.h * MM;
  const r = part.form === "cyl" ? bh / 2 : 2;

  const gw = ghost ? ghost.dims.l * MM : 0;
  const gh = ghost ? ghost.dims.h * MM : 0;

  const dimY = PAD_Y + Math.max(bh, gh) + 15;
  const dimX = PAD_X + Math.max(bw, gw) + 15;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      width="100%"
      style={{ maxWidth }}
      role="img"
      aria-label={`${part.partNumber} side elevation, ${part.dims.l} by ${part.dims.w} by ${part.dims.h} millimetres`}
    >
      {/* the part being replaced, for scale */}
      {ghost ? (
        <rect
          x={PAD_X}
          y={PAD_Y + (bh - gh) / 2}
          width={gw}
          height={gh}
          rx={ghost.form === "cyl" ? gh / 2 : 2}
          fill="none"
          stroke="var(--color-ink-faint)"
          strokeWidth={1}
          strokeDasharray="2 2"
          opacity={0.75}
        />
      ) : null}

      {/* housing */}
      <rect
        x={PAD_X}
        y={PAD_Y}
        width={bw}
        height={bh}
        rx={r}
        fill="var(--color-cab-700)"
        stroke="var(--color-rail-bright)"
        strokeWidth={1}
      />
      {/* machined face texture */}
      {Array.from({ length: Math.floor(bw / 6) }, (_, i) => (
        <line
          key={i}
          x1={PAD_X + 3 + i * 6}
          y1={PAD_Y + 1}
          x2={PAD_X + 3 + i * 6}
          y2={PAD_Y + bh - 1}
          stroke="var(--color-ink)"
          strokeWidth={0.5}
          opacity={0.04}
        />
      ))}
      {/* optical face */}
      <rect
        x={PAD_X + bw - 6}
        y={PAD_Y + bh / 2 - Math.max(bh * 0.22, 5)}
        width={4}
        height={Math.max(bh * 0.44, 10)}
        rx={1}
        fill={color}
        opacity={0.9}
      />
      {/* status LED */}
      <circle cx={PAD_X + 6} cy={PAD_Y + 5} r={1.8} fill={color} />
      {/* M12 connector stub */}
      <rect
        x={PAD_X - 5}
        y={PAD_Y + bh / 2 - 4}
        width={5}
        height={8}
        fill="var(--color-cab-600)"
        stroke="var(--color-rail)"
        strokeWidth={0.75}
      />

      {/* length dimension */}
      <g stroke="var(--color-ink-faint)" strokeWidth={0.75}>
        <line x1={PAD_X} y1={dimY} x2={PAD_X + bw} y2={dimY} />
        <line x1={PAD_X} y1={dimY - 3} x2={PAD_X} y2={dimY + 3} />
        <line x1={PAD_X + bw} y1={dimY - 3} x2={PAD_X + bw} y2={dimY + 3} />
      </g>
      <text
        x={PAD_X + bw / 2}
        y={dimY + 12}
        textAnchor="middle"
        fill="var(--color-ink-dim)"
        style={{ font: "500 9px var(--font-mono)" }}
      >
        {part.dims.l} mm
      </text>

      {/* height dimension */}
      <g stroke="var(--color-ink-faint)" strokeWidth={0.75}>
        <line x1={dimX} y1={PAD_Y} x2={dimX} y2={PAD_Y + bh} />
        <line x1={dimX - 3} y1={PAD_Y} x2={dimX + 3} y2={PAD_Y} />
        <line x1={dimX - 3} y1={PAD_Y + bh} x2={dimX + 3} y2={PAD_Y + bh} />
      </g>
      <text
        x={dimX + 6}
        y={PAD_Y + bh / 2 + 3}
        fill="var(--color-ink-dim)"
        style={{ font: "500 9px var(--font-mono)" }}
      >
        {part.dims.h}
      </text>

      <text
        x={dimX + 6}
        y={PAD_Y + 8}
        fill="var(--color-ink-faint)"
        style={{ font: "500 8px var(--font-mono)" }}
      >
        W {part.dims.w}
      </text>

      {ghost ? (
        <text
          x={PAD_X}
          y={VB_H - 4}
          fill="var(--color-ink-faint)"
          style={{ font: "500 8px var(--font-mono)" }}
        >
          dashed: {ghost.partNumber} · same scale
        </text>
      ) : null}
    </svg>
  );
}

export function BrandMark({ brand }: { brand: string }) {
  const isSick = brand.toLowerCase() === "sick";
  return (
    <span
      className="nameplate text-[11px] leading-none"
      style={{
        color: isSick ? "var(--color-sick)" : "var(--color-ink-dim)",
        letterSpacing: "0.06em",
      }}
    >
      {brand}
    </span>
  );
}

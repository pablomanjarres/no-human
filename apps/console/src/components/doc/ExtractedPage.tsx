import Link from "next/link";
import { Panel, PanelHead } from "@/components/primitives";
import { PaperScroll } from "@/components/doc/PaperScroll";
import {
  type CitedLine,
  type DocRecord,
  type PageLine,
  docHref,
  linesFor,
  retainedPages,
} from "@/components/doc/corpus";

/**
 * The extracted page.
 *
 * The argument used to be carried by contrast: a warm paper column inside dark
 * cabinet chrome, light because it came from somewhere else. The console is
 * light everywhere now, so that reading is gone and the separation is built a
 * different way — the sheet is true paper white with a crisp border and a
 * contact shadow, dropped into the cool grey well of the scroll region. It sits
 * on the chrome rather than being part of it.
 *
 * It is not a render of the PDF and does not pretend to be. It is the text
 * layer — the extractor's line output for one page, order preserved, table
 * cells flattened one per line. Faking a scan here would undermine the only
 * thing this product sells, which is that the grounding can be checked. The
 * sheet is deliberately plainer than the real datasheet page: no logos, no
 * columns, a line number down the margin of every line the extractor emitted.
 */

/** A sheet on a grey table: crisp edge, contact shadow, no gradient, no texture. */
const SHEET_SHADOW =
  "0 1px 2px color-mix(in oklab, var(--color-ink) 8%, transparent)," +
  " 0 12px 28px -18px color-mix(in oklab, var(--color-ink) 40%, transparent)";

/**
 * Exactly one line on the page is lit: the one that was clicked. It gets what a
 * highlighter actually leaves — safety yellow over the words, a wash across the
 * row, a bright edge out in the margin. Ink stays black on top of the fill
 * (~8:1), which is why the metaphor finally works literally now that the page
 * behind it is white.
 *
 * The other quoted lines are marked, not lit. A page where everything is
 * highlighted highlights nothing.
 */
const HIT_STROKE = "var(--color-signal-bright)";
const HIT_ROW = "var(--color-signal-wash)";
const QUOTED_EDGE = "color-mix(in oklab, var(--color-signal-bright) 55%, var(--color-cab-600))";
const QUOTED_RULE = "var(--color-signal-deep)";

export function ExtractedPage({
  doc,
  page,
  cited,
  activeLine,
}: {
  doc: DocRecord;
  page: number;
  /** Cited lines on this page, in the order the text layer prints them. */
  cited: CitedLine[];
  /** 1-based index into `cited`. 0 when the page grounds nothing. */
  activeLine: number;
}) {
  const lines = linesFor(doc.docId, page);
  const retained = retainedPages(doc.docId);
  const focused = activeLine > 0 ? cited[activeLine - 1] : undefined;

  // Stepping works from an unretained page too — otherwise a reader who lands on
  // page 5 of 8 is stranded with no way back into the document.
  const at = retained.indexOf(page);
  const prev = [...retained].reverse().find((p) => p < page);
  const next = retained.find((p) => p > page);

  const citedText = new Set(cited.map((c) => c.snippet));

  // Notes are the extractor talking, not the page. They do not take a line number.
  const numbered: { line: PageLine; index: number | null }[] = [];
  let counter = 0;
  for (const line of lines) {
    if (line.kind === "note") {
      numbered.push({ line, index: null });
      continue;
    }
    counter += 1;
    numbered.push({ line, index: counter });
  }

  return (
    <Panel className="min-w-0 min-[900px]:flex-1">
      <PanelHead
        eyebrow="EXTRACTED TEXT LAYER"
        title={`${doc.docId} · page ${page} of ${doc.pages}`}
        right={
          <nav
            className="flex shrink-0 items-center gap-1"
            aria-label="Cited pages of this document"
          >
            <PageStep docId={doc.docId} target={prev} glyph="←" label="Previous cited page" />
            <span
              className="px-1 font-mono text-[10px] text-ink-faint"
              title={
                at >= 0
                  ? `Cited page ${at + 1} of ${retained.length}`
                  : `Page ${page} is not one of the ${retained.length} cited pages`
              }
            >
              {at >= 0 ? at + 1 : "—"}/{retained.length}
            </span>
            <PageStep docId={doc.docId} target={next} glyph="→" label="Next cited page" />
          </nav>
        }
      />

      {/* What is being shown, said plainly, before anyone has to guess. The band
          is recessed rather than white so the disclosure reads as the instrument
          talking and not as the first line of the document. */}
      <div className="shrink-0 border-b border-cab-700 bg-cab-800 px-3.5 py-2.5">
        <p className="max-w-[80ch] text-[12.5px] leading-[1.5] text-ink-dim">
          {lines.length === 0 ? (
            <>
              Page {page} kept no text layer. Nothing was read from it, so nothing was stored —{" "}
              <strong className="font-semibold text-ink">this is not a render of the PDF</strong>{" "}
              and there is no page image to fall back on.
            </>
          ) : (
            <>
              The extractor&rsquo;s line output for page {page}. Reading order preserved, table
              cells flattened one per line.{" "}
              <strong className="font-semibold text-ink">This is not a render of the PDF.</strong>{" "}
              {cited.length === 1
                ? "One line on this page is quoted in the workspace and is highlighted."
                : `${cited.length} lines on this page are quoted in the workspace; the one you clicked is highlighted.`}
            </>
          )}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="eyebrow">SOURCE FILE</span>
          <code className="font-mono text-[11px] break-all text-ink-dim">{doc.file}</code>
          <span
            className="font-mono text-[10px] text-ink-faint"
            title="The cached PDF is not served from this application. The text layer is the whole of what the extraction pass kept."
          >
            · not served · {doc.revision}
          </span>
        </div>
      </div>

      <PaperScroll
        focusKey={`${doc.docId}:${page}:${activeLine}`}
        label={`Extracted text layer, page ${page} of ${doc.pages}`}
        className="max-h-[68svh] bg-cab-950 min-[900px]:max-h-none min-[900px]:flex-1"
      >
        <div className="px-4 py-5 sm:px-6 sm:py-7">
          <article
            aria-label={`${doc.title}, extracted text layer, page ${page} of ${doc.pages}`}
            className="mx-auto w-full max-w-[660px] rounded-[2px] border border-cab-600 bg-cab-900 px-5 py-6 text-ink sm:px-8 sm:py-8"
            style={{ boxShadow: SHEET_SHADOW }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-cab-700 pb-2">
              <span className="font-mono text-[10px] tracking-[0.12em] text-ink-dim uppercase">
                {doc.brand} · {doc.title}
              </span>
              <span className="font-mono text-[10px] tracking-[0.08em] text-ink-dim">
                PAGE {page} / {doc.pages}
              </span>
            </div>

            {lines.length === 0 ? (
              <div className="py-6">
                <p className="text-[13px] leading-[1.6] text-ink">
                  No text layer retained for page {page}.
                </p>
                <p className="mt-2 max-w-[58ch] text-[13px] leading-[1.6] text-ink-dim">
                  The extraction pass keeps the pages a value was read from and discards the rest.
                  There is nothing to show here, and nothing worth inventing.
                </p>
                {retained.length > 0 ? (
                  <p className="mt-3 font-mono text-[11px] text-ink-dim">
                    Retained: {retained.map((p) => `p.${p}`).join(" · ")}
                  </p>
                ) : null}
              </div>
            ) : (
              <ol className="mt-4 space-y-[3px]">
                {numbered.map(({ line, index }, i) => (
                  <TextLine
                    key={`${i}-${line.text}`}
                    line={line}
                    index={index}
                    quoted={line.kind === "body" && citedText.has(line.text)}
                    hit={
                      focused !== undefined && line.kind === "body" && line.text === focused.snippet
                    }
                  />
                ))}
              </ol>
            )}

            <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-cab-700 pt-2">
              <span className="font-mono text-[10px] text-ink-faint">
                {lines.length} extracted lines
              </span>
              <span className="font-mono text-[10px] text-ink-faint">
                {doc.docId} · p.{page}
              </span>
            </div>
          </article>
        </div>
      </PaperScroll>
    </Panel>
  );
}

function TextLine({
  line,
  index,
  quoted,
  hit,
}: {
  line: PageLine;
  /** Null for extractor notes, which are not lines of the page. */
  index: number | null;
  quoted: boolean;
  hit: boolean;
}) {
  return (
    <li
      data-hit={hit ? "true" : undefined}
      // The negative margins let the highlighted row bleed into both margins of
      // the sheet without moving a single character of the text column.
      className="-mx-3 flex scroll-my-16 gap-3 px-3"
      style={{
        borderLeft: "3px solid",
        borderLeftColor: hit ? HIT_STROKE : quoted ? QUOTED_EDGE : "transparent",
        background: hit ? HIT_ROW : undefined,
      }}
    >
      <span
        className={`w-[18px] shrink-0 select-none pt-[3px] text-right font-mono text-[9px] leading-none ${
          hit ? "text-ink-dim" : "text-ink-faint"
        }`}
        aria-hidden
      >
        {index === null ? "" : String(index).padStart(2, "0")}
      </span>

      <div className="min-w-0 flex-1">
        {line.kind === "head" ? (
          <h2
            className="nameplate pt-2 text-[11px] leading-[1.4] text-ink"
            style={{ letterSpacing: "0.05em" }}
          >
            {line.text}
          </h2>
        ) : line.kind === "note" ? (
          // An extractor note is us, not the page. It gets the blue rail the rest
          // of the console uses for machine output, so it can never be read back
          // as a line of the document.
          <div className="my-1 border-l-2 border-sick-bright pl-2.5">
            <span className="block font-mono text-[9px] tracking-[0.16em] text-sick uppercase">
              ▪ Extractor note — not page text
            </span>
            <span className="block text-[12px] leading-[1.5] text-ink-dim">{line.text}</span>
          </div>
        ) : quoted ? (
          <p className="font-mono text-[12.5px] leading-[1.55]">
            {hit ? <span className="sr-only">Quoted line: </span> : null}
            <mark
              title={hit ? "The line the value was read from" : "Quoted elsewhere in the workspace"}
              style={{
                background: hit ? HIT_STROKE : "transparent",
                color: "var(--color-ink)",
                padding: hit ? "1px 4px" : "1px 0",
                borderRadius: hit ? 2 : 0,
                borderBottom: hit ? "none" : `1px dashed ${QUOTED_RULE}`,
                boxDecorationBreak: "clone",
                WebkitBoxDecorationBreak: "clone",
              }}
            >
              {line.text}
            </mark>
          </p>
        ) : (
          <p className="font-mono text-[12.5px] leading-[1.55] text-ink">{line.text}</p>
        )}
      </div>
    </li>
  );
}

function PageStep({
  docId,
  target,
  glyph,
  label,
}: {
  docId: string;
  target: number | undefined;
  glyph: string;
  label: string;
}) {
  const shell =
    "flex h-[22px] w-[22px] items-center justify-center rounded-[2px] border font-mono text-[11px] leading-none transition-colors";

  if (target === undefined) {
    return (
      <button
        type="button"
        disabled
        aria-label={`${label} — none`}
        // Muted with a token rather than an opacity trick: on a light head, a
        // half-transparent glyph goes from "disabled" to "smudge".
        className={`${shell} cursor-not-allowed border-cab-700 bg-cab-850 text-rail-bright`}
      >
        <span aria-hidden>{glyph}</span>
      </button>
    );
  }

  return (
    <Link
      href={docHref(docId, target)}
      aria-label={`${label} — page ${target}`}
      className={`${shell} border-cab-600 bg-cab-900 text-ink-dim hover:border-sick hover:text-sick`}
    >
      <span aria-hidden>{glyph}</span>
    </Link>
  );
}

import { Chip, Panel, PanelHead, StatusTag } from "@/components/primitives";
import { CiteJump } from "@/components/doc/CiteJump";
import {
  AGENT_TAG,
  type CitedLine,
  type DocRecord,
  docHref,
  runLabel,
} from "@/components/doc/corpus";
import type { Citation } from "@/lib/types";

/** The selected quote carries the same highlighter as the line on the sheet. */
const ACTIVE_ROW = "var(--color-signal-wash)";
const ACTIVE_EDGE = "var(--color-signal-bright)";

/**
 * The return leg.
 *
 * The sidebar answers "what does this document ground". This answers the harder
 * question for the page in front of you: for each quoted line, which agent read
 * it, and what did the workspace do with it. A judge can walk the claim back to
 * the line and the line forward to the claim without leaving the screen.
 */
export function QuotedBy({
  doc,
  page,
  cited,
  activeLine,
}: {
  doc: DocRecord;
  page: number;
  cited: CitedLine[];
  activeLine: number;
}) {
  const uses = cited.reduce((n, line) => n + line.uses.length, 0);

  return (
    <Panel className="min-h-0 min-w-0 min-[900px]:flex-[2]">
      <PanelHead eyebrow="QUOTED BY" title={`p.${page} · ${uses} ${uses === 1 ? "use" : "uses"}`} />

      <div className="max-h-[46svh] min-h-0 overflow-y-auto min-[900px]:max-h-none min-[900px]:flex-1">
        {cited.length === 0 ? (
          <p className="px-3 py-3 text-[12.5px] leading-[1.5] text-ink-dim">
            No value was read from page {page}. Nothing on screen depends on it.
          </p>
        ) : (
          cited.map((line, i) => {
            const active = activeLine === i + 1;
            const citation: Citation = {
              docId: doc.docId,
              docTitle: doc.title,
              brand: doc.brand,
              page,
              href: docHref(doc.docId, page),
              ...(line.snippet ? { snippet: line.snippet } : {}),
            };

            return (
              <section key={`${page}-${line.snippet}`}>
                <header
                  className="flex items-center gap-2 border-y border-cab-700 bg-cab-800 py-1.5 pr-2.5 pl-3"
                  style={{
                    borderLeft: "2px solid",
                    borderLeftColor: active ? ACTIVE_EDGE : "transparent",
                    background: active ? ACTIVE_ROW : undefined,
                  }}
                >
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px] leading-[1.5]"
                    style={{ color: active ? "var(--color-ink)" : "var(--color-ink-dim)" }}
                    title={line.snippet}
                  >
                    &ldquo;{line.snippet}&rdquo;
                  </span>
                  <CiteJump citation={citation} href={docHref(doc.docId, page, i + 1)} />
                </header>

                <ul>
                  {line.uses.map((use) => {
                    const tag = AGENT_TAG[use.agent];
                    return (
                      <li
                        key={`${use.agent}-${use.what}`}
                        className="flex items-start gap-2 border-b border-cab-700 px-3 py-2"
                      >
                        <span className="shrink-0 pt-[1px]">
                          <Chip accent={tag.accent} title={tag.label}>
                            {tag.short}
                          </Chip>
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] leading-[1.45] text-ink-dim">{use.what}</p>
                          <p className="eyebrow mt-1 truncate">
                            {use.inRuns.map(runLabel).join(" · ")}
                          </p>
                        </div>
                        {use.status ? (
                          <span className="shrink-0 pt-[3px]">
                            <StatusTag status={use.status} />
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </Panel>
  );
}

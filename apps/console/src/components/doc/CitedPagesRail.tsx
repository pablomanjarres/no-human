import Link from "next/link";
import { ACCENT, Panel, PanelHead } from "@/components/primitives";
import { AGENT_TAG, type CitedPageGroup, docHref } from "@/components/doc/corpus";
import type { AgentName } from "@/lib/types";

/**
 * Every line of this document that something on screen quotes, grouped by page.
 *
 * Built by walking the runs, not by hand. If a value stops being cited, it stops
 * appearing here — the index cannot drift away from what the app actually claims.
 */
export function CitedPagesRail({
  docId,
  groups,
  page,
  activeLine,
}: {
  docId: string;
  groups: CitedPageGroup[];
  page: number;
  activeLine: number;
}) {
  const total = groups.reduce((n, g) => n + g.lines.length, 0);

  return (
    <Panel className="min-h-0 min-w-0 min-[900px]:flex-[3]">
      <PanelHead
        eyebrow="CITED PAGES"
        title={`${total} lines · ${groups.length} pages`}
        right={<span className="eyebrow shrink-0">GROUNDING</span>}
      />

      <div className="max-h-[46svh] min-h-0 overflow-y-auto min-[900px]:max-h-none min-[900px]:flex-1">
        {groups.length === 0 ? (
          <p className="px-3 py-3 text-[12.5px] leading-[1.5] text-ink-dim">
            Nothing in the workspace quotes this document.
          </p>
        ) : (
          groups.map((group) => {
            const onPage = group.page === page;
            return (
              <section key={group.page}>
                <Link
                  href={docHref(docId, group.page)}
                  className="sticky top-0 z-10 flex items-center justify-between gap-2 border-y border-cab-800 bg-cab-850 px-3 py-1.5 transition-colors hover:bg-cab-800"
                >
                  <span
                    className="font-mono text-[11px] font-medium"
                    style={{ color: onPage ? "var(--color-sick)" : "var(--color-ink-dim)" }}
                  >
                    p.{group.page}
                  </span>
                  <span className="eyebrow">
                    {group.lines.length} {group.lines.length === 1 ? "LINE" : "LINES"}
                  </span>
                </Link>

                <ul>
                  {group.lines.map((line, i) => {
                    const active = onPage && activeLine === i + 1;
                    return (
                      <li key={`${group.page}-${line.snippet}`}>
                        <Link
                          href={docHref(docId, group.page, i + 1)}
                          aria-current={active ? "true" : undefined}
                          className="flex items-start gap-2 border-b border-cab-850 py-1.5 pr-2.5 pl-3 transition-colors hover:bg-cab-850"
                          style={{
                            borderLeft: "2px solid",
                            borderLeftColor: active ? "var(--color-signal)" : "transparent",
                            background: active ? "var(--color-cab-800)" : undefined,
                          }}
                        >
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-[11px] leading-[1.5]"
                            style={{ color: active ? "var(--color-ink)" : "var(--color-ink-dim)" }}
                            title={line.snippet}
                          >
                            {line.snippet || "— no snippet recorded —"}
                          </span>
                          <span className="flex shrink-0 gap-1 pt-[2px]">
                            {line.agents.map((agent) => (
                              <AgentTag key={agent} agent={agent} />
                            ))}
                          </span>
                        </Link>
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

/** Which agent put this line on screen. Inferred from where the citation sits. */
function AgentTag({ agent }: { agent: AgentName }) {
  const tag = AGENT_TAG[agent];
  return (
    <span
      className="font-mono text-[9px] leading-none tracking-[0.1em]"
      style={{ color: ACCENT[tag.accent] ?? "var(--color-rail-bright)" }}
      title={tag.label}
    >
      {tag.short}
    </span>
  );
}

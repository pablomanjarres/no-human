import Link from "next/link";
import { BrandMark, Chip, Housing } from "@/components/primitives";
import {
  type CitedPageGroup,
  type DocRecord,
  partForDoc,
  retainedPages,
} from "@/components/doc/corpus";
import { corpusStats } from "@/data/runs";

/**
 * What the document is, before anything is claimed about it.
 *
 * The offline marker is not a badge for its own sake: the corpus is a set of
 * PDFs cached at extraction time, and nothing on this route touches the network
 * when it loads. If a citation resolves, it resolves against a file we already
 * hold.
 */
export function DocHeader({ doc, groups }: { doc: DocRecord; groups: CitedPageGroup[] }) {
  const part = partForDoc(doc);
  const retained = retainedPages(doc.docId);
  const lines = groups.reduce((n, g) => n + g.lines.length, 0);
  const uses = groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.uses.length, 0), 0);

  return (
    <header className="shrink-0 border-b border-rail bg-cab-900">
      {/* Utility strip: recessed grey so the offline marker reads as chrome, and
          so the white title plate below it has an edge to sit against. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-cab-700 bg-cab-850 px-4 py-2">
        <Link
          href="/console"
          className="flex items-center gap-1.5 font-mono text-[11px] text-ink-dim transition-colors hover:text-sick"
        >
          <span aria-hidden>←</span>
          <span>Workspace</span>
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <Chip accent="sick">OFFLINE CORPUS</Chip>
          <span className="font-mono text-[10px] text-ink-faint">
            cached PDF · nothing fetched at request time
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-5 px-4 py-4">
        <div className="min-w-0 max-w-[64ch] flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <BrandMark brand={doc.brand} />
            <span aria-hidden className="font-mono text-[10px] text-ink-faint">
              ·
            </span>
            <span className="font-mono text-[10px] text-ink-faint">{doc.docId}</span>
            <span className="font-mono text-[10px] text-ink-faint">{doc.revision}</span>
          </div>

          <h1 className="nameplate mt-2 text-[19px] leading-[1.15] text-ink">{doc.title}</h1>

          <p className="mt-2.5 text-[13px] leading-[1.55] text-ink-dim">{doc.description}</p>
        </div>

        <div className="flex flex-wrap items-end gap-x-10 gap-y-5">
          <dl className="grid grid-cols-[auto_auto] gap-x-5 gap-y-[3px]">
            <Meta label="PAGES" value={`${doc.pages}`} />
            <Meta label="TEXT LAYER" value={`${retained.length} of ${doc.pages} retained`} />
            <Meta label="CITED LINES" value={`${lines}`} />
            <Meta label="USES ON SCREEN" value={`${uses}`} />
            <Meta label="CORPUS PASS" value={corpusStats.extractedAt} />
          </dl>

          {part ? (
            <div>
              <span className="eyebrow mb-1.5 block">DRAWN TO SCALE — {part.partNumber}</span>
              <Housing part={part} accent={doc.brand.toLowerCase() === "sick" ? "sick" : "rail"} />
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="eyebrow self-center">{label}</dt>
      <dd className="font-mono text-[11px] leading-[1.5] text-ink-dim">{value}</dd>
    </>
  );
}

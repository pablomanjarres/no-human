import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CitedPagesRail } from "@/components/doc/CitedPagesRail";
import { DocHeader } from "@/components/doc/DocHeader";
import { ExtractedPage } from "@/components/doc/ExtractedPage";
import { QuotedBy } from "@/components/doc/QuotedBy";
import { type CitedPageGroup, getDoc, pageGroups } from "@/components/doc/corpus";

/**
 * The citation viewer. Every `CiteLink` in the app lands here.
 *
 * The claim this route has to carry is that grounding is visible, not asserted.
 * A judge clicks "p.2" in the comparison table and arrives on the exact line the
 * value was read from, highlighted, already scrolled under the eye, with the
 * agent that read it and the row it produced named alongside.
 *
 * Route: /console/doc/[docId]?page=N&line=K
 *   page — the page of the source document, 1-based.
 *   line — which quoted line on that page to focus, 1-based. Optional: page 2 of
 *          the W9 data sheet grounds seven separate rows, and a citation should
 *          land on its own line rather than on the page in general.
 */

type SearchParams = Record<string, string | string[] | undefined>;

interface DocPageProps {
  params: Promise<{ docId: string }>;
  searchParams: Promise<SearchParams>;
}

const readParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Out-of-range and missing both resolve to the first page that grounds something. */
function resolvePage(raw: string | undefined, pages: number, groups: CitedPageGroup[]): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isInteger(n) && n >= 1 && n <= pages) return n;
  return groups[0]?.page ?? 1;
}

function resolveLine(raw: string | undefined, count: number): number {
  if (count === 0) return 0;
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n >= 1 && n <= count ? n : 1;
}

export async function generateMetadata({ params, searchParams }: DocPageProps): Promise<Metadata> {
  const { docId } = await params;
  const doc = getDoc(docId);
  if (!doc) return { title: "Not in the offline corpus — SICK Cross" };

  const groups = pageGroups(docId);
  const page = resolvePage(readParam((await searchParams).page), doc.pages, groups);

  return {
    title: `${doc.title} — p.${page} — SICK Cross`,
    description: doc.description,
  };
}

export default async function DocPage({ params, searchParams }: DocPageProps) {
  const { docId } = await params;
  const doc = getDoc(docId);
  // An unknown docId means the citation points outside the corpus we hold. That
  // is a broken claim, not a page to improvise.
  if (!doc) notFound();

  const query = await searchParams;
  const groups = pageGroups(docId);
  const page = resolvePage(readParam(query.page), doc.pages, groups);
  const cited = groups.find((g) => g.page === page)?.lines ?? [];
  const activeLine = resolveLine(readParam(query.line), cited.length);

  return (
    <div className="flex min-h-dvh flex-col min-[900px]:h-dvh min-[900px]:overflow-hidden">
      <DocHeader doc={doc} groups={groups} />

      <main className="grid min-h-0 flex-1 gap-3 p-3 min-[900px]:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
        {/* min-w-0 on both columns: a grid item defaults to min-width:auto, and one
            long unbreakable part number would otherwise widen the whole page. */}
        <aside className="order-2 flex min-h-0 min-w-0 flex-col gap-3 min-[900px]:order-1">
          <CitedPagesRail docId={docId} groups={groups} page={page} activeLine={activeLine} />
          <QuotedBy doc={doc} page={page} cited={cited} activeLine={activeLine} />
        </aside>

        <div className="order-1 flex min-h-0 min-w-0 flex-col min-[900px]:order-2">
          <ExtractedPage doc={doc} page={page} cited={cited} activeLine={activeLine} />
        </div>
      </main>
    </div>
  );
}

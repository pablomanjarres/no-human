import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Accessories } from "@/components/product/Accessories";
import { ProductHero } from "@/components/product/ProductHero";
import { ReplacesPanel } from "@/components/product/ReplacesPanel";
import { SpecTable } from "@/components/product/SpecTable";
import { corpusStats, findPart, sickCatalogue } from "@/data/runs";
import type { Part } from "@/lib/types";

/**
 * The product record.
 *
 * Ordered the way an engineer reads a part: what it is, what it displaces, what
 * it measures, what it needs to be mounted. The "replaces" block sits second on
 * purpose — it is the only section here that no manufacturer's own product page
 * will ever show you, and it is the reason this page exists at all.
 */

interface PageProps {
  params: Promise<{ sku: string }>;
}

export function generateStaticParams(): { sku: string }[] {
  return sickCatalogue.map((p) => ({ sku: p.partNumber }));
}

/** A malformed percent-escape must not throw a 500 — it is just a bad SKU. */
function resolve(raw: string): Part | undefined {
  let sku = raw;
  try {
    sku = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return findPart(sku);
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { sku } = await params;
  const part = resolve(sku);
  if (!part) return { title: "Unknown part — SICK Cross" };
  return {
    title: `${part.partNumber} — ${part.brand} ${part.family}`,
    description: part.blurb,
  };
}

export default async function ProductPage({ params }: PageProps) {
  const { sku } = await params;
  const part = resolve(sku);
  if (!part) notFound();

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8">
      <nav
        aria-label="Breadcrumb"
        className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
      >
        <Link
          href="/console"
          className="eyebrow inline-flex items-center gap-2 transition-colors hover:text-ink focus-visible:text-ink"
        >
          <span aria-hidden>←</span> Workspace
        </Link>
        <span className="eyebrow">
          Product record · {part.brand} · {part.orderNumber ?? part.partNumber}
        </span>
      </nav>

      <div className="flex flex-col gap-4">
        <ProductHero part={part} />
        <ReplacesPanel part={part} />
        <SpecTable part={part} />
        <Accessories part={part} />
      </div>

      <footer className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-rail px-1 pt-4">
        <p className="font-mono text-[10px] leading-[1.6] text-ink-faint">
          Read from the offline corpus · {corpusStats.datasheets} datasheets ·{" "}
          {corpusStats.specRows.toLocaleString("en-US")} spec rows · extracted{" "}
          {corpusStats.extractedAt}
        </p>
        <p className="font-mono text-[10px] text-ink-faint">
          Nothing on this page reaches the network at request time.
        </p>
      </footer>
    </main>
  );
}

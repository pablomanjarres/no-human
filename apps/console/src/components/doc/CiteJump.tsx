"use client";

import { useRouter } from "next/navigation";
import { CiteLink } from "@/components/primitives";
import type { Citation } from "@/lib/types";

/**
 * The app's citation affordance, pointed at a line of the document already open.
 *
 * Page 2 of the W9 data sheet grounds seven different rows. Clicking the page
 * reference next to one of them has to land on that line, not on the page.
 */
export function CiteJump({ citation, href }: { citation: Citation; href: string }) {
  const router = useRouter();
  return <CiteLink citation={citation} onOpen={() => router.push(href)} />;
}

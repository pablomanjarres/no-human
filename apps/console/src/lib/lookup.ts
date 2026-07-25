import { catalog, type CatalogEntry } from "@/lib/solver";

/**
 * Part-number lookup over the real catalogue.
 *
 * Before this existed, the part-number lane resolved against a two-entry alias
 * map and everything else fell to a canned "not in the offline corpus" refusal —
 * including parts that were sitting in `catalog.generated.json` the whole time.
 * A tool that holds 796 SKUs and tells you it holds none of them is worse than
 * one that holds nothing, because the refusal reads as evidence.
 *
 * Exact matches only, on type code or order number. The near-miss list below is
 * offered to the operator, never auto-resolved — see `suggest`.
 */

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");

const byTypeCode = new Map<string, CatalogEntry>();
const byOrderNumber = new Map<string, CatalogEntry>();

for (const entry of catalog) {
  byTypeCode.set(normalise(entry.typeCode), entry);
  byOrderNumber.set(normalise(entry.orderNumber), entry);
}

/**
 * Exact hit or nothing.
 *
 * Order numbers are accepted alongside type codes because that is what is
 * printed on a purchase order, and somebody holding a PO is exactly the person
 * who needs this lookup. The two namespaces cannot collide: order numbers are
 * all-digit, type codes never are.
 */
export function findEntry(query: string): CatalogEntry | undefined {
  const key = normalise(query);
  if (!key) return undefined;
  return byTypeCode.get(key) ?? byOrderNumber.get(key);
}

export interface Suggestion {
  typeCode: string;
  orderNumber: string;
  family: string | null;
  /** Why this row is being offered — shown next to it, never implied. */
  reason: string;
}

/**
 * Near misses, for the operator to choose from.
 *
 * This is deliberately not resolution. `QS18VP6LV` and `QS18VN6LV` differ by one
 * character and by output polarity, and auto-resolving one to the other would
 * wire a sourcing output into a sinking input card — the precise failure this
 * product exists to prevent. So a near miss is rendered as a question with the
 * part numbers spelled out, and a human clicks it.
 */
export function suggest(query: string, limit = 5): Suggestion[] {
  const key = normalise(query);
  if (key.length < 3) return [];

  const scored: { entry: CatalogEntry; score: number; reason: string }[] = [];

  for (const entry of catalog) {
    const code = normalise(entry.typeCode);
    if (code === key) continue;

    let shared = 0;
    while (shared < key.length && shared < code.length && key[shared] === code[shared]) shared += 1;

    if (shared >= 4) {
      scored.push({
        entry,
        score: 100 + shared,
        reason: `shares the first ${shared} characters`,
      });
    } else if (key.length >= 5 && code.includes(key)) {
      scored.push({ entry, score: 50, reason: "contains what you typed" });
    } else if (key.length >= 5 && key.includes(code) && code.length >= 5) {
      scored.push({ entry, score: 40, reason: "the base type without your suffix" });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.entry.typeCode.localeCompare(b.entry.typeCode));

  return scored.slice(0, limit).map((s) => ({
    typeCode: s.entry.typeCode,
    orderNumber: s.entry.orderNumber,
    family: s.entry.family,
    reason: s.reason,
  }));
}

/**
 * Number formatting for the corpus board.
 *
 * The datasheets group thousands with a space, not a comma, and so does every
 * value the extractor lifted out of them ("1 100 mm", "10 … 30 V DC"). The board
 * prints its own telemetry the same way, so a judge reading a corpus figure and a
 * spec figure side by side is reading one convention, not two.
 */

const THIN_SPACE = " ";

/** 2954 → "2 954". SI grouping, thin space. */
export function groupDigits(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
}

/** Wall clock, rounded to the minute. 2 280 000 ms → "38". */
export function runtimeMinutes(ms: number): string {
  return groupDigits(ms / 60_000);
}

/** Seconds of wall clock per document. Derived, not asserted. */
export function perDocSeconds(ms: number, docs: number): string {
  if (docs <= 0) return "—";
  return (ms / 1000 / docs).toFixed(1);
}

/** Spec rows per document — how deep the read went, not how wide. */
export function rowsPerDoc(rows: number, docs: number): string {
  if (docs <= 0) return "—";
  return (rows / docs).toFixed(1);
}

/** Share of the corpus, one decimal. */
export function sharePercent(part: number, whole: number): string {
  if (whole <= 0) return "0.0";
  return ((part / whole) * 100).toFixed(1);
}

/**
 * The lexical lane: BM25 over chunk text, backed by MiniSearch.
 *
 * This lane exists because the dense lane is *bad at part numbers*. An engineer
 * pasting `GTB6-P4212` or `WTB4-3P2261` wants exact-token evidence, and an
 * embedding of a 10-character alphanumeric string is close to noise. BM25 also
 * keeps working with zero network access and zero API key, which is why the
 * whole package degrades to lexical-only rather than failing when Voyage is
 * unreachable.
 *
 * Everything here is pure: build an index from chunks, search it. No I/O.
 */

import MiniSearch from "minisearch";
import type { RagChunk } from "../types.js";

/** One lexical hit: a position in the chunk array the index was built from. */
export interface Bm25Hit {
  /** Position in the `chunks` array passed to {@link buildBm25Index}. */
  index: number;
  /**
   * MiniSearch's BM25 score with the query-length multiplier divided back out
   * (see {@link buildBm25Index}). Comparable across queries; still not
   * comparable to a cosine score — that is what RRF is for.
   */
  score: number;
}

/** A built lexical index. Immutable; rebuild to change the corpus. */
export interface Bm25Index {
  /** Number of chunks indexed. Carried into index provenance / diagnostics. */
  readonly size: number;
  /**
   * Best-first hits, at most `topK`. Empty for a blank query, an empty corpus,
   * `topK <= 0`, or a query whose every token was a stopword.
   */
  search(query: string, topK: number): Bm25Hit[];
}

/**
 * Stopwords, deliberately tiny.
 *
 * This corpus is Spanish technical prose. An off-the-shelf Spanish stoplist
 * would eat `sin` (as in *sin contacto*), and an aggressive one eats domain
 * words outright — dropping `luz` or `sensor` here would be unrecoverable,
 * because those are the exact words an engineer types. So this list is limited
 * to closed-class function words that carry no retrieval signal in either
 * language. Entries are stored diacritic-folded (`mas`, not `más`) because
 * folding happens before the lookup.
 *
 * Single-character tokens never reach this set — they are dropped by length.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // English
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "are",
  "was",
  "its",
  "into",
  "onto",
  "not",
  "but",
  "all",
  "any",
  "can",
  "has",
  "have",
  "been",
  "will",
  "also",
  "such",
  "than",
  "then",
  "there",
  "they",
  "these",
  "those",
  // Spanish
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "en",
  "con",
  "para",
  "por",
  "que",
  "se",
  "su",
  "sus",
  "al",
  "es",
  "son",
  "lo",
  "como",
  "pero",
  "mas",
  "este",
  "esta",
  "estos",
  "estas",
]);

/** Words where a trailing `ies` is not a plural. Tiny, but `series` is common. */
const IES_EXCEPTIONS: ReadonlySet<string> = new Set(["series", "species"]);

/**
 * Splits text into raw tokens.
 *
 * Two decisions worth understanding before you touch this:
 *
 * 1. **Diacritics are folded first.** The split alphabet is `[a-z0-9]`, so
 *    without folding, `fotocélula` would shred into `fotoc` + `lula` and
 *    `detección` into `detecci` + `n`. Since the catalog is Spanish, that would
 *    quietly destroy the lexical lane. NFD + combining-mark strip maps
 *    `é → e`, `ñ → n`, `ü → u` on both the document and the query side, so an
 *    engineer who types `fotocelula` still matches the page that prints
 *    `fotocélula`.
 *
 * 2. **A separator-bearing word emits its parts *and* their concatenation.**
 *    `GTE6-P4212` yields `gte6`, `p4212`, and `gte6p4212`. MiniSearch's default
 *    tokenizer splits on `[\s\-]+` only, which would keep the type code as one
 *    opaque token — so a query for `gte6` alone would miss it. Emitting the
 *    joined form as well means the same chunk is reachable whether the user
 *    types the type code hyphenated, spaced, or stripped, which is exactly how
 *    part numbers arrive from BOM rows and OCR'd labels.
 *
 * 3. **A short alphabetic prefix glues onto a following number.** The catalog
 *    prints `IP 67` and `IP 69K` spaced but `M12` closed up; engineers type
 *    `IP67` and `M 12`. Without this rule `ip67` is a token that exists in no
 *    document, so the query returns nothing at all — silent zero recall on one
 *    of the most common spec queries there is. The rule is deliberately narrow
 *    (an alphabetic run of 1–3 chars immediately followed by a digit-initial
 *    run) so it glues protection ratings and thread sizes and little else, and
 *    it runs on both the document and the query side so `IP67` ↔ `IP 67` match
 *    in either direction.
 *
 * Exported so the tests (and anyone debugging a miss) can see precisely what the
 * index saw.
 */
export function tokenizeForBm25(text: string): string[] {
  const folded = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const words: string[][] = [];
  for (const word of folded.split(/\s+/)) {
    if (word.length === 0) continue;
    const parts = word.split(/[^a-z0-9]+/).filter((p) => p.length > 0);
    if (parts.length > 0) words.push(parts);
  }

  const tokens: string[] = [];
  for (const parts of words) {
    for (const part of parts) tokens.push(part);
    if (parts.length > 1) tokens.push(parts.join(""));
  }

  for (let i = 0; i + 1 < words.length; i += 1) {
    const left = words[i]!.at(-1)!;
    const right = words[i + 1]![0]!;
    if (/^[a-z]{1,3}$/.test(left) && /^[0-9]/.test(right)) tokens.push(left + right);
  }

  return tokens;
}

/**
 * Very light suffix stemming — English plurals, `-ing`, `-ed`.
 *
 * Intentionally not a Porter stemmer. Aggressive stemming mangles Spanish
 * technical vocabulary and (worse) type codes, and the cost of a false merge
 * here is a wrong SKU shown as a lexical match. Known and accepted limitation:
 * Spanish consonant-plurals (`sensores` → `sensor`) are *not* collapsed,
 * because every rule that does so also breaks a real word in this corpus
 * (`cables` → `cabl` while `cable` stays `cable`). The dense lane covers that
 * morphological gap; that is a large part of why retrieval is hybrid.
 */
function lightStem(term: string): string {
  if (IES_EXCEPTIONS.has(term)) return term;
  if (term.endsWith("ies") && term.length >= 5) {
    return `${term.slice(0, -3)}y`;
  }
  if (term.endsWith("ing") && term.length >= 6) return term.slice(0, -3);
  if (term.endsWith("ed") && term.length >= 5 && !term.endsWith("eed")) {
    return term.slice(0, -2);
  }
  if (
    term.endsWith("s") &&
    term.length >= 4 &&
    !term.endsWith("ss") &&
    !term.endsWith("us") &&
    !term.endsWith("is")
  ) {
    return term.slice(0, -1);
  }
  return term;
}

/**
 * Normalizes one raw token, or drops it.
 *
 * The load-bearing rule is the digit guard: **any token containing a digit is
 * passed through untouched** — not stopworded, not stemmed. `ip67`, `m12`,
 * `p4212`, `1051781`, `24v` are identities, not words, and a stemmer that turns
 * `wtb4s` into `wtb4` would fuse two different product families. Word rules
 * only ever apply to purely alphabetic tokens.
 *
 * Exported for tests and for debugging why a term did or didn't match.
 */
export function processBm25Term(term: string): string | null {
  if (term.length < 2) return null;
  if (/[0-9]/.test(term)) return term;
  if (STOPWORDS.has(term)) return null;
  return lightStem(term);
}

/** Shape MiniSearch actually indexes: array position + the chunk's text. */
interface Bm25Doc {
  id: number;
  text: string;
}

/**
 * Builds the lexical index over `chunks`, positionally.
 *
 * Hits are identified by array position rather than `chunk.id` so RRF can fuse
 * the lexical and dense lanes with plain integer keys — both lanes rank the
 * same array, and the retrieval layer maps positions back to chunks once.
 *
 * ## Score normalization
 * MiniSearch multiplies a result's score by the number of matched query terms
 * ("quality"), so a two-word query yields scores roughly twice a one-word
 * query's for no reason related to relevance. That multiplier is divided back
 * out here. Without it, any downstream threshold or cross-query comparison
 * (and any human reading `bm25Score` in a citation) is measuring query length.
 *
 * Results are re-sorted with an explicit ascending-index tie-break: MiniSearch's
 * own sort is by score only, and identical chunk texts (shared accessories
 * repeated across pages) do produce exact ties.
 */
export function buildBm25Index(chunks: readonly RagChunk[]): Bm25Index {
  const size = chunks.length;

  const mini = new MiniSearch<Bm25Doc>({
    fields: ["text"],
    storeFields: [],
    idField: "id",
    tokenize: tokenizeForBm25,
    processTerm: processBm25Term,
    searchOptions: { combineWith: "OR", prefix: false, fuzzy: false },
  });

  if (size > 0) {
    mini.addAll(chunks.map((chunk, index) => ({ id: index, text: chunk.text })));
  }

  return {
    size,
    search(query: string, topK: number): Bm25Hit[] {
      if (size === 0 || topK <= 0 || query.trim().length === 0) return [];

      const raw = mini.search(query);
      const hits: Bm25Hit[] = raw.map((r) => ({
        index: r.id as number,
        // Undo MiniSearch's per-query "quality" multiplier; see above.
        score: r.score / (r.queryTerms.length || 1),
      }));

      hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
      return hits.slice(0, topK);
    },
  };
}

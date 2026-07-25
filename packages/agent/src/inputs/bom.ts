/**
 * Input modality: a bill of materials, pasted or exported as CSV.
 *
 * Real BOMs are not CSV the way a spec document means CSV. They come out of
 * Excel with a UTF-8 BOM marker and CRLF line endings, with the columns in
 * whatever order the buyer likes, with headers in Spanish or English or
 * missing entirely, with `"Sensor, diffuse, M12"` quoted around its commas, and
 * with a `TOTAL` line and a note to the vendor stuck on the bottom.
 *
 * The one rule that governs this file: **a row is never silently dropped.** A
 * line whose part number cannot be identified comes back with
 * `partNumber: undefined` so the auditor can report it as unprocessable. A
 * parser that quietly skips the three lines it did not understand is how you
 * ship a quote that is missing three lines — and nobody finds out until the
 * panel is half built.
 *
 * Parsing is deterministic and dependency-free. No model is involved: column
 * identification is a heuristic over header text and cell content, and every
 * row keeps its raw cells and its 1-based source line so any claim about it can
 * be cited back to the file the customer sent.
 */

/**
 * One line of a BOM, with everything needed to cite it back.
 *
 * `line` is the 1-based physical line where the record *starts* (a quoted field
 * may span lines), which is what a human sees in their spreadsheet. `raw`
 * carries every cell keyed by its column name, so a field this parser did not
 * classify — lead time, unit price, drawing reference — is still available
 * downstream rather than discarded.
 */
export interface BomRow {
  /** 1-based line in the source CSV where this record begins. */
  line: number;
  /** Absent when no column of this row yielded an identifiable part number.
   *  Such a row is still returned — see the module doc. */
  partNumber?: string;
  quantity?: number;
  vendor?: string;
  description?: string;
  /** Every cell of the row, keyed by column name (`column_N` when unnamed). */
  raw: Record<string, string>;
}

/** The four things this parser tries to find in a BOM. Everything else stays
 *  in {@link BomRow.raw} untouched. */
type BomColumnRole = "partNumber" | "quantity" | "vendor" | "description";

/** Header text → role. Deliberately generous: every spelling below has shown
 *  up in a real purchasing export, in English or Spanish. */
const HEADER_ALIASES: Record<BomColumnRole, readonly string[]> = {
  partNumber: [
    "part number",
    "part no",
    "part num",
    "part nr",
    "partnumber",
    "part",
    "pn",
    "p n",
    "mpn",
    "manufacturer part number",
    "manufacturer part no",
    "mfr part number",
    "mfr part no",
    "mfg part number",
    "supplier part number",
    "item",
    "item number",
    "item no",
    "item code",
    "sku",
    "model",
    "model number",
    "model no",
    "catalog",
    "catalog number",
    "catalog no",
    "catalogue number",
    "cat no",
    "cat number",
    "order number",
    "order no",
    "ref",
    "reference",
    "referencia",
    "codigo",
    "codigo articulo",
    "numero de parte",
    "no de parte",
    "n parte",
    "articulo",
  ],
  quantity: [
    "qty",
    "qty req",
    "quantity",
    "qnty",
    "qte",
    "q ty",
    "count",
    "pcs",
    "pieces",
    "units",
    "each",
    "ea",
    "cant",
    "cantidad",
    "cdad",
  ],
  vendor: [
    "vendor",
    "manufacturer",
    "manufacturer name",
    "mfr",
    "mfg",
    "make",
    "brand",
    "supplier",
    "maker",
    "oem",
    "marca",
    "fabricante",
    "proveedor",
  ],
  description: [
    "description",
    "desc",
    "descr",
    "description of goods",
    "item description",
    "part description",
    "product description",
    "product",
    "details",
    "detail",
    "notes",
    "note",
    "comments",
    "name",
    "descripcion",
    "denominacion",
    "detalle",
  ],
};

/** Brands that show up in the vendor column of a sensor BOM. Used only to
 *  *identify the column* when the header did not, never to assert a vendor. */
const KNOWN_VENDOR_TOKENS = [
  "banner",
  "keyence",
  "sick",
  "pepperl",
  "fuchs",
  "p+f",
  "balluff",
  "ifm",
  "omron",
  "turck",
  "baumer",
  "datalogic",
  "autonics",
  "panasonic",
  "sunx",
  "rockwell",
  "allen",
  "bradley",
  "schneider",
  "telemecanique",
  "sensopart",
  "wenglor",
  "leuze",
  "contrinex",
  "gavazzi",
  "disoric",
  "di soric",
  "tri tronics",
  "eaton",
  "siemens",
  "festo",
  "smc",
  "optex",
  "hokuyo",
];

/** Lowercase, strip accents and punctuation, collapse whitespace. `"Part_No."`
 *  and `"PARTE Nº"` have to land on the same key as `"part no"`. */
function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const HEADER_LOOKUP: ReadonlyMap<string, BomColumnRole> = (() => {
  const map = new Map<string, BomColumnRole>();
  for (const role of Object.keys(HEADER_ALIASES) as BomColumnRole[]) {
    for (const alias of HEADER_ALIASES[role]) {
      // First alias wins: `HEADER_ALIASES` is ordered so the specific spelling
      // ("part number") is registered before the ambiguous one ("part").
      if (!map.has(alias)) map.set(alias, role);
    }
  }
  return map;
})();

/** One physical record: its cells plus where it started. */
interface RawRecord {
  line: number;
  cells: string[];
}

/**
 * Pick the delimiter from the first non-blank line.
 *
 * European exports are semicolon-separated and tab-separated dumps are common
 * from ERPs; guessing wrong turns the whole file into one unparseable column,
 * which — per the module rule — would show up as every row unprocessable rather
 * than as an error. Counting outside quotes keeps `"Sensor, M12"` from voting.
 */
function sniffDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (ch === "\n" || ch === "\r") {
      // Only stop once the line had content; leading blank lines vote nothing.
      if (counts[","]! + counts[";"]! + counts["\t"]! > 0) break;
      continue;
    }
    if (ch !== undefined && ch in counts) counts[ch] = counts[ch]! + 1;
  }
  const best = (Object.keys(counts) as string[]).reduce(
    (a, b) => (counts[b]! > counts[a]! ? b : a),
    ",",
  );
  return counts[best]! > 0 ? best : ",";
}

/**
 * RFC-4180-ish tokenizer, written here rather than pulled in as a dependency.
 *
 * Handles: quoted fields with embedded delimiters, embedded newlines and `""`
 * escapes; CRLF, LF and lone-CR line endings; a leading UTF-8 BOM. Truly blank
 * lines are skipped — a line of only delimiters (`,,,`) is *not* blank and is
 * kept, because in a real BOM that is a row someone forgot to fill in and the
 * auditor needs to say so.
 */
function splitRecords(text: string, delimiter: string): RawRecord[] {
  const records: RawRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false;
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const begin = (): void => {
    if (!started) {
      started = true;
      recordLine = line;
    }
  };

  const endRecord = (): void => {
    if (!started) {
      field = "";
      cells = [];
      return;
    }
    cells.push(field);
    field = "";
    const blank = !quoted && cells.length === 1 && (cells[0] ?? "").trim().length === 0;
    if (!blank) records.push({ line: recordLine, cells });
    cells = [];
    started = false;
    quoted = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      if (ch === "\n") line += 1;
      field += ch;
      continue;
    }

    if (ch === '"') {
      begin();
      quoted = true;
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      begin();
      cells.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") {
      endRecord();
      if (text[i + 1] === "\n") i += 1;
      line += 1;
      continue;
    }
    if (ch === "\n") {
      endRecord();
      line += 1;
      continue;
    }
    begin();
    field += ch;
  }
  endRecord();

  return records;
}

/**
 * Decide whether the first record is a header.
 *
 * Two ways to qualify: at least two cells map to distinct known roles, or every
 * non-empty cell maps to a role (which catches the single-column
 * `Part Number` list). Anything less is treated as data — getting this wrong in
 * the permissive direction would eat a real part number as a header, which is
 * exactly the silent drop this module forbids.
 */
function detectHeader(cells: readonly string[]): Map<BomColumnRole, number> | null {
  const roles = new Map<BomColumnRole, number>();
  let nonEmpty = 0;
  let matched = 0;

  for (let i = 0; i < cells.length; i += 1) {
    const text = (cells[i] ?? "").trim();
    if (text.length === 0) continue;
    nonEmpty += 1;
    const role = HEADER_LOOKUP.get(normalizeHeader(text));
    if (role === undefined) continue;
    matched += 1;
    if (!roles.has(role)) roles.set(role, i);
  }

  if (nonEmpty === 0) return null;
  if (roles.size >= 2) return roles;
  if (roles.size >= 1 && matched === nonEmpty) return roles;
  return null;
}

/** Looks like an orderable identifier: mixed letters+digits (`QS18VN6D`), or a
 *  long all-digit code (SICK order numbers are 7 digits). Short bare integers
 *  are line counters, not part numbers. */
function looksLikePartNumber(value: string): boolean {
  const v = value.trim();
  if (v.length < 3 || v.length > 48) return false;
  if (/\s{2,}/.test(v)) return false;
  // Two tokens at most: `GTB6-P4212` and `GTB6 P4212` are part numbers,
  // `Photoelectric sensor M12` is a description that would otherwise score as
  // one and steal the column from the real part number.
  if (v.split(/\s+/).length > 2) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9\-/._+#() ]*$/.test(v)) return false;
  if (/^\d+$/.test(v)) return v.length >= 5;
  return /[A-Za-z]/.test(v) && /[0-9]/.test(v);
}

function looksLikeQuantity(value: string): boolean {
  return /^\d{1,6}([.,]\d{1,3})?\s*(ea|pcs|pza|pzs|un|uds|units|unit|pieces|x)?$/i.test(
    value.trim(),
  );
}

function looksLikeVendor(value: string): boolean {
  const v = normalizeHeader(value);
  if (v.length === 0) return false;
  return KNOWN_VENDOR_TOKENS.some(
    (token) => v === token || v.startsWith(`${token} `) || v.includes(` ${token}`),
  );
}

/** Fraction of non-empty cells in a column satisfying `test`. Columns that are
 *  entirely empty score 0 so they never win a role. */
function columnScore(
  rows: readonly RawRecord[],
  index: number,
  test: (value: string) => boolean,
): number {
  let seen = 0;
  let hits = 0;
  for (const row of rows) {
    const value = (row.cells[index] ?? "").trim();
    if (value.length === 0) continue;
    seen += 1;
    if (test(value)) hits += 1;
  }
  return seen === 0 ? 0 : hits / seen;
}

function averageLength(rows: readonly RawRecord[], index: number): number {
  let total = 0;
  let seen = 0;
  for (const row of rows) {
    const value = (row.cells[index] ?? "").trim();
    if (value.length === 0) continue;
    seen += 1;
    total += value.length;
  }
  return seen === 0 ? 0 : total / seen;
}

function widestRow(rows: readonly RawRecord[]): number {
  return rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
}

/**
 * Fill in roles the header did not give us by looking at what the cells
 * actually contain.
 *
 * Runs for headerless files *and* for headed files with an unrecognised column
 * name — a file whose part column is titled `Nº` still has to be auditable.
 * Roles already assigned are never overwritten and never double-assigned.
 */
function inferRolesByContent(
  rows: readonly RawRecord[],
  roles: Map<BomColumnRole, number>,
): Map<BomColumnRole, number> {
  const width = widestRow(rows);
  const taken = new Set<number>(roles.values());

  const claim = (
    role: BomColumnRole,
    scorer: (index: number) => number,
    threshold: number,
  ): void => {
    if (roles.has(role)) return;
    let bestIndex = -1;
    let bestScore = threshold;
    for (let i = 0; i < width; i += 1) {
      if (taken.has(i)) continue;
      const score = scorer(i);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      roles.set(role, bestIndex);
      taken.add(bestIndex);
    }
  };

  claim("partNumber", (i) => columnScore(rows, i, looksLikePartNumber), 0.4);
  claim("vendor", (i) => columnScore(rows, i, looksLikeVendor), 0.4);
  claim("quantity", (i) => columnScore(rows, i, looksLikeQuantity), 0.6);
  // Description is whatever is left that reads like prose: long cells that
  // mostly contain spaces. Length alone would happily elect a date column.
  claim(
    "description",
    (i) => {
      const avg = averageLength(rows, i);
      const prose = columnScore(rows, i, (value) => value.includes(" "));
      return avg >= 10 && prose >= 0.5 ? avg : 0;
    },
    0,
  );

  return roles;
}

/**
 * Reject a header-derived part-number column that is really a line counter.
 *
 * `Item` is a legitimate spelling of "part number" and a legitimate spelling of
 * "row 1, row 2, row 3". If the column holds nothing but short integers it is
 * the latter, and keeping it would give every row a fake part number — worse
 * than no part number, because the auditor would then try to cross-reference
 * `3` against the SICK catalog and report a confident nonsense answer.
 */
function partColumnIsCounter(rows: readonly RawRecord[], index: number): boolean {
  let seen = 0;
  for (const row of rows) {
    const value = (row.cells[index] ?? "").trim();
    if (value.length === 0) continue;
    seen += 1;
    if (!/^\d{1,3}$/.test(value)) return false;
  }
  return seen > 0;
}

/**
 * Parse a quantity cell. Tolerates `2 ea`, `10 pcs`, `1,000`, `1.5`, `  4  `.
 *
 * Returns `undefined` rather than a default when the cell is not a number —
 * defaulting to 1 would invent stock that nobody ordered, and 0 would silently
 * delete a line.
 */
function parseQuantity(value: string): number | undefined {
  const cleaned = value.trim().replace(/[^0-9.,]/g, "");
  if (cleaned.length === 0) return undefined;
  const normalized = /^\d{1,3}(,\d{3})+$/.test(cleaned)
    ? cleaned.replace(/,/g, "")
    : cleaned.replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

/** Build stable, unique column names for {@link BomRow.raw}. */
function columnNames(header: readonly string[] | null, width: number): string[] {
  const names: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < width; i += 1) {
    const raw = (header?.[i] ?? "").trim();
    let name = raw.length > 0 ? raw : `column_${i + 1}`;
    if (used.has(name)) name = `${name} (${i + 1})`;
    used.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Parse a BOM CSV into rows.
 *
 * Tolerant by design: arbitrary column order, missing or unrecognised headers,
 * comma / semicolon / tab delimiters, quoted fields containing delimiters and
 * newlines, `""` escapes, CRLF, and a leading UTF-8 BOM marker.
 *
 * **Every non-blank record comes back.** Rows whose part number could not be
 * identified — a `TOTAL` line, a note to the supplier, a row where the buyer
 * left the part column empty — are returned with `partNumber: undefined` so
 * the auditor reports them as unprocessable. It is not this function's job to
 * decide a line does not matter.
 */
export function parseBom(csv: string): BomRow[] {
  const text = csv.replace(/^\ufeff/, "");
  if (text.trim().length === 0) return [];

  const delimiter = sniffDelimiter(text);
  const records = splitRecords(text, delimiter);
  if (records.length === 0) return [];

  const first = records[0]!;
  const headerRoles = detectHeader(first.cells);
  const dataRows = headerRoles === null ? records : records.slice(1);
  const header = headerRoles === null ? null : first.cells;

  const roles = headerRoles ?? new Map<BomColumnRole, number>();
  const partIndex = roles.get("partNumber");
  if (partIndex !== undefined && partColumnIsCounter(dataRows, partIndex)) {
    roles.delete("partNumber");
  }
  inferRolesByContent(dataRows, roles);

  const width = Math.max(widestRow(records), header?.length ?? 0);
  const names = columnNames(header, width);

  const pick = (record: RawRecord, role: BomColumnRole): string | undefined => {
    const index = roles.get(role);
    if (index === undefined) return undefined;
    const value = (record.cells[index] ?? "").trim();
    return value.length > 0 ? value : undefined;
  };

  return dataRows.map((record) => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < record.cells.length; i += 1) {
      const key = names[i] ?? `column_${i + 1}`;
      raw[key] = (record.cells[i] ?? "").trim();
    }

    const partNumber = pick(record, "partNumber");
    const vendor = pick(record, "vendor");
    const description = pick(record, "description");
    const quantityText = pick(record, "quantity");
    const quantity = quantityText === undefined ? undefined : parseQuantity(quantityText);

    return {
      line: record.line,
      ...(partNumber !== undefined ? { partNumber } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(vendor !== undefined ? { vendor } : {}),
      ...(description !== undefined ? { description } : {}),
      raw,
    };
  });
}

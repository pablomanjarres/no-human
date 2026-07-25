import { describe, it, expect } from "vitest";

import { parseBom } from "./bom.js";

/** The shape a real purchasing export arrives in: UTF-8 BOM marker, CRLF, the
 *  columns in the buyer's order, a quoted description containing commas, a
 *  blank line, a free-text note, and a TOTAL line at the bottom. */
const MESSY_CSV =
  "﻿Qty,Manufacturer,Part Number,Description\r\n" +
  '2,Banner,QS18VN6D,"Photoelectric sensor, diffuse, M12"\r\n' +
  "\r\n" +
  '3 ea,Keyence,PZ-G51N,"Retro-reflective sensor, 5 m"\r\n' +
  ',,,"Note to supplier: confirm lead times before quoting"\r\n' +
  ",,,\r\n" +
  "TOTAL,,,\r\n";

describe("parseBom", () => {
  it("keeps every non-blank record, including the ones it cannot process", () => {
    const rows = parseBom(MESSY_CSV);

    // 4 data rows + the all-empty row + the TOTAL row; only the truly blank
    // line is gone. A silent drop here is a missing line on a quote.
    expect(rows.map((r) => r.line)).toEqual([2, 4, 5, 6, 7]);
    expect(rows.filter((r) => r.partNumber === undefined)).toHaveLength(3);
  });

  it("reads reordered columns off the header and strips the UTF-8 BOM marker", () => {
    const rows = parseBom(MESSY_CSV);
    const first = rows[0];

    expect(first?.partNumber).toBe("QS18VN6D");
    expect(first?.vendor).toBe("Banner");
    expect(first?.quantity).toBe(2);
    expect(first?.description).toBe("Photoelectric sensor, diffuse, M12");
    // The BOM marker must not survive into the first header name.
    expect(Object.keys(first?.raw ?? {})).toEqual([
      "Qty",
      "Manufacturer",
      "Part Number",
      "Description",
    ]);
  });

  it("parses quantities written the way humans write them", () => {
    const rows = parseBom(MESSY_CSV);
    expect(rows[1]?.quantity).toBe(3);
    expect(rows[1]?.partNumber).toBe("PZ-G51N");
  });

  it("returns unprocessable rows with partNumber undefined rather than dropping them", () => {
    const rows = parseBom(MESSY_CSV);

    const note = rows.find((r) => r.line === 5);
    expect(note?.partNumber).toBeUndefined();
    expect(note?.description).toBe("Note to supplier: confirm lead times before quoting");

    const emptyRow = rows.find((r) => r.line === 6);
    expect(emptyRow).toBeDefined();
    expect(emptyRow?.partNumber).toBeUndefined();
    expect(emptyRow?.quantity).toBeUndefined();

    const total = rows.find((r) => r.line === 7);
    expect(total?.partNumber).toBeUndefined();
    // "TOTAL" sat in the quantity column; it must not become a number.
    expect(total?.quantity).toBeUndefined();
    expect(total?.raw["Qty"]).toBe("TOTAL");
  });

  it("does not eat the first data row when the file has no header", () => {
    const csv = [
      "QS18VN6D,Banner,2,Diffuse sensor with M12 connector",
      "PZ-G51N,Keyence,1,Retro-reflective sensor 5 m",
      "E3Z-D62,Omron,4,Diffuse sensor 1 m range",
    ].join("\n");

    const rows = parseBom(csv);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.partNumber)).toEqual(["QS18VN6D", "PZ-G51N", "E3Z-D62"]);
    expect(rows.map((r) => r.vendor)).toEqual(["Banner", "Keyence", "Omron"]);
    expect(rows.map((r) => r.quantity)).toEqual([2, 1, 4]);
    expect(rows[0]?.description).toBe("Diffuse sensor with M12 connector");
    // Unnamed columns still get stable keys so the raw row is citable.
    expect(Object.keys(rows[0]?.raw ?? {})).toEqual([
      "column_1",
      "column_2",
      "column_3",
      "column_4",
    ]);
    expect(rows[0]?.line).toBe(1);
  });

  it("handles semicolon files, embedded newlines, and escaped quotes", () => {
    const csv =
      "Part No;Qty;Description\r\n" +
      'GTB6-P4212;3;"Diffuse sensor;\r\n2 m range, ""black"" housing"\r\n' +
      "GTE6-P4211;1;Through-beam receiver\r\n";

    const rows = parseBom(csv);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.partNumber).toBe("GTB6-P4212");
    expect(rows[0]?.description).toBe('Diffuse sensor;\r\n2 m range, "black" housing');
    expect(rows[0]?.quantity).toBe(3);
    // The quoted field spanned two physical lines, so the next record is line 4.
    expect(rows[1]?.line).toBe(4);
  });

  it("refuses to treat a line-counter column as a part number", () => {
    const csv = [
      "Item,Description,Qty",
      '1,"SICK GTB6-P4212 diffuse sensor",2',
      '2,"Banner QS18VN6D photoelectric",1',
    ].join("\n");

    const rows = parseBom(csv);

    expect(rows).toHaveLength(2);
    // `Item` is a legitimate header alias for a part number, but 1/2/3 is a
    // counter — inventing "part number 1" would produce a confident wrong audit.
    expect(rows.map((r) => r.partNumber)).toEqual([undefined, undefined]);
    expect(rows[0]?.description).toBe("SICK GTB6-P4212 diffuse sensor");
    expect(rows[0]?.raw["Item"]).toBe("1");
  });

  it("keeps cells that overflow the header width", () => {
    const csv = ["Part Number,Qty", "QS18VN6D,2,extra-note", "PZ-G51N,1"].join("\n");

    const rows = parseBom(csv);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.raw["column_3"]).toBe("extra-note");
    expect(rows[0]?.partNumber).toBe("QS18VN6D");
  });

  it("survives a single-column part list and an empty file", () => {
    expect(parseBom("")).toEqual([]);
    expect(parseBom("   \n\n")).toEqual([]);

    const rows = parseBom("Part Number\nQS18VN6D\nPZ-G51N\n");
    expect(rows.map((r) => r.partNumber)).toEqual(["QS18VN6D", "PZ-G51N"]);
  });

  it("keeps rows whose part column is blank in an otherwise clean file", () => {
    const csv = [
      "Part Number,Qty,Vendor",
      "QS18VN6D,2,Banner",
      ",1,Keyence",
      "PZ-G51N,3,Keyence",
    ].join("\n");

    const rows = parseBom(csv);

    expect(rows).toHaveLength(3);
    expect(rows[1]?.partNumber).toBeUndefined();
    expect(rows[1]?.quantity).toBe(1);
    expect(rows[1]?.vendor).toBe("Keyence");
    expect(rows[1]?.line).toBe(3);
  });
});

/**
 * These tests run against the *real* dataset files on purpose.
 *
 * The whole value of this module is that it reports what the Banner guide
 * actually printed. A fixture would let the loader drift away from the file it
 * claims to read — a regression that presents as confidently wrong competitor
 * specs, which is exactly the failure this module exists to prevent. No model,
 * no network, no API key: everything here is file I/O and pure functions.
 */

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BANNER_MODE_TO_PRINCIPLE,
  bannerModeToPrinciple,
  loadCompetitorIndex,
  mapHousing,
  normalizePartKey,
  parseCsv,
  toConstraints,
  toIdentifiedPart,
  type CompetitorMatch,
} from "./competitors.js";

/** Repo root: `packages/agent/src/` → up three. */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const index = await loadCompetitorIndex(ROOT);

function must(partNumber: string): CompetitorMatch {
  const match = index.lookup(partNumber);
  if (match === undefined) throw new Error(`expected a competitor match for ${partNumber}`);
  return match;
}

describe("loadCompetitorIndex", () => {
  it("loads every Banner product from the real dataset", () => {
    expect(index.size()).toBe(62);
    expect(index.products()).toHaveLength(62);
    expect(index.vendors()).toEqual(["Banner"]);
  });

  it("throws rather than degrading to an empty index when the files are missing", async () => {
    await expect(loadCompetitorIndex("/nonexistent/no-human-root")).rejects.toThrow(
      /Cannot load competitor products/,
    );
  });
});

describe("normalizePartKey", () => {
  it("collapses case, spaces, hyphens and dots to one key", () => {
    const forms = ["QS18VN6LV", "qs18-vn6lv", "QS18 VN6LV", "qs18.vn6lv", " Qs18/Vn6Lv "];
    for (const form of forms) expect(normalizePartKey(form)).toBe("QS18VN6LV");
  });
});

describe("lookup", () => {
  it("resolves every punctuation variant of a model to the same record", () => {
    for (const form of ["SME312LPC", "sme-312-lpc", "SME 312 LPC", "sme.312.lpc"]) {
      const match = must(form);
      expect(match.kind).toBe("model");
      expect(match.matchedKey).toBe("SME312LPC");
      expect(match.product.model).toBe("SME312LPC");
      expect(match.product.series).toBe("MINI-BEAM");
      // The raw input survives verbatim so the report can quote what was asked.
      expect(match.query).toBe(form);
    }
  });

  it("returns the fullest record when a series name collides with a teaser row", () => {
    const match = must("mini beam");
    expect(match.kind).toBe("series");
    expect(match.product.series).toBe("MINI-BEAM");
    expect(match.product.model).toBeUndefined();
    // The full spec card, not the one-line "Productos Nuevos" entry.
    expect(match.product.sensingModes).toHaveLength(8);
    expect(match.alternatives).toHaveLength(3);
  });

  it("falls back to the longest series prefix and says so", () => {
    const match = must("T18XDN2LP");
    expect(match.kind).toBe("series-prefix");
    expect(match.matchedKey).toBe("T18XDN");
    expect(match.product.series).toBe("T18XDN");
  });

  it("strips a leading vendor token", () => {
    expect(must("Banner MINI-BEAM").product.series).toBe("MINI-BEAM");
    // …but "Banner" alone identifies no part.
    expect(index.lookup("Banner")).toBeUndefined();
  });

  it("returns undefined for a part we do not hold, rather than a near miss", () => {
    for (const form of ["QS18VN6LV", "qs18-vn6lv", "QS18 VN6LV"]) {
      expect(index.lookup(form)).toBeUndefined();
    }
    expect(index.lookup("ZZ-9999")).toBeUndefined();
    expect(index.lookup("")).toBeUndefined();
    expect(index.lookup("   ")).toBeUndefined();
    // A one-character stem must never latch onto a three-character series.
    expect(index.lookup("Q")).toBeUndefined();
  });
});

describe("BANNER_MODE_TO_PRINCIPLE", () => {
  it("maps Banner's taxonomy onto SICK's, with fiber optic deliberately unmapped", () => {
    expect(BANNER_MODE_TO_PRINCIPLE).toEqual({
      opposed: "through-beam",
      retroreflective: "retroreflective",
      diffuse: "diffuse",
      convergent: "background-suppression",
      fixed_field: "background-suppression",
      ultrasonic: "ultrasonic",
      fiber_optic: null,
    });
    expect(bannerModeToPrinciple("fiber_optic")).toBeUndefined();
    expect(bannerModeToPrinciple("Fixed Field")).toBe("background-suppression");
    expect(bannerModeToPrinciple("diffuse (long range)")).toBe("diffuse");
    expect(bannerModeToPrinciple("telepathy")).toBeUndefined();
  });
});

describe("toConstraints", () => {
  it("omits the range constraint when the guide never printed one", () => {
    const constraints = toConstraints(must("SME312LPC"), "retroreflective");
    expect(constraints.principle).toEqual(["retroreflective"]);
    // A null range must NOT become { min: 0 } — that would pass every sensor
    // in the catalog against a requirement nobody ever stated.
    expect(constraints.sensingRangeMm).toBeUndefined();
    expect("sensingRangeMm" in constraints).toBe(false);
    expect("operatingTempC" in constraints).toBe(false);
    expect("housing" in constraints).toBe(false);
  });

  it("derives principle and range for a single selected mode", () => {
    const miniBeam = must("MINI-BEAM");
    const opposed = toConstraints(miniBeam, "opposed");
    expect(opposed.principle).toEqual(["through-beam"]);
    expect(opposed.sensingRangeMm).toEqual({ min: 30_000 });

    const diffuse = toConstraints(miniBeam, "diffuse");
    expect(diffuse.principle).toEqual(["diffuse"]);
    expect(diffuse.sensingRangeMm).toEqual({ min: 380 });

    // Convergent maps to background-suppression, but its range is prose-only.
    const convergent = toConstraints(miniBeam, "convergent");
    expect(convergent.principle).toEqual(["background-suppression"]);
    expect(convergent.sensingRangeMm).toBeUndefined();

    // Fiber optic has no SICK principle at all — and no invented one.
    const fiber = toConstraints(miniBeam, "fiber_optic");
    expect(fiber.principle).toBeUndefined();
    expect(fiber.sensingRangeMm).toBeUndefined();
  });

  it("refuses to invent a range for a multi-mode series", () => {
    const constraints = toConstraints(must("MINI-BEAM"));
    expect(constraints.principle).toEqual([
      "through-beam",
      "retroreflective",
      "diffuse",
      "background-suppression",
    ]);
    // Four different optics, no single reach. Demanding 30 m of a diffuse
    // sensor would refuse every honest answer.
    expect(constraints.sensingRangeMm).toBeUndefined();
  });

  it("emits nothing for a mode the product does not state", () => {
    const constraints = toConstraints(must("SME312LPC"), "ultrasonic");
    expect(constraints.principle).toBeUndefined();
    expect(constraints.sensingRangeMm).toBeUndefined();
  });

  it("carries temperature, housing and ingress protection when stated", () => {
    const constraints = toConstraints(must("T18"), "opposed");
    expect(constraints.principle).toEqual(["through-beam"]);
    expect(constraints.sensingRangeMm).toEqual({ min: 20_000 });
    expect(constraints.operatingTempC).toEqual({ min: -40, max: 70 });
    expect(constraints.housing).toEqual(["plastic"]);
    expect(constraints.minIpRating).toBe(67);
    expect("ip69k" in constraints).toBe(false);
  });

  it("maps the ultrasonic mode and takes the family's longest stated reach", () => {
    const constraints = toConstraints(must("Q45U"), "ultrasonic");
    expect(constraints.principle).toEqual(["ultrasonic"]);
    expect(constraints.sensingRangeMm).toEqual({ min: 3_000 });
  });

  it("never emits a zero-valued range for any product in the dataset", () => {
    for (const product of index.products()) {
      for (const sensing of product.sensingModes) {
        const match: CompetitorMatch = {
          product,
          kind: "series",
          matchedKey: "",
          query: "",
          alternatives: [],
        };
        const constraints = toConstraints(match, sensing.mode);
        if (constraints.sensingRangeMm !== undefined) {
          expect(constraints.sensingRangeMm.min).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("mapHousing", () => {
  it("keeps a disjunctive material ambiguous instead of guessing", () => {
    expect(mapHousing("S18: PBT; M18: s. steel")).toEqual(["stainless-steel", "plastic"]);
  });

  it("does not read 'acero inoxidable' as plain metal", () => {
    expect(mapHousing("acero inoxidable (transductor remoto)")).toEqual(["stainless-steel"]);
  });

  it("maps the common materials and gives up quietly on the rest", () => {
    expect(mapHousing("PBT polyester")).toEqual(["plastic"]);
    expect(mapHousing("zinc alloy")).toEqual(["metal"]);
    expect(mapHousing("suave encapsulado de aluminio")).toEqual(["metal"]);
    // Unrecognized: no constraint at all, rather than a fabricated "other".
    expect(mapHousing("unobtanium")).toEqual([]);
  });
});

describe("toIdentifiedPart", () => {
  it("marks dataset-sourced specs and cites the Banner page", () => {
    const part = toIdentifiedPart(must("sme-312-lpc"));
    expect(part.vendor).toBe("Banner");
    expect(part.series).toBe("MINI-BEAM");
    expect(part.model).toBe("SME312LPC");
    expect(part.rawInput).toBe("sme-312-lpc");
    expect(part.specSource).toBe("dataset");
    expect(part.citation).toEqual({
      typeCode: "SME312LPC",
      family: "MINI-BEAM",
      sourcePage: "Banner p.6",
      pdfPage: 5,
    });
    // A Banner record must never carry a SICK order number.
    expect(part.citation?.orderNumber).toBeUndefined();
  });

  it("omits a description the guide never printed", () => {
    const part = toIdentifiedPart(must("MINI-BEAM"));
    expect("description" in part).toBe(false);
  });
});

describe("priorRecommendation", () => {
  it("returns every crossref row naming the series, with prose intact", () => {
    const rows = index.priorRecommendation("MINI-BEAM");
    expect(rows).toHaveLength(14);
    expect(rows.every((r) => r.bannerSeries === "MINI-BEAM")).toBe(true);

    const opposed = rows.find((r) => r.bannerMode === "opposed" && r.bannerRangeMaxMm === 30_000);
    expect(opposed?.sickTypeCode).toBe("GSE10-P4211");
    expect(opposed?.sickOrderNumber).toBe("1064706");
    expect(opposed?.sickFamily).toBe("G10");
    expect(opposed?.adequate).toBe(true);
    expect(opposed?.confidence).toBe("high");
    // The rationale is comma-laden prose in a quoted CSV field: a naive
    // split(",") would shear it into a plausible-looking half-sentence.
    expect(opposed?.rationale).toContain(
      "G10 through-beam reaches 40 m, fully covering Banner's 30 m",
    );
    expect(opposed?.rationale).toContain("V180-2 at 28 m falls slightly short.");
  });

  it("matches on model as well as series", () => {
    const rows = index.priorRecommendation("bmlv");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bannerSeries).toBe("BEAM-ARRAY");
    expect(rows[0]?.bannerModel).toBe("BMLV");
  });

  it("leaves confidence absent on rows no adjudicator ever saw", () => {
    const fiber = index
      .priorRecommendation("MINI-BEAM")
      .find((r) => r.bannerMode === "fiber_optic" && r.bannerModel === undefined);
    expect(fiber?.source).toBe("deterministic");
    expect(fiber?.adequate).toBe(false);
    expect(fiber?.confidence).toBeUndefined();
    expect(fiber?.sickOrderNumber).toBeUndefined();
  });

  it("returns nothing for a part with no prior work", () => {
    expect(index.priorRecommendation("QS18VN6LV")).toEqual([]);
    expect(index.priorRecommendation("")).toEqual([]);
  });
});

describe("knownGap", () => {
  it("reports a known gap row as a gap", () => {
    expect(index.knownGap("MAXI-BEAM")).toBe(true);
    expect(index.knownGap("maxi beam", "opposed")).toBe(true);
    expect(index.knownGap("MINI-BEAM", "fiber_optic")).toBe(true);
    expect(index.knownGap("t-18-u", "ultrasonic")).toBe(true);
  });

  it("does not condemn the modes that are actually replaceable", () => {
    // MINI-BEAM is a gap in fiber optic only; its four optical modes are fine.
    expect(index.knownGap("MINI-BEAM")).toBe(true);
    expect(index.knownGap("MINI-BEAM", "opposed")).toBe(false);
    expect(index.knownGap("MINI-BEAM", "retroreflective")).toBe(false);
    expect(index.knownGap("T18")).toBe(false);
    expect(index.knownGap("QS18VN6LV")).toBe(false);
    expect(index.knownGap("")).toBe(false);
  });
});

describe("parseCsv", () => {
  it("keeps embedded commas, escaped quotes and CRLF line endings intact", () => {
    const rows = parseCsv('a,b,c\r\n1,"needs, a comma","said ""no"""\r\n2,plain,\r\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "needs, a comma", 'said "no"'],
      ["2", "plain", ""],
    ]);
  });

  it("tolerates a file with no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

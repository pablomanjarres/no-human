import { describe, expect, it } from "vitest";

import { classifyInput } from "@/lib/engine";
import { parseDescription } from "@/lib/describe";

/**
 * These are regression tests for answers the console gave that were wrong in a
 * way a user could not see was wrong. Each case here was reported from the
 * deployed app, not imagined.
 */

describe("classifyInput", () => {
  // The reported bug: the old test was a shape regex whose character class
  // included the space, so any Spanish sentence carrying a digit was sent to
  // the part-number lookup and came back "not in the offline corpus".
  it("routes a Spanish sentence containing a number to the describe lane", () => {
    expect(classifyInput("caja negra a 500 mm")).toBe("describe");
    expect(classifyInput("necesito detectar cajas de carton a 40 cm")).toBe("describe");
    expect(classifyInput("detect white paper at 200 mm")).toBe("describe");
  });

  it("routes a description with no digits to the describe lane", () => {
    expect(classifyInput("sensor de caja")).toBe("describe");
    expect(classifyInput("algo que detecte botellas")).toBe("describe");
  });

  it("routes real catalogue part numbers to the part lane", () => {
    expect(classifyInput("WTB9-3P2211S14")).toBe("part");
    expect(classifyInput("wtb9-3p2211s14")).toBe("part");
    expect(classifyInput("  WSE2S-2P3130  ")).toBe("part");
  });

  it("routes order numbers to the part lane", () => {
    expect(classifyInput("1052171")).toBe("part");
    // Not a real order number, but unmistakably not prose either.
    expect(classifyInput("9999999")).toBe("part");
  });

  it("keeps the scripted competitor part numbers on the part lane", () => {
    expect(classifyInput("QS18VN6LV")).toBe("part");
    expect(classifyInput("ML100-8-1000-RT/95/103")).toBe("part");
  });

  it("sends an unknown compact type code to the part lane, so it gets a lookup", () => {
    // The useful failure: a real lookup and near misses, not a shrug.
    expect(classifyInput("QS18VP6LV")).toBe("part");
  });

  it("treats an empty box as a description rather than a part number", () => {
    expect(classifyInput("")).toBe("describe");
    expect(classifyInput("   ")).toBe("describe");
  });
});

describe("parseDescription", () => {
  // The other reported bug: every description was answered with a scripted run
  // for a 6% black target, and the solve ran with remission hard-coded.
  it("does not invent a remission for a target that does not state one", () => {
    expect(parseDescription("sensor de caja").remission).toBeNull();
  });

  it("does not invent a distance for a description that does not state one", () => {
    expect(parseDescription("cajas negras en una banda").distanceMm).toBeNull();
  });

  it("reads remission from colour and material words", () => {
    expect(parseDescription("caja negra").remission?.value).toBe("6pct");
    expect(parseDescription("cajas de carton").remission?.value).toBe("20pct");
    expect(parseDescription("papel blanco").remission?.value).toBe("90pct");
    expect(parseDescription("a black box").remission?.value).toBe("6pct");
  });

  it("reads distance in mm, cm and m", () => {
    expect(parseDescription("caja a 500 mm").distanceMm?.value).toBe(500);
    expect(parseDescription("caja a 40 cm").distanceMm?.value).toBe(400);
    expect(parseDescription("caja a 1.5 m").distanceMm?.value).toBe(1500);
    // Millimetres must win over the bare-metre pattern.
    expect(parseDescription("caja a 250 mm").distanceMm?.value).toBe(250);
  });

  it("marks output polarity as assumed unless the text states it", () => {
    const quiet = parseDescription("caja negra a 500 mm");
    expect(quiet.output.value).toBe("PNP");
    expect(quiet.output.origin).toBe("assumed");

    const stated = parseDescription("caja negra a 500 mm NPN");
    expect(stated.output.value).toBe("NPN");
    expect(stated.output.origin).toBe("extracted");
  });

  it("records an answered value as asked, never as extracted", () => {
    const d = parseDescription("sensor de caja", { remission: "20pct", distanceMm: 400 });
    expect(d.remission?.origin).toBe("asked");
    expect(d.distanceMm?.origin).toBe("asked");
  });

  it("lets the description win over an answer, so stated beats guessed", () => {
    const d = parseDescription("caja negra a 500 mm", { remission: "90pct", distanceMm: 100 });
    expect(d.remission?.value).toBe("6pct");
    expect(d.remission?.origin).toBe("extracted");
    expect(d.distanceMm?.value).toBe(500);
  });

  it("detects the language it answers in", () => {
    expect(parseDescription("necesito detectar cajas en una banda").language).toBe("es");
    expect(parseDescription("I need to detect boxes on a belt").language).toBe("en");
  });
});

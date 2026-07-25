import { describe, expect, it } from "vitest";

import { catalog, toPart } from "@/lib/solver";
import { findEntry } from "@/lib/lookup";

/**
 * The catalogue prints a photograph for most sensing SKUs, and the panels show it
 * next to the dimensional silhouette. These guard the two ways that goes wrong
 * without looking wrong: a card that shows no photo when one exists, and a card
 * that shows a family photo while implying it is the exact variant.
 *
 * The image files are content-addressed (`sick-<hash>.webp`), so a filename can
 * never be asserted literally here — re-running the extractor would change it.
 * What is asserted is the shape and the honesty flags.
 */
describe("product photos", () => {
  it("carries a photo for most sensing SKUs, and never an empty string", () => {
    const withPhoto = catalog.filter((e) => e.image);
    // 691 of 796 at the time of writing; the floor guards against the join
    // silently breaking and every card losing its photo.
    expect(withPhoto.length).toBeGreaterThan(600);
    for (const e of withPhoto) {
      expect(e.image).toMatch(/^sick-[0-9a-f]{12}\.webp$/);
    }
  });

  it("puts the photo on the part the panels actually render", () => {
    const entry = findEntry("1052171");
    expect(entry).toBeDefined();
    const part = toPart(entry!);
    expect(part.photo).toBeDefined();
    expect(part.photo!.src).toBe(entry!.image);
    // The panel prints "p.{page}" beside the photo, so it has to be a printed
    // catalogue page code and never a bare PDF index.
    expect(part.photo!.page).toMatch(/^[B-N]-\d+$/);
  });

  it("leaves the photo off entirely when the catalogue prints none", () => {
    const bare = catalog.find((e) => !e.image);
    expect(bare, "expected at least one SKU with no photo").toBeDefined();
    expect(toPart(bare!).photo).toBeUndefined();
  });

  it("flags a family photo rather than passing it off as the variant", () => {
    const family = catalog.find((e) => e.image && e.imageFamilyPhoto);
    expect(family, "expected at least one family-level photo").toBeDefined();
    expect(toPart(family!).photo!.familyPhoto).toBe(true);

    const exact = catalog.find((e) => e.image && !e.imageFamilyPhoto);
    expect(exact).toBeDefined();
    expect(toPart(exact!).photo!.familyPhoto).toBe(false);
  });
});

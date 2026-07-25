/**
 * Health probe for the consultancy console. The static page reads
 * `model_available` to tell the visitor whether answers are model-reasoned or
 * deterministic-only, so this has to reflect the real credential state.
 */
import { Catalog } from "@no-human/consultancy-engine";
import type { EnrichedProduct } from "@no-human/consultancy-engine";

import rows from "../../../data/consult-catalog.generated.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const catalog = new Catalog(rows as unknown as EnrichedProduct[]);

export function GET(): Response {
  return Response.json({
    ok: true,
    products: catalog.products.length,
    accessories: catalog.accessories.length,
    model_available: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}

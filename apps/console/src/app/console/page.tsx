import { Workspace } from "@/components/Workspace";
import { corpusStats } from "@/data/runs";
import { buildMissRun, solve } from "@/lib/engine";
import { buildCatalogRun } from "@/lib/solver";
import type { InputMode } from "@/lib/types";

/**
 * Deep links carry the demo, and they resolve on the server so the state is on
 * screen at first paint rather than after hydration:
 *   /console?q=QS18VN6LV                 plays the scripted solve
 *   /console?q=QS18VN6LV&t=900           freezes one frame before the challenger kill
 *   /console?q=QS18VN6LV&t=end           straight to the verdict
 *   /console?q=...&mode=describe         the consultant path — returns a question
 *   /console?solve=400                   the real catalogue solve, dark target at 400 mm
 *   /console?solve=400&remission=90pct   same distance, white target
 */
export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    mode?: string;
    t?: string;
    solve?: string;
    remission?: string;
  }>;
}) {
  const { q, mode, t, solve: solveParam, remission } = await searchParams;
  const initialMode: InputMode = mode === "describe" ? "describe" : "part";
  const at = t === "end" ? ("end" as const) : t && Number.isFinite(Number(t)) ? Number(t) : undefined;

  const distanceMm = solveParam ? Number(solveParam) : Number.NaN;
  const catalogRun =
    Number.isFinite(distanceMm) && distanceMm > 0
      ? buildCatalogRun(
          { distanceMm, remission: remission ?? "6pct", output: "PNP" },
          { mode: "describe", raw: `Detección a ${distanceMm} mm` },
          `${distanceMm} mm`,
        )
      : null;

  const input = q ? { mode: initialMode, raw: q } : null;
  const initialRun = catalogRun ?? (input ? (solve(input) ?? buildMissRun(input)) : null);

  return (
    <Workspace
      stats={corpusStats}
      initialRun={initialRun}
      initialMode={catalogRun ? "describe" : initialMode}
      {...(at !== undefined ? { initialAt: at } : {})}
    />
  );
}

import { Workspace } from "@/components/Workspace";
import { corpusStats } from "@/data/runs";
import { buildMissRun, solve } from "@/lib/engine";
import type { InputMode } from "@/lib/types";

/**
 * Deep links carry the demo, and they render on the server so the state is on
 * screen at first paint rather than after hydration:
 *   /?q=QS18VN6LV                    plays the solve from zero
 *   /?q=QS18VN6LV&t=900              freezes just before the challenger kill
 *   /?q=QS18VN6LV&t=end              jumps straight to the verdict
 *   /?q=...&mode=describe            runs the consultant path
 */
export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; mode?: string; t?: string }>;
}) {
  const { q, mode, t } = await searchParams;
  const initialMode: InputMode = mode === "describe" ? "describe" : "part";
  const at = t === "end" ? ("end" as const) : t && Number.isFinite(Number(t)) ? Number(t) : undefined;

  const input = q ? { mode: initialMode, raw: q } : null;
  const initialRun = input ? (solve(input) ?? buildMissRun(input)) : null;

  return (
    <Workspace
      stats={corpusStats}
      initialRun={initialRun}
      initialMode={initialMode}
      {...(at !== undefined ? { initialAt: at } : {})}
    />
  );
}

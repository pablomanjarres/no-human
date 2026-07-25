import { runs } from "@/data/runs";
import type { Citation, Confidence, Dispute, Part, SolveRun } from "@/lib/types";

/**
 * Walks the loaded runs and lifts out the rows the extraction pass did not settle.
 *
 * The corpus index holds 31 open disputes and 64 rows below full confidence. Only
 * the rows belonging to parts a loaded run actually reads can be shown here with
 * their source line attached, so this walk is the honest subset — the board says
 * how many it is showing against how many exist, and never pads the difference.
 */

const partsIn = (run: SolveRun): Part[] => [run.source, ...run.candidates.map((c) => c.part)];

export interface DisputeRow {
  id: string;
  part: Part;
  fieldKey: string;
  field: string;
  unit: string;
  confidence: Confidence;
  dispute: Dispute;
  citation: Citation;
  /** The runs that read this part. Proof the dispute is live, not archived. */
  runIds: string[];
}

export interface FlaggedRow {
  id: string;
  part: Part;
  field: string;
  value: string;
  unit: string;
  confidence: Confidence;
  citation: Citation;
  disputed: boolean;
}

export function collectDisputes(): DisputeRow[] {
  const found = new Map<string, DisputeRow>();

  for (const run of runs) {
    for (const part of partsIn(run)) {
      for (const spec of part.specs) {
        const dispute = spec.dispute;
        if (!dispute) continue;

        const id = `${part.id}::${spec.key}`;
        const seen = found.get(id);
        if (seen) {
          if (!seen.runIds.includes(run.id)) seen.runIds.push(run.id);
          continue;
        }

        found.set(id, {
          id,
          part,
          fieldKey: spec.key,
          field: spec.label,
          unit: spec.unit,
          confidence: spec.confidence,
          dispute,
          citation: spec.citation,
          runIds: [run.id],
        });
      }
    }
  }

  return [...found.values()];
}

const SEVERITY: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function collectFlagged(): FlaggedRow[] {
  const found = new Map<string, FlaggedRow>();

  for (const run of runs) {
    for (const part of partsIn(run)) {
      for (const spec of part.specs) {
        if (spec.confidence === "high") continue;

        const id = `${part.id}::${spec.key}`;
        if (found.has(id)) continue;

        found.set(id, {
          id,
          part,
          field: spec.label,
          value: spec.value,
          unit: spec.unit,
          confidence: spec.confidence,
          citation: spec.citation,
          disputed: Boolean(spec.dispute),
        });
      }
    }
  }

  return [...found.values()].sort((a, b) => SEVERITY[a.confidence] - SEVERITY[b.confidence]);
}

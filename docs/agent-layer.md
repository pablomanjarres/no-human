# The agent layer

**Package:** `packages/agent` (`@no-human/agent`)
**Depends on:** `@no-human/rag` (retrieval + the deterministic solver)

`@no-human/rag` answers _"which SICK parts are worth considering, and where can
each claim be checked?"_. This package is what turns messy human input into that
question, and turns the answer into a defensible recommendation — or an honest
refusal.

---

## 1. The pipeline

```
  input ──▶ Resolver ──▶ SpecConstraints ──▶ retrieval ──▶ solver ──▶ Challenger ──▶ report
           (LLM)          "spec vector"      (@no-human/rag)          (LLM)         or refusal
             │                                                            │
             └── underspecified? emit questions, do NOT guess             └── rank 1 dies ⇒ rank 2 promotes
```

Four ways in, one engine. All of them collapse to the same `SpecConstraints`:

| Input             | Example                                        |
| ----------------- | ---------------------------------------------- |
| Part number       | `QS18VN6LV`                                    |
| Plain description | "rectangular, PNP, sees a box at 40 cm"        |
| Photo of a label  | worn nameplate, half-legible order number      |
| Whole BOM         | CSV, audited row by row                        |

Plus a fifth entry point for the consultant use case: a described _problem_
rather than a part.

---

## 2. Five rules the layer must not break

These are enforced in code, not just asked for in prompts. Each has a test.

### 1. The LLM never picks the part

The Resolver produces **constraints**. The Challenger **attacks** a match.
Between them sits a deterministic solve. An agent may narrow, question, or
reject — never select.

Enforced: the Resolver's structured output schema contains only constraint
fields and questions. If a model response names a SICK order number it is
discarded and the violation is recorded in `rationale`. In consultant mode every
order number the model proposes is resolved against the catalog and dropped if
it does not exist — a model cannot smuggle a part number in from memory.

### 2. Underspecified input returns a question, not a guess

`ResolvedInput.sufficient` gates everything. When it is false the orchestrator
returns `{ kind: "needs_input", questions }` **before** retrieval, before the
solver, before the challenger.

The sufficiency criterion is real code, not model self-report: a run needs a
sensing principle (or category) **and** at least one discriminating quantitative
or electrical constraint. A constraint set that cannot discriminate across 1,776
SKUs does not get to produce a recommendation.

Each question carries a `why` stating how the answer changes the outcome, so it
reads as engineering rather than stalling:

> _Is the box matte black or glossy? A diffuse sensor loses most of its range on
> matte black, which may force background suppression or a retroreflective setup._

### 3. Every claim carries a citation

A spec with no source is reported as unverified, never asserted. Comparison rows
whose value is missing on either side render as `unknown` **and say which side is
missing** — never as a blank that reads like a match.

### 4. Refusal is a first-class success

> _"Closest is W4-3, but you lose the M12 connector and 8 ms of response time."_

`{ kind: "no_equivalent", closest, reason, lost }` is a **successful run**, not an
error path. It is also the demo's safety net: feed something with no clean
equivalent on purpose and the refusal is more convincing than any match.

### 5. Everything is traced

Every decision emits a `TraceEvent`. A step that does not emit is invisible on
the trace panel and therefore untrusted by a judge. The trace is JSON-
serializable and streams to a browser; `replayTrace` re-runs a recorded trace at
a chosen speed, so a rehearsed run is reproducible on stage.

---

## 3. Unknown is not pass

The SICK data is the _summary_ catalog, so most electrical specs are genuinely
unprinted. The solver returns `unknown` for those, and this layer must never
launder an `unknown` into a `pass`.

Concretely:

- Every `unknown` verdict is automatically seeded as an **`unverifiable`
  challenge** — the catalog is silent, so the risk stands unquantified. That
  happens before the model runs and survives a total model failure.
- A recommendation with any `unknown` on a requested or safety-relevant
  constraint **caps at `confidence: "low"`**, regardless of how well it ranked.
- `high` requires every requested constraint verified `pass` **and** no upheld
  `major` challenge.

---

## 4. The Challenger

Adversarial by construction. Its job is to kill the proposed match by hunting
the killer detail: the connector that does not fit, the response time 8 ms
slower, the missing IO-Link, IP69K dropping to IP67, a sensing range that only
just covers the requirement with no margin, a switching output where the
original was analog.

It is prompted to **refute**, and to default to upholding an objection when
uncertain — a skeptical challenger that occasionally kills a viable match is far
cheaper than a credulous one that lets a bad match through.

Challenges come from two sources, both required:

1. **Deterministic seeds** — derived straight from the `SolveResult`. Every
   `unknown` becomes an `unverifiable` challenge; every `fail` becomes an
   automatic upheld `fatal`. Model-independent.
2. **Model-generated** — application-level objections the spec table cannot
   express: mounting, environment, beam geometry, alignment, wiring.

The model does not get the last word on facts we hold: if it asserts a spec value
that contradicts the catalog record, the challenge is downgraded to `refuted`.

`challengeAll` walks candidates in rank order and stops at the first survivor —
which produces the promotion moment (`candidate.promoted`) the demo needs without
paying for challenges nobody reads.

---

## 5. Competitor specs come from data, not memory

For a part we hold real data on, we look its specs up and cite them rather than
asking a model to recall them. A hallucinated competitor spec would poison the
entire comparison, and — unlike a wrong SICK pick — nothing downstream would
catch it.

`competitors.ts` indexes `banner-catalog-dataset/` (62 products) and the
precomputed `banner-to-sick-equivalence/` cross-reference. Lookup normalizes
aggressively (`QS18VN6LV`, `qs18-vn6lv`, `QS18 VN6LV` all resolve) and reports
which kind of match it made, so the caller can be honest about precision. An
unknown part returns `undefined` rather than a fuzzy wrong match; only then does
the model get involved, and the result is marked `specSource: "inferred"`.

Banner's sensing-mode taxonomy maps onto the SICK principle enum:

| Banner                   | SICK principle            |
| ------------------------ | ------------------------- |
| `opposed`                | through-beam              |
| `retroreflective`        | retroreflective           |
| `diffuse`                | diffuse                   |
| `convergent`/`fixed_field` | background-suppression  |
| `ultrasonic`             | ultrasonic                |

---

## 6. Consultant mode

The second use case: an engineer describes a problem and does _not_ know what
they need. The agent behaves like a SICK application engineer, not a search box.

It determines what is missing first — sensing distance, target material, surface
(black/matte/shiny/transparent changes everything for photoelectrics), line
speed, ambient conditions, mounting space, PLC and output type, supply voltage,
budget — and asks before designing.

With enough context it designs a **complete** solution: the sensor plus the
brackets, cables, connectors and interfaces that make it an installation rather
than a part number (accessories are `rowType: "accessory"` in the catalog, and
there are 519 of them). It populates `alternativesConsidered` with what it
rejected and why — a recommendation with no rejected alternatives reads as a
lookup, not engineering judgement — and runs compatibility checks across the
BOM, reporting each as `ok` / `warning` / `unverified`. It never asserts a
compatibility it cannot source.

---

## 7. Layout

```
packages/agent/src/
  types.ts           the contract — read this first
  trace.ts           trace bus, replay, ndjson persistence
  claude.ts          the ONLY Anthropic client wrapper (model, thinking, refusal, tokens)
  competitors.ts     deterministic competitor lookup + constraint derivation
  inputs/
    vision.ts        nameplate photo → part number, with legibility honesty
    bom.ts           tolerant CSV BOM parsing, nothing silently dropped
  resolver.ts        input → SpecConstraints + questions + sufficiency gate
  challenger.ts      adversarial validation, deterministic seeds + model attacks
  orchestrator.ts    the pipeline; emits the trace
  consultant.ts      problem → clarifying questions → full solution design
  report.ts          comparison rows + markdown rendering
  cli.ts             sick-agent migrate | consult | trace replay
```

## 8. Usage

```bash
# Migrate a competitor part, streaming the trace live
node --experimental-strip-types packages/agent/src/cli.ts migrate QS18VN6LV --trace

# Free-text description
node --experimental-strip-types packages/agent/src/cli.ts migrate \
  "rectangular, PNP, sees a box at 40 cm"

# Photo of a nameplate
node --experimental-strip-types packages/agent/src/cli.ts migrate --image ./label.jpg

# Whole BOM, audited row by row
node --experimental-strip-types packages/agent/src/cli.ts migrate --bom ./bom.csv

# Consultant mode
node --experimental-strip-types packages/agent/src/cli.ts consult \
  "I need to detect black boxes on a conveyor" --trace

# Replay a recorded trace on stage
node --experimental-strip-types packages/agent/src/cli.ts trace replay run.ndjson --speed 2
```

Requires `ANTHROPIC_API_KEY`. The retrieval layer underneath does **not** require
a Voyage key — see [`rag-index.md`](./rag-index.md).

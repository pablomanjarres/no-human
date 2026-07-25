# Design directions

One direction shipped, two dropped. Read this before you touch a colour token or
move a column.

## Shipped: Control Cabinet

**Thesis.** The console should look like the inside of the panel the sensor gets
bolted into, not a chat product wearing an industrial skin. Everything on screen
is a measurement, the evidence behind a measurement, or the frame holding those
two apart.

**Anthracite, not black.** RAL 7016 is the paint on real enclosure doors. Pure
black reads as developer tool — terminal, IDE, another AI wrapper. Anthracite
reads as equipment, and it gives five usable greys above the ground, so panels
separate with a seam and a 1px top highlight instead of a shadow. Bolted plates
do not float.

**No green anywhere.** Pass is SICK blue, caution safety yellow, halt vermilion.
The first reason is not aesthetic: red/green is the pairing roughly 6% of the men
in that room cannot separate, and blue/amber/red survives deuteranopia. The
second is that green/red is CI-dashboard grammar — a green check makes "satisfies
a hard constraint" look like "the build passed". Pass in the brand blue means a
judge reads conformance and SICK in one glance, and vermilion gets exactly one
job: something died.

**Type pairing.** Archivo at `wdth 112` for headings — a widened grotesque at
heavy weight reads as a nameplate stamped into metal, not a marketing headline.
IBM Plex Sans for prose, legible at 14px from the back of a room. IBM Plex Mono
for anything an engineer would quote: part numbers, spec values, timestamps, tool
arguments. If you would paste it into an email to a distributor, it is mono. The
split is semantic, so a judge tells evidence from narration without reading
either.

**The constraint rail is the signature.** The claim this product rests on is that
the model never picks the part: agents produce constraints and spec rows, a
deterministic solver matches. The rail is that claim as a widget. Each spec is a
number line — a bracket for the window the constraint requires, a solid tick for
the SICK candidate, a hollow diamond for the part being replaced. A loss becomes
a distance, and thin margin looks thin: the 20 mm of range headroom on the WTB9
is visibly nearly nothing. It reads at four metres, pre-verbally. When the
challenger kills rank 1, the tick slides outside the bracket before the sentence
explaining why has finished rendering. The animation is the argument.

## Rejected: Engineering Document

The app as a spec sheet an engineer signs off. Paper-white, hairline rules, a
title block with revision and preparer, dense tables, citations as numbered
footnotes, verdict as a stamp. Strong for this audience — what an application
engineer hands a customer is a document, and printing it would have been free.

```
+--------------------------------------------------------------+
| EQUIVALENCE REPORT          QS18VN6LV -> WTB9-3N2161   REV A  |
+--------------------------------------------------------------+
| 1  Sensing mode     BGS          BGS           [OK]   [1][4]  |
| 2  Range            400 mm       700 mm        [OK]   [2][5]  |
| 3  Response         1.0 ms       1.5 ms        [DEV]  [2][5]  |
+--------------------------------------------------------------+
| NOTES 1-11        | REFS: Banner 128140 p2, SICK 1052653 p2   |
+--------------------------------------------------------------+
```

It lost on time. A document is a finished artefact: nowhere natural to show five
agents working concurrently, and the refusal reads as an empty form rather than a
decision. We would have been demoing a PDF.

## Rejected: Split Verdict

Drop the three columns. One full-width comparison, source left, candidate right,
rails spanning the gutter so each row is a single continuous measurement. Trace
in a bottom drawer you pull up. Calmer, and the rails get twice the width — our
best asset, given room.

```
+--------------------------------------------------------------+
|  BANNER QS18VN6LV              |            SICK WTB9-3N2161  |
|  400 mm    |---[======o========|=======]---|    700 mm        |
|  1.0 ms    |---[==o===|==x=====]-----------|    1.5 ms        |
|  12 mm     |---[==o======x=====]-----------|    15 mm         |
+--------------------------------------------------------------+
| ^ TRACE  resolver . solver . challenger        11 steps  1.5s |
+--------------------------------------------------------------+
```

It lost because the drawer hides what we are scored on: closed, the presenter
says "it also traces everything" instead of pointing at it. And the promotion
moment — rank 1 dies, rank 2 takes the slot — needs a candidate stack to happen
inside. This layout has no stack.

## The chat question

The brief says do not build a chat window, because chat hides agents. It is
right. But half the users do not know what they need, and eliciting that is a
conversation. The resolution: the consultation column is a thread, and no agent
turn is a bare paragraph. Each carries a `did` block — tool calls made, counts
produced, constraints emitted — so prose captions visible work instead of
substituting for it. Clarifying questions are not free text; they render as
option chips, each stating the effect its answer has on the constraint set
("Range constraint recomputed at 6% remission"). Where the binding constraint is
missing, the solver is never invoked and the thread returns a question with its
reason for asking.

That beats a pure trace, which elicits nothing and is unreadable to the person
who most needs help, and a pure chat, which asks a judge to trust that work
happened. The chip is load-bearing: the user answers, the constraint set visibly
changes, and the thing stops being a chatbot.

## What to say on stage

- "No green here. Blue is pass, yellow caution, red halt — the pairing on SICK
  safety hardware, and the one that survives colour-blindness. Red means
  something was rejected." (Guardrails, in five seconds.)
- "Every row is a number line. The bracket is what the application requires, the
  tick is the SICK part — and that 20 mm of margin is why this says equivalent
  *with losses*." (Grounding; losses quantified on sight.)
- "Rank one scored highest and the challenger just killed it: that range figure
  was quoted against a white card, and this is a black crate. The trace is the
  second agent working while the solver is still ranking." (Parallel agents.)
- "This screen is a refusal. Two option codes appear in no page we hold, so we
  name the closest part, quantify what it costs you, and stop. Nothing here is
  uncited, including the reason we said no." (Refusal.)

## Known gaps

- **Product photography is partial.** Catalogue-backed parts now show the
  photograph printed in the source PDF, next to the drawn housing — 691 of the
  796 sensing SKUs. The remaining 105 print no photo in the catalogue and show
  none, and the three fixture runs in `runs.ts` carry no photo either because
  their part numbers are not catalogue SKUs. Most of those photos depict the
  product *family* rather than the exact variant, so they are labelled as such
  on the image; see `sick-catalog-dataset/README.md`.
- **The corpus is fixtures.** `apps/console/src/data/runs.ts` holds three runs in
  the exact shape the solver emits, so repointing at the extraction swarm is a
  one-file change — but nothing on screen came from a live extraction.
- **Three scripted paths.** Off those inputs there is no graceful degradation.
- **Below 900px it stacks.** A fallback, not a designed experience. Do not demo
  on a phone.
- **Dark only.** No light theme; that would have come from Engineering Document.

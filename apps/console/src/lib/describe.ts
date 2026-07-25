import { buildCatalogRun, REMISSION_FACTOR } from "@/lib/solver";
import type { Constraint, QuestionOption, SolveRun, ThreadMessage, TraceEvent } from "@/lib/types";

/**
 * The Describe lane, actually reading the description.
 *
 * Before this, every description — any language, any target, any distance —
 * returned one scripted run about black boxes on a conveyor, and answering its
 * question ran the solver with `remission: "6pct", output: "PNP"` hard-coded in
 * the component. Typing "sensor de caja" got you a solve derating for a 6% black
 * target you never mentioned, which triples the required range and silently
 * throws away every part that would have worked.
 *
 * So: extract what the text actually states, ask for what it does not, and mark
 * what is assumed. Nothing is invented. The two values that decide the answer —
 * how far, and how dark — are never guessed, because between a 20% carton at
 * 400 mm and a 6% black box at 400 mm sits a different sensor family.
 */

export type Remission = keyof typeof REMISSION_FACTOR;

export interface DescribeAnswers {
  remission?: string;
  distanceMm?: number;
}

export interface Derived {
  language: "es" | "en";
  remission: { value: Remission; origin: Constraint["origin"]; because: string } | null;
  distanceMm: { value: number; origin: Constraint["origin"]; because: string } | null;
  output: { value: "PNP" | "NPN"; origin: Constraint["origin"] };
}

const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/**
 * Target reflectivity, from the words people actually use.
 *
 * Catalogue ranges are quoted against a 90% white card, so this is a ×1, ×2 or
 * ×3 multiplier on the range the application needs — the single highest-leverage
 * value in the whole solve. A word that does not clearly imply one returns null
 * and becomes a question. "Caja" is exactly that case: a carton and a black
 * crate are both boxes and they are two derating tiers apart.
 */
const REMISSION_WORDS: { re: RegExp; value: Remission; because: string }[] = [
  {
    re: /\b(negro|negra|negros|negras|oscuro|oscura|black|dark)\b/,
    value: "6pct",
    because:
      "Stated: a black or dark target. The catalogue quotes against 90% white, so this derates ×3.",
  },
  {
    re: /\b(carton|cartron|cardboard|madera|wood|marron|cafe|brown|gris|grey|gray|mate|matte)\b/,
    value: "20pct",
    because:
      "Stated: a brown, grey or matte target such as carton. Roughly 20% remission, so this derates ×2.",
  },
  {
    re: /\b(blanco|blanca|papel|paper|white|brillante|shiny|espejo|metal|acero|steel)\b/,
    value: "90pct",
    because:
      "Stated: a white or bright target. That is what catalogue ranges are quoted against, so no derating.",
  },
];

/** Distance, in whatever unit it was written. */
function readDistance(text: string): number | null {
  const t = strip(text).replace(",", ".");
  const mm = /(\d+(?:\.\d+)?)\s*(mm|milimetros?)\b/.exec(t);
  if (mm?.[1]) return Math.round(Number(mm[1]));
  const cm = /(\d+(?:\.\d+)?)\s*(cm|centimetros?)\b/.exec(t);
  if (cm?.[1]) return Math.round(Number(cm[1]) * 10);
  const m = /(\d+(?:\.\d+)?)\s*(m|mts|metros?|meters?)\b/.exec(t);
  if (m?.[1]) return Math.round(Number(m[1]) * 1000);
  return null;
}

function detectLanguage(text: string): "es" | "en" {
  if (/[áéíóúñ¿¡]/i.test(text)) return "es";
  const es = strip(text).match(
    /\b(el|la|los|las|un|una|de|del|que|con|por|para|en|es|son|necesito|detectar|cinta|banda|caja|cajas|sobre|desde|hasta)\b/g,
  );
  const en = strip(text).match(
    /\b(the|a|an|of|that|with|for|in|is|are|need|detect|belt|box|boxes|from|to|on)\b/g,
  );
  return (es?.length ?? 0) >= (en?.length ?? 0) ? "es" : "en";
}

export function parseDescription(text: string, answers: DescribeAnswers = {}): Derived {
  const t = strip(text);

  let remission: Derived["remission"] = null;
  for (const w of REMISSION_WORDS) {
    if (w.re.test(t)) {
      remission = { value: w.value, origin: "extracted", because: w.because };
      break;
    }
  }
  if (!remission && answers.remission && answers.remission in REMISSION_FACTOR) {
    remission = {
      value: answers.remission as Remission,
      origin: "asked",
      because: "Answered by the operator. The solver refused to guess it.",
    };
  }

  const stated = readDistance(text);
  let distanceMm: Derived["distanceMm"] = stated
    ? { value: stated, origin: "extracted", because: "Stated in the description." }
    : null;
  if (!distanceMm && answers.distanceMm !== undefined) {
    distanceMm = {
      value: answers.distanceMm,
      origin: "asked",
      because: "Answered by the operator. The solver refused to guess it.",
    };
  }

  // Output polarity is the one value we default rather than ask, because a
  // wrong guess here is caught at wiring time by anyone holding the sensor,
  // and the constraint chip carries the assumption in yellow.
  const npn = /\bnpn\b/.test(t);
  const output: Derived["output"] = /\bpnp\b/.test(t)
    ? { value: "PNP", origin: "extracted" }
    : npn
      ? { value: "NPN", origin: "extracted" }
      : { value: "PNP", origin: "assumed" };

  return { language: detectLanguage(text), remission, distanceMm, output };
}

const COPY = {
  es: {
    targetQ: "¿De qué color o material es el objeto a detectar?",
    targetWhy:
      "El alcance del catálogo se mide contra una placa blanca del 90%. Una caja de cartón consume el doble de ese alcance y una caja negra el triple, así que esta respuesta decide qué familia de sensor puede verla. Adivinarla es exactamente cómo se termina con un sensor que funciona en el banco y falla en la línea.",
    distanceQ: "¿A qué distancia está el sensor del objeto?",
    distanceWhy:
      "Es la restricción que fija el resultado. La diferencia entre 200 mm y 600 mm es la diferencia entre un W4 y un W12 — otra carcasa, otro soporte, otro precio.",
    unknownText:
      "Sin ese dato no hay vector de especificación que resolver, y no voy a inventarlo. Mándame una foto del montaje o el número de parte que estás reemplazando y sigo desde ahí.",
    read: "Leí esto de tu descripción",
    missing: "Falta el dato que decide la respuesta",
  },
  en: {
    targetQ: "What colour or material is the target?",
    targetWhy:
      "Catalogue range is quoted against a 90% white card. A carton eats twice that budget and a black box three times it, so this answer decides which sensor family can see it at all. Guessing it is exactly how you end up with a sensor that works on the bench and misses on the line.",
    distanceQ: "How far is the sensor from the target?",
    distanceWhy:
      "This is the binding constraint. The gap between 200 mm and 600 mm is the gap between a W4 and a W12 — different housing, different bracket, different price.",
    unknownText:
      "Without it there is no spec vector to solve against, and I am not going to invent one. Send a photo of the mounting or the part number you are replacing and I will work from that.",
    read: "What I read from your description",
    missing: "The value that decides the answer is missing",
  },
} as const;

const REMISSION_OPTIONS = (lang: "es" | "en"): QuestionOption[] =>
  lang === "es"
    ? [
        {
          label: "Cartón, madera o mate",
          value: "20pct",
          effect: "≈20% de remisión — el alcance necesario se duplica",
        },
        {
          label: "Negro u oscuro",
          value: "6pct",
          effect: "≈6% de remisión — el alcance necesario se triplica",
        },
        {
          label: "Blanco o brillante",
          value: "90pct",
          effect: "90% — es la referencia del catálogo, sin castigo",
        },
        { label: "No lo sé", value: "unknown", effect: "Pido una foto del objeto en su lugar" },
      ]
    : [
        {
          label: "Carton, wood or matte",
          value: "20pct",
          effect: "≈20% remission — required range doubles",
        },
        { label: "Black or dark", value: "6pct", effect: "≈6% remission — required range triples" },
        {
          label: "White or bright",
          value: "90pct",
          effect: "90% — the catalogue reference, no derating",
        },
        {
          label: "I don't know",
          value: "unknown",
          effect: "I'll ask for a photo of the target instead",
        },
      ];

const DISTANCE_OPTIONS = (lang: "es" | "en"): QuestionOption[] =>
  lang === "es"
    ? [
        {
          label: "Menos de 200 mm",
          value: "200",
          effect: "Abre la familia W4 — la carcasa más pequeña",
        },
        { label: "200 – 400 mm", value: "400", effect: "Familia W9 — la respuesta habitual" },
        {
          label: "400 – 800 mm",
          value: "800",
          effect: "W12 o W16 — hace falta un soporte más ancho",
        },
        { label: "No lo sé", value: "unknown", effect: "Pido una foto del montaje en su lugar" },
      ]
    : [
        { label: "Under 200 mm", value: "200", effect: "Opens the W4 family — smallest housing" },
        { label: "200 – 400 mm", value: "400", effect: "W9 family — the usual answer" },
        { label: "400 – 800 mm", value: "800", effect: "W12 or W16 — wider bracket needed" },
        {
          label: "I don't know",
          value: "unknown",
          effect: "I'll ask for a photo of the mounting instead",
        },
      ];

/** Constraint chips for what we know so far, each carrying where it came from. */
function knownConstraints(d: Derived): Constraint[] {
  const out: Constraint[] = [];
  if (d.remission)
    out.push({
      key: "target_remission",
      label: "Target remission",
      kind: "enum",
      criticality: "hard",
      unit: "—",
      enumValue: d.remission.value,
      display: d.remission.value.replace("pct", "%"),
      origin: d.remission.origin,
      rationale: d.remission.because,
    });
  if (d.distanceMm)
    out.push({
      key: "distance_mm",
      label: "Mounting distance",
      kind: "numeric-min",
      criticality: "hard",
      unit: "mm",
      min: d.distanceMm.value,
      display: `${d.distanceMm.value} mm`,
      origin: d.distanceMm.origin,
      rationale: d.distanceMm.because,
    });
  out.push({
    key: "output_type",
    label: "Output type",
    kind: "enum",
    criticality: "hard",
    unit: "—",
    enumValue: d.output.value,
    display: d.output.value,
    origin: d.output.origin,
    rationale:
      d.output.origin === "assumed"
        ? "ASSUMED sourcing input card — not stated in the description. Confirm against the PLC before ordering."
        : "Stated in the description.",
  });
  return out;
}

/**
 * A description that is still missing a binding value returns a question.
 *
 * `unknown` is a real answer and gets a real response: the run halts and says
 * what it needs. It used to be swallowed by an early return, so the option was
 * on screen and did nothing.
 */
export function buildDescribeRun(
  input: SolveRun["input"],
  answers: DescribeAnswers = {},
  halted?: "remission" | "distance",
): SolveRun {
  const raw = input.raw.trim();
  const d = parseDescription(raw, answers);
  const t = COPY[d.language];
  const constraints = knownConstraints(d);

  const readChips = [
    ...(d.remission ? [`${d.remission.value.replace("pct", "%")} remission`] : []),
    ...(d.distanceMm ? [`${d.distanceMm.value} mm`] : []),
    `${d.output.value}${d.output.origin === "assumed" ? " (assumed)" : ""}`,
  ];

  // Everything the solver needs is on the table — hand it to the real one.
  if (d.remission && d.distanceMm && !halted) {
    return buildCatalogRun(
      { distanceMm: d.distanceMm.value, remission: d.remission.value, output: d.output.value },
      input,
      `${d.distanceMm.value} mm · ${d.remission.value.replace("pct", "%")}`,
      {
        remission: d.remission.origin,
        distance: d.distanceMm.origin,
        output: d.output.origin,
      },
    );
  }

  const missing: "remission" | "distance" | null = halted
    ? null
    : !d.remission
      ? "remission"
      : "distance";

  const trace: TraceEvent[] = [
    {
      id: "d1",
      at: 0,
      agent: "resolver",
      title: "Input classified",
      detail: `Free-text description, ${d.language === "es" ? "Spanish" : "English"}. No part number present.`,
      status: "ok",
      chips: ["mode: describe", `lang: ${d.language}`],
    },
    {
      id: "d2",
      at: 180,
      agent: "resolver",
      title: `${constraints.filter((c) => c.origin !== "assumed").length} constraints read from the description`,
      detail: readChips.length
        ? `${t.read}: ${readChips.join(", ")}.`
        : "Nothing in the description fixes a value the solver can run on.",
      status: "ok",
    },
    {
      id: "d3",
      at: 260,
      agent: "resolver",
      title: halted ? "Operator cannot supply the value" : "Binding constraint missing",
      detail: halted
        ? "Refusing to substitute a default for a value the operator explicitly does not have."
        : missing === "remission"
          ? "Target reflectivity is unknown and multiplies the required range by up to three. Refusing to guess."
          : "Mounting distance is unknown and drives the whole solve. Refusing to guess.",
      status: halted ? "halt" : "warn",
    },
    {
      id: "d4",
      at: 300,
      agent: "resolver",
      title: halted ? "Solver not invoked" : "Question emitted",
      detail: "Solver not invoked. A guess here produces a part that cannot see the target.",
      status: halted ? "halt" : "warn",
    },
  ];

  const opener: ThreadMessage = {
    id: "dm2",
    role: "agent",
    at: 260,
    agent: "resolver",
    text: readChips.length ? `${t.read}: ${readChips.join(", ")}. ${t.missing}.` : `${t.missing}.`,
    did: [
      `${constraints.filter((c) => c.origin === "extracted").length} constraints extracted from the text`,
      "Solver not invoked — insufficient input",
    ],
    chips: readChips,
  };

  const question: ThreadMessage | null = halted
    ? null
    : {
        id: "dm3",
        role: "question",
        at: 300,
        agent: "resolver",
        text: missing === "remission" ? t.targetQ : t.distanceQ,
        why: missing === "remission" ? t.targetWhy : t.distanceWhy,
        options:
          missing === "remission" ? REMISSION_OPTIONS(d.language) : DISTANCE_OPTIONS(d.language),
      };

  const haltMessage: ThreadMessage | null = halted
    ? {
        id: "dm4",
        role: "agent",
        at: 300,
        agent: "resolver",
        tone: "halt",
        text: t.unknownText,
        did: ["Solver not invoked — no spec vector"],
      }
    : null;

  return {
    id: `describe-${raw}-${answers.remission ?? ""}-${answers.distanceMm ?? ""}-${halted ?? ""}`,
    label: "Plain description",
    input,
    source: {
      id: "described-application",
      brand: "Application",
      partNumber: "Described requirement",
      family: "No part number given",
      principle: "Derived from the description",
      blurb:
        "There is no competitor part here — the requirement came from a description. The constraint set is built only from what the description states and what you answer.",
      dims: { l: 32, w: 12, h: 21 },
      form: "rect",
      specs: [],
    },
    constraints,
    candidates: [],
    attacks: [],
    trace,
    thread: [
      { id: "dm1", role: "user", at: 0, text: raw },
      opener,
      ...(question ? [question] : []),
      ...(haltMessage ? [haltMessage] : []),
    ],
    outcome: halted ? "refusal" : "needs-input",
    ...(halted
      ? {
          refusal: {
            headline:
              d.language === "es" ? "Falta el dato que decide." : "The deciding value is missing.",
            closest: "—",
            losses: [
              d.language === "es"
                ? "Sin remisión o distancia no hay vector de especificación que resolver."
                : "Without remission or distance there is no spec vector to solve against.",
              d.language === "es"
                ? "Un valor por defecto aquí produce una parte que no ve el objeto."
                : "A default here produces a part that cannot see the target.",
              t.unknownText,
            ],
          },
        }
      : {}),
    stats: { catalogue: 796, afterConstraints: 0, survived: 0, durationMs: 300 },
  };
}

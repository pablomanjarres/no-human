/**
 * Catalog → retrievable cards.
 *
 * This module turns a {@link Catalog} into {@link RagChunk}s grouped into
 * *documents*, one document per product family. It is pure: no I/O, no network,
 * no clock, no env. Same catalog in, byte-identical chunks out — which is what
 * lets the index artifact be diffed and re-derived.
 *
 * ## Why documents are families
 *
 * Voyage's contextualized-embedding endpoint embeds a document's chunks
 * *together*, so every SKU vector inherits its family's context. That matters
 * because a bare variant row —
 * `GTE6-P4212 · PNP · M8 · ≤ 300 mm` — is nearly meaningless standalone. Sitting
 * in a document whose chunk 0 reads "G6 — diffuse photoelectric sensor, visible
 * red light", the same row becomes retrievable by the words an engineer actually
 * types. So the genuinely *shared, descriptive* material lives on the family
 * card and is deliberately NOT repeated on every SKU card (repeating it would
 * also flatten BM25's IDF and destroy lexical discrimination).
 *
 * ## Why every card is bilingual
 *
 * The catalog is Spanish. The queries are not: they are English descriptions
 * ("retroreflective sensor, PNP, sees a box at 40 cm") or competitor part
 * numbers off a Banner / Keyence / Pepperl+Fuchs datasheet. Lexical search
 * across that gap scores ~zero and dense search degrades badly. So every card
 * carries the **verbatim Spanish** (non-negotiable: `provenance` cites it, and a
 * skeptical judge must be able to find that exact string on the printed page)
 * *plus* a deterministic English gloss and the industry-standard English
 * synonyms a competitor datasheet would use.
 *
 * The gloss is a phrase-substitution pass over a hand-built term map, not a
 * translation model: it is deterministic, auditable, and — critically —
 * **passes unknown fragments through verbatim** rather than dropping them.
 * A term we failed to map degrades to Spanish-only, which is exactly the
 * behavior we want; it never silently deletes a spec.
 *
 * ## What this module must never do
 *
 * Nothing here participates in *choosing* a part. These cards feed similarity
 * search only. The match is decided downstream by the deterministic solver over
 * normalized structured fields. In particular the soft word budget below may
 * drop a low-priority line from a card's *text*; that is safe precisely because
 * the structured `SickProduct` is what the solver reads, never this string.
 */

import type { Catalog, RagChunk, SickFamily, SickProduct } from "../types.js";

// ---------------------------------------------------------------------------
// Document identity
// ---------------------------------------------------------------------------

/**
 * Family key used for SKUs the catalog prints outside any family heading.
 *
 * These are real orderable parts (shared cables, universal mounting plates), so
 * dropping them would silently remove deliverable solution components from the
 * corpus. `families.csv` already rolls them up under this exact literal, so
 * using the same string here makes the family rollup join for free.
 */
export const NO_FAMILY_KEY = "(sin familia)";

/**
 * Stable document id for a family. Chunks sharing this id are embedded together
 * in one contextualized call, so the id must be derivable from a `SickProduct`
 * alone (the embedding layer never re-reads `families.csv`).
 */
export function documentIdFor(section: string, family: string | undefined): string {
  return `family:${section}:${family ?? NO_FAMILY_KEY}`;
}

// ---------------------------------------------------------------------------
// Text normalization used by the glossary (NOT by the emitted Spanish)
// ---------------------------------------------------------------------------

/**
 * Fold a Spanish catalog string into the flat form the term map is keyed on:
 * lowercase, accents stripped, exotic dashes normalized, whitespace collapsed.
 *
 * Accent stripping is what makes the map robust to the catalog's inconsistent
 * casing (`Luz roja visible` appears 69 times, `luz roja visible` 56 times) and
 * to the soft/non-breaking hyphens `pdftotext` leaves behind (`BEF‑W100-A` uses
 * U+2011). The *emitted* Spanish is never normalized — provenance cites it
 * verbatim and it has to survive byte-for-byte.
 */
export function normalizeForGloss(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining diacritics left behind by NFD
    .replace(/[‐-―]/g, "-") // hyphen, non-breaking hyphen, en/em dash
    .replace(/[“”‘’]/g, '"')
    .replace(/[™®]/g, "") // ™ ®
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Structural pre-pass: Spanish patterns that carry a number
// ---------------------------------------------------------------------------

/**
 * Patterns where the English word order differs from Spanish, so a flat phrase
 * map cannot express them. Applied to already-normalized text, before the phrase
 * map, most-specific first.
 *
 * `Conector macho M12 de 4 polos` is the single most common connection string in
 * the catalog (186 SKUs across both casings) and an engineer searching for it
 * types "M12 4-pin male connector" — the number has to migrate to the front.
 */
function applyStructuralRules(text: string): string {
  return (
    text
      // "conector macho M12 de 4 polos" -> "M12 4-pin male connector"
      .replace(
        /\bconector (macho|hembra) (m\d+) de (\d+) (?:polos|pines)\b/g,
        (_m: string, kind: string, code: string, pins: string) =>
          `${code.toUpperCase()} ${pins}-pin ${kind === "macho" ? "male" : "female"} connector`,
      )
      // "1 conector circular M12 de 5 polos" / "conector cilindrico M12 de 4 polos"
      .replace(
        /\bconector (?:circular|cilindrico) (m\d+) de (\d+) (?:polos|pines)\b/g,
        (_m: string, code: string, pins: string) =>
          `${code.toUpperCase()} ${pins}-pin circular connector`,
      )
      // bare "M12 de 4 polos" / "M8 de 3 pines"
      .replace(
        /\b(m\d+) de (\d+) (?:polos|pines)\b/g,
        (_m: string, code: string, pins: string) => `${code.toUpperCase()} ${pins}-pin`,
      )
      // "cable de 3 hilos" -> "3-wire cable"
      .replace(/\bcable de (\d+) hilos\b/g, (_m: string, n: string) => `${n}-wire cable`)
      // leftovers where the count is attached to something else
      .replace(/\bde (\d+) (?:polos|pines)\b/g, (_m: string, n: string) => `${n}-pin`)
      .replace(/\bde (\d+) hilos\b/g, (_m: string, n: string) => `${n}-wire`)
      // "potenciometro, 5 revoluciones" -> "potentiometer, 5 turns"
      .replace(/\b(\d+) revoluciones\b/g, (_m: string, n: string) => `${n} turns`)
      .replace(/\b(\d+) canales\b/g, (_m: string, n: string) => `${n}-channel`)
      .replace(/\b(\d+) orificios\b/g, (_m: string, n: string) => `${n}-hole`)
      // "conector macho M8" with no pin count
      .replace(
        /\bconector macho (m\d+)\b/g,
        (_m: string, code: string) => `${code.toUpperCase()} male connector`,
      )
      .replace(
        /\bconector hembra (m\d+)\b/g,
        (_m: string, code: string) => `${code.toUpperCase()} female connector`,
      )
  );
}

// ---------------------------------------------------------------------------
// The term map
// ---------------------------------------------------------------------------

/**
 * Spanish → English glossary, keyed on {@link normalizeForGloss} output.
 *
 * Built by reading the *actual distinct values* of every categorical column in
 * `products.jsonl` (and the 166 distinct `other_specs` keys), not by guessing at
 * plausible Spanish. Values intentionally include the industry synonym next to
 * the literal translation — `supresion del fondo` glosses to
 * "background suppression BGS" because a Banner or Keyence datasheet says BGS
 * and an engineer types BGS.
 *
 * Longest key wins, and matching is word-boundary anchored, so the composite
 * strings ("fotocelula de deteccion sobre objeto") beat their own substrings
 * ("fotocelula"). Anything unmatched survives verbatim.
 */
export const TERM_MAP: Readonly<Record<string, string>> = {
  // -- catalog sections / device categories ---------------------------------
  fotocelulas: "photoelectric sensors",
  fotocelula: "photoelectric sensor",
  "fotocelulas cilindricas": "cylindrical photoelectric sensors",
  "fotocelula cilindrica": "cylindrical photoelectric sensor",
  "sensores de proximidad": "proximity sensors",
  "sensor de proximidad": "proximity sensor",
  "sensores de distancia": "distance sensors",
  "sensor de distancia": "distance sensor",
  "sensores de registro": "registration contrast sensors",
  "sensor de registro": "registration contrast sensor",
  "sensores de contraste": "contrast sensors",
  "sensor de contraste": "contrast sensor",
  "sensores magneticos para cilindros": "magnetic cylinder sensors",
  "sensores magneticos": "magnetic sensors",
  "sensores de fluidos": "fluid sensors",
  "sensor de fluidos": "fluid sensor",
  "rejillas fotoelectricas": "light grids",
  "rejilla fotoelectrica": "light grid",
  "cortinas fotoelectricas de seguridad": "safety light curtains",
  "cortina fotoelectrica de seguridad": "safety light curtain",
  "interruptores de seguridad": "safety switches",
  "interruptor de seguridad": "safety switch",
  "dispositivos de proteccion optoelectronicos": "optoelectronic protective devices",
  "soluciones de identificacion": "identification barcode reading",
  "soluciones de control de seguridad": "safety control solutions",
  "escaneres laser de seguridad": "safety laser scanners",
  "escaner laser de seguridad": "safety laser scanner",
  "escaneres de codigos de barras": "barcode scanners",
  "escaner de codigos de barras": "barcode scanner",
  "codigos de barras": "barcodes",
  "lector de codigos basado en camara": "camera-based code reader",
  "lectores manuales": "handheld readers",
  "lector individual": "single reader",
  "sensores de fibra optica": "fiber-optic sensors",
  "sensores de horquilla": "fork sensors",
  "sensor de horquilla": "fork sensor",
  "sensores de nivel": "level sensors",
  "sensores de presion": "pressure sensors",
  "sensor de presion": "pressure sensor",
  "sensores de temperatura": "temperature sensors",
  "sensores de caudal": "flow sensors",
  "sensores para cilindros con ranura en c": "C-slot cylinder sensors",
  "sensores para cilindros con ranura en t": "T-slot cylinder sensors",
  "sensor de color": "color sensor",
  "sensor de luminiscencia": "luminescence sensor",
  "sensores de proximidad inductivos": "inductive proximity sensors",
  "sensores de proximidad capacitivos": "capacitive proximity sensors",
  "encoders incrementales": "incremental encoders",
  "encoder incremental": "incremental encoder",
  "encoders absolutos": "absolute encoders",
  "encoder absoluto": "absolute encoder",
  "encoder de cable": "wire draw encoder",
  "reles de seguridad": "safety relays",
  "rele de seguridad": "safety relay",
  "espejo de desviacion": "deflector mirror",
  "sistema de camaras de seguridad": "safety camera system",
  vision: "vision machine vision",
  sensores: "sensors",

  // -- sensing / detection principles ---------------------------------------
  "fotocelula de deteccion sobre objeto": "diffuse photoelectric proximity sensor",
  "deteccion sobre objeto": "diffuse reflective detection",
  "barrera fotoelectrica de reflexion": "retroreflective photoelectric sensor",
  "barrera fotoelectrica de seguridad monohaz": "single-beam safety light barrier",
  "barreras fotoelectricas de seguridad monohaz": "single-beam safety light barriers",
  "barrera fotoelectrica de seguridad multihaz": "multiple-beam safety light barrier",
  "barreras fotoelectricas de seguridad multihaz": "multiple-beam safety light barriers",
  "barrera fotoelectrica": "photoelectric barrier",
  "barrera emisor-receptor": "through-beam photoelectric sensor",
  "barrera emisor receptor": "through-beam photoelectric sensor",
  "sistema unidireccional": "through-beam system",
  "supresion del fondo": "background suppression BGS",
  "supresion del primer plano": "foreground suppression FGS",
  autocolimacion: "autocollimation retroreflective",
  energetica: "energetic diffuse",
  energetico: "energetic diffuse",
  "lente doble": "dual lens",
  "doble lente": "dual lens",
  inductivo: "inductive",
  inductivos: "inductive",
  capacitivo: "capacitive",
  capacitivos: "capacitive",
  ultrasonidos: "ultrasonic",
  "tecnologia de ultrasonidos": "ultrasonic technology",
  magnetico: "magnetic",
  magneticos: "magnetic",
  "deteccion de objetos transparentes": "transparent object detection",
  "deteccion de etiquetas transparentes, opacas o estampadas":
    "transparent, opaque or printed label detection",
  "deteccion de objetos": "object detection",
  "medicion del nivel": "level measurement",
  "supervision de parada mediante la medicion de la tension residual":
    "standstill monitoring by residual voltage measurement",
  "monitorizacion de velocidad y parada segura": "safe speed and standstill monitoring",
  "sin contacto": "non-contact",
  "corto alcance": "short range",
  "medio alcance": "mid range",
  "largo alcance": "long range",
  desplazamiento: "displacement",
  "alta resolucion": "high resolution",

  // -- light source ----------------------------------------------------------
  "luz roja visible": "visible red light",
  "luz laser roja visible de clase 1": "class 1 visible red laser light",
  "luz laser roja visible": "visible red laser light",
  "luz emisora roja": "red emitted light",
  "luz infrarroja": "infrared light",
  "luz roja": "red light",
  infrarrojos: "infrared",
  infrarrojo: "infrared",
  "laser rojo": "red laser",
  "laser infrarrojo": "infrared laser",
  "led rojo, verde, azul": "red green blue RGB LED",
  "fuente de luz rgb": "RGB light source",
  "led blanco": "white LED",
  "led verde": "green LED",
  "led rojo": "red LED",
  blanco: "white",
  rojo: "red",
  verde: "green",
  azul: "blue",
  "clase 1": "class 1",
  "clase 2": "class 2",
  "spot lineal": "line spot",
  "punto de luz": "light spot",
  "tamano del punto de luz": "light spot size",
  "posicion del punto de luz": "light spot position",
  "tipo de luz": "light type",
  "transmisor de luz": "light emitter",
  "longitud de onda": "wavelength",
  "clase de laser": "laser class",

  // -- outputs / switching ---------------------------------------------------
  "salida de conmutacion": "switching output",
  "salidas de conmutacion": "switching outputs",
  "conmutacion en claro/oscuro": "light/dark switching light-on dark-on",
  "conmutacion en claro": "light-on switching",
  "conmutacion en oscuro": "dark-on switching",
  "en claro": "light-on",
  "en oscuro": "dark-on",
  "claro/oscuro programable": "programmable light/dark switching",
  "tipo de conmutacion": "switching type",
  "funcion de salida": "output function",
  "normalmente abierto": "normally open NO",
  "normalmente cerrado": "normally closed NC",
  antivalente: "antivalent complementary",
  "en contrafase": "complementary push-pull",
  programable: "programmable",
  seleccionable: "selectable",
  rele: "relay",
  reles: "relays",
  "conmutador sin contacto": "solid-state contactless switch",
  "salida analogica": "analog output",
  "salida de senales": "signal output",
  "senal de salida": "output signal",
  "salida de emision": "emitter output",
  "salida de alarma": "alarm output",
  "velocidad de salida": "output rate",
  "frecuencia de conmutacion": "switching frequency",
  "distancia de conmutacion": "switching distance",
  "tiempo de respuesta": "response time",
  "sensibilidad de respuesta": "response sensitivity",
  "corriente de salida": "output current",
  "caida de tension": "voltage drop",
  "tension de alimentacion": "supply voltage",
  "tipo de tension": "voltage type",
  "categoria de sobretension": "overvoltage category",
  "caracteristicas electricas": "electrical characteristics",
  "caracteristicas mecanicas": "mechanical characteristics",

  // -- ranges / measurement --------------------------------------------------
  "alcance de deteccion": "sensing range",
  "distancia de deteccion": "sensing distance",
  "distancia de deteccion limite": "limit sensing distance",
  "alcance limite": "limit range",
  alcance: "sensing range",
  "campo de medicion": "measuring range",
  "campos de medicion": "measuring ranges",
  "rango de medicion": "measuring range",
  "frecuencia de medicion": "measuring frequency",
  resolucion: "resolution",
  "impulsos por revolucion": "pulses per revolution ppr",
  precision: "accuracy",
  linealidad: "linearity",
  reproducibilidad: "repeatability",
  histeresis: "hysteresis",
  "distancia de haces": "beam spacing",
  "numero de haces": "number of beams",
  "evaluacion de haces": "beam evaluation",
  "altura del campo de proteccion": "protective field height",
  "magnitud del campo de proteccion": "protective field size",
  "altura de supervision": "monitoring height",
  "eje optico": "optical axis",
  "zona de recepcion": "receiving zone",
  "ancho de horquilla": "fork width",
  "profundidad de horquilla": "fork depth",
  "distancia de activacion asegurada": "assured operating distance",
  "distancia de apagado asegurada": "assured release distance",
  "distancia de encendido asegurada": "assured operating distance",
  "ventana de lectura": "reading window",
  "longitud focal": "focal length",
  enfoque: "focus",
  objetivo: "lens",
  reflexion: "reflectance",
  "iluminacion interna": "internal illumination",

  // -- connection ------------------------------------------------------------
  "conector macho": "male connector",
  "conector hembra": "female connector",
  "conector circular": "circular connector",
  "conector cilindrico": "circular connector",
  "conector acodado": "angled connector",
  "conector de valvula": "valve connector",
  "conexion de bornes": "terminal connection",
  "bornes de muelles": "spring-cage terminals",
  "terminales roscados conectables": "pluggable screw terminals",
  "terminales roscados": "screw terminals",
  "entrada de cable": "cable entry",
  "longitud del cable": "cable length",
  "material del cable": "cable material",
  "tipo de conexion": "connection type",
  "cable de conexion": "connecting cable",
  "cables de conexion": "connecting cables",
  "extremos de cable sueltos": "flying leads",
  "sin apantallar": "unshielded",
  "no apantallado": "unshielded",
  apantallado: "shielded",
  "sin halogenos": "halogen-free",
  "cabezal a": "head A",
  "cabezal b": "head B",
  acodado: "angled",
  recto: "straight",
  semiflexible: "semi-flexible",
  rigido: "rigid",
  "union roscada moleteada": "knurled screw connection",
  racor: "gland",
  conector: "connector",
  "bus de campo, red industrial": "fieldbus industrial network",
  interfaz: "interface",
  "numero de puertos": "number of ports",

  // -- housing / mechanics / protection --------------------------------------
  "grado de proteccion": "enclosure rating ingress protection",
  "material de la carcasa": "housing material",
  "material de la pantalla frontal": "front screen material",
  "diseno de la carcasa": "housing design",
  "forma de la carcasa": "housing shape",
  "diametro de la carcasa": "housing diameter",
  carcasa: "housing",
  "acero inoxidable": "stainless steel",
  "acero galvanizado": "galvanized steel",
  acero: "steel",
  aluminio: "aluminum aluminium",
  "laton niquelado": "nickel-plated brass",
  laton: "brass",
  "fundicion de cinc": "zinc die-cast",
  plastico: "plastic",
  "cristal frontal": "front screen",
  "pantalla frontal": "front screen",
  "tipo de montaje": "mounting type",
  enrasado: "flush mountable",
  "no enrasado": "non-flush mountable",
  "escuadra de fijacion": "mounting bracket",
  "escuadra de proteccion": "protective bracket",
  "soporte de fijacion universal": "universal mounting bracket",
  "soporte de fijacion": "mounting bracket",
  "placa de fijacion": "mounting plate",
  "sistema de montaje en barra": "rod mounting system",
  "barra de montaje": "mounting rod",
  "material de fijacion": "mounting hardware",
  "sistemas de fijacion universales": "universal mounting systems",
  "montaje en pared": "wall mounting",
  "montaje en suelo": "floor mounting",
  "longitud de montaje": "mounting length",
  "fijacion de 2-hole": "2-hole mounting",
  "disposicion de orificios": "hole pattern",
  "orificio del canal": "channel bore",
  atornillable: "screw-mount",
  autoadhesivo: "self-adhesive",
  redondo: "round",
  "triple de precision": "precision triple reflector",
  reflectores: "reflectors",
  "filtro polarizador": "polarizing filter",
  "diseno higienico": "hygienic design",
  higienico: "hygienic",
  higienicas: "hygienic",
  "resistente a productos quimicos": "chemical resistant",
  "lavado a alta presion": "high-pressure washdown",
  "rosca adaptadora": "adapter thread",
  "vastago adaptador": "adapter stem",
  "diametro del eje": "shaft diameter",
  "limite de revoluciones regulable": "adjustable speed limit",
  sobrecarrera: "overtravel",
  junta: "seal",
  calefaccion: "heating",
  "vida util media": "mean service life",
  "fuerza de retencion": "holding force",
  "retencion magnetica": "magnetic holding",
  "longitud de sonda": "probe length",
  "longitud de la sonda": "probe length",
  "diametro de la sonda": "probe diameter",
  "conexion a proceso": "process connection",
  "temperatura de proceso": "process temperature",
  "presion de proceso": "process pressure",
  "tipo de presion": "pressure type",
  "presion relativa": "gauge pressure",
  vacio: "vacuum",

  // -- adjustment / teach ----------------------------------------------------
  ajuste: "adjustment",
  "ajustador mecanico": "mechanical adjuster",
  "ajuste manual": "manual adjustment",
  potenciometro: "potentiometer",
  destornillador: "screwdriver",
  aprendizaje: "teach-in",
  "aprendizaje dinamico": "dynamic teach-in",
  "aprendizaje estatico": "static teach-in",
  "aprendizaje de 2 puntos": "2-point teach-in",
  "boton de aprendizaje": "teach-in button",
  "boton por etapas": "step button",
  "proximidad a la marca": "mark proximity",
  "sin posibilidad de ajuste": "not adjustable",
  "sin fijacion": "no adjustment",
  regulable: "adjustable",
  teclas: "buttons",

  // -- safety-specific -------------------------------------------------------
  seguridad: "safety",
  "clasificacion de seguridad": "safety rating",
  "contactos de apertura forzada": "positively driven NC contacts",
  "contactos de cierre": "NO contacts",
  "contactos de apertura": "NC contacts",
  "numero de contactos": "number of contacts",
  "entradas seguras": "safe inputs",
  "salidas seguras": "safe outputs",
  "entradas no seguras": "non-safe inputs",
  "salidas no seguras": "non-safe outputs",
  "supervision de puertas": "door monitoring",
  "control de bloqueo": "lock control",
  "supervision de bloqueo": "lock monitoring",
  accionador: "actuator",
  codificacion: "coding",
  "equipo en cascada": "cascadable device",
  "unidad de ampliacion": "expansion unit",
  "modulo de e/s": "I/O module",
  "modulos principales": "main modules",
  "modulo de reles": "relay module",
  pasarelas: "gateways",
  pasarela: "gateway",

  // -- long tail found by auditing rendered cards ---------------------------
  // Every entry below fixed a gloss that came out half-Spanish or word-order
  // wrong on a real card. Kept separate so the next audit pass has an obvious
  // place to grow.
  "sensores de distancia de corto alcance": "short-range distance sensors",
  "sensores de distancia de medio alcance": "mid-range distance sensors",
  "sensores de distancia de largo alcance": "long-range distance sensors",
  "sensor de distancia de medio alcance": "mid-range distance sensor",
  "de corto alcance": "short range",
  "de medio alcance": "mid range",
  "de largo alcance": "long range",
  "interruptores de seguridad sin contacto": "non-contact safety switches",
  "interruptor de seguridad sin contacto": "non-contact safety switch",
  "interruptores de seguridad electromecanicos": "electromechanical safety switches",
  "soportes de fijacion y alineacion": "mounting and alignment brackets",
  "soportes de fijacion": "mounting brackets",
  alineacion: "alignment",
  "kit de fijacion": "mounting kit",
  "montura giratoria": "swivel mount",
  montura: "mount",
  orientable: "orientable adjustable",
  unidades: "units",
  unidad: "unit",
  "tolerancia de distancia de deteccion": "sensing distance tolerance",
  tolerancia: "tolerance",
  "no incluido en el volumen de suministro": "not included in scope of delivery",
  "no esta incluida en el volumen de suministro": "not included in scope of delivery",
  "no esta incluido en el volumen de suministro": "not included in scope of delivery",
  "no incluido en el envio": "not included in delivery",
  envio: "delivery",
  transmisor: "transmitter emitter",
  receptor: "receiver",
  emisor: "emitter",
  cilindrico: "cylindrical",
  "escaner lineal": "linear scanner",
  escaner: "scanner",
  escaneres: "scanners",
  lineal: "linear",
  frontal: "front",
  vidrio: "glass",
  bares: "bar",
  // "Sobrecarrera tip." — the catalog abbreviates "típica"; "tipo" is protected
  // by the trailing word-boundary check, so this cannot eat it.
  tip: "typical",
  tipica: "typical",
  tipico: "typical",

  "de acero inoxidable": "stainless steel",
  "de alta resolucion": "high resolution",
  "encoder absoluto de alta resolucion": "high-resolution absolute encoder",
  "resolucion de la salida analogica": "analog output resolution",
  "de reflexion": "reflectance",
  "numero de contactos de apertura forzada": "number of positively driven NC contacts",
  "numero de contactos de cierre": "number of NO contacts",
  "numero de contactos de apertura": "number of NC contacts",
  "medicion del nivel en aplicaciones higienicas": "level measurement in hygienic applications",
  "aplicaciones higienicas": "hygienic applications",
  "escaner de lineas": "line scanner",
  "unidad de base": "base unit",
  "distancia de desactivacion": "release distance",
  "ajuste de precision": "fine adjustment",
  estatico: "static",
  dinamico: "dynamic",
  tipo: "type",
  tipos: "types",
  "numero de": "number of",

  // -- generic labels & connectives -----------------------------------------
  "principio del sensor": "sensor principle",
  "principio de deteccion": "detection principle",
  "volumen de suministro": "scope of delivery",
  "incluido en el volumen de suministro": "included in scope of delivery",
  "ambito de aplicacion": "application area",
  "grupo de accesorios": "accessory group",
  "categoria de accesorio": "accessory category",
  accesorios: "accessories",
  accesorio: "accessory",
  componente: "component",
  "componente del sistema": "system component",
  elemento: "element",
  funcion: "function",
  funciones: "functions",
  "funciones avanzadas": "advanced functions",
  configuracion: "configuration",
  version: "version",
  modelo: "model",
  "modelo de escaner": "scanner model",
  diseno: "design",
  dimensiones: "dimensions",
  categoria: "category",
  pasos: "steps",
  cantidad: "quantity",
  "indicacion de estado": "status indication",
  "indicacion de area limite": "limit area indication",
  "tipo de codigo admitido": "supported code type",
  "resolucion de codigos": "code resolution",
  "resolucion de codigo": "code resolution",
  "resolucion del sensor": "sensor resolution",
  "tamano de etiquetas": "label size",
  "espacios entre etiquetas": "label gaps",
  "material, cabezal": "head material",
  "material, nucleo": "core material",
  "material del cuerpo": "body material",
  "certificado whg": "WHG certificate",
  "apropiado para": "suitable for",
  "apto para": "suitable for",
  "longitud configurable a partir de rollo": "configurable length from roll",
  "con material de fijacion": "with mounting hardware",
  "sin material de fijacion": "without mounting hardware",
  para: "for",
  con: "with",
  sin: "without",
  y: "and",
  o: "or",
  "sin familia": "unassigned family",
};

/** Term-map keys bucketed by first character, longest-first — see {@link glossToEnglish}. */
const TERM_BUCKETS: ReadonlyMap<string, readonly string[]> = (() => {
  const buckets = new Map<string, string[]>();
  for (const key of Object.keys(TERM_MAP)) {
    const head = key[0];
    if (head === undefined) continue;
    const bucket = buckets.get(head);
    if (bucket) bucket.push(key);
    else buckets.set(head, [key]);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => b.length - a.length);
  return buckets;
})();

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[a-z0-9]/.test(ch);

/**
 * Translate a Spanish catalog string to an English gloss, or return `undefined`
 * when nothing in it was translatable.
 *
 * Returning `undefined` (rather than an echo of the input) is what stops every
 * card from carrying `IP 67 — IP 67`; duplicated text is pure BM25 noise and
 * wasted embedding budget. Callers render `ES — EN` only when a gloss exists.
 *
 * Unknown fragments pass through verbatim by construction: the scanner copies
 * any character it cannot start a term match at. A missing map entry therefore
 * degrades a card to Spanish-only — never to a card with a spec deleted.
 */
export function glossToEnglish(text: string): string | undefined {
  const normalized = normalizeForGloss(text);
  if (normalized.length === 0) return undefined;

  const staged = applyStructuralRules(normalized);

  let out = "";
  let i = 0;
  while (i < staged.length) {
    if (!isWordChar(i === 0 ? undefined : staged[i - 1])) {
      const key = matchTermAt(staged, i);
      if (key !== undefined) {
        out += TERM_MAP[key];
        i += key.length;
        continue;
      }
    }
    out += staged[i];
    i += 1;
  }

  const gloss = out.replace(/\s+/g, " ").trim();
  // Unchanged means nothing was translatable (or every match was an identity
  // mapping). Echoing the Spanish back would double every such value in the
  // card text for zero information gain.
  return gloss === normalized ? undefined : gloss;
}

function matchTermAt(text: string, index: number): string | undefined {
  const bucket = TERM_BUCKETS.get(text[index] ?? "");
  if (bucket === undefined) return undefined;
  for (const key of bucket) {
    if (!text.startsWith(key, index)) continue;
    if (isWordChar(text[index + key.length])) continue; // must end on a word boundary
    return key;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Industry synonyms
// ---------------------------------------------------------------------------

/**
 * Concept triggers → the vocabulary a competitor datasheet or a US engineer
 * uses. Keyed on normalized-Spanish substrings (`includes`, not word-boundary,
 * so `inductiv` catches `inductivo`/`inductivos`).
 *
 * These are emitted **once per card**, deduped, rather than inline next to every
 * mention: repeating "photo eye" three times on one card inflates its BM25 term
 * frequency for no informational gain.
 */
const SYNONYM_TRIGGERS: readonly (readonly [string, readonly string[]])[] = [
  ["fotocelul", ["photoelectric sensor", "photo eye", "photoelectric switch"]],
  ["fotoelectric", ["photoelectric"]],
  ["deteccion sobre objeto", ["diffuse mode", "diffuse reflective", "proximity mode"]],
  ["energetica", ["standard diffuse"]],
  ["supresion del fondo", ["background suppression", "BGS"]],
  ["supresion del primer plano", ["foreground suppression", "FGS"]],
  ["autocolimacion", ["retroreflective", "reflex", "autocollimation"]],
  ["de reflexion", ["retroreflective", "reflector mode"]],
  ["emisor-receptor", ["through-beam", "opposed mode", "transmitter receiver pair"]],
  ["unidireccional", ["through-beam"]],
  ["inductiv", ["inductive proximity switch", "prox switch"]],
  ["capacitiv", ["capacitive proximity sensor"]],
  ["ultrasonid", ["ultrasonic"]],
  ["laser", ["laser"]],
  ["encoder", ["rotary encoder", "shaft encoder"]],
  ["codigos de barras", ["barcode reader", "bar code scanner", "auto ident"]],
  ["camara", ["camera", "machine vision"]],
  ["cortina", ["safety light curtain", "light screen"]],
  ["rejilla", ["light grid", "light array"]],
  ["horquilla", ["fork sensor", "slot sensor"]],
  ["contraste", ["contrast sensor", "registration mark sensor"]],
  ["luminiscencia", ["luminescence sensor", "UV mark sensor"]],
  ["magnetic", ["magnetic cylinder sensor", "reed", "magnetoresistive"]],
  ["nivel", ["level sensor", "level probe"]],
  ["presion", ["pressure sensor", "pressure transmitter"]],
  ["temperatura", ["temperature sensor"]],
  ["caudal", ["flow sensor"]],
  ["seguridad", ["safety", "functional safety"]],
  ["acero inoxidable", ["stainless steel", "washdown"]],
  ["io-link", ["IO-Link"]],
  ["fibra optica", ["fiber optic sensor", "fibre optic"]],
  ["transparente", ["clear object detection", "transparent object"]],
];

/**
 * Trigger matchers, anchored at a word START but deliberately open-ended at the
 * end so one entry covers `inductivo`/`inductivos`/`inductiva`.
 *
 * The leading boundary is not optional: without it `presion` fires inside
 * `supresión del fondo` and every background-suppression photoelectric sensor in
 * the catalog picks up "pressure sensor" as a keyword — a false lexical match
 * that would surface photo eyes for pressure-transmitter queries.
 */
const TRIGGER_CACHE = new Map<string, RegExp>();
function triggerMatcher(trigger: string): RegExp {
  const cached = TRIGGER_CACHE.get(trigger);
  if (cached !== undefined) return cached;
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`(?<![a-z0-9])${escaped}`);
  TRIGGER_CACHE.set(trigger, matcher);
  return matcher;
}

/**
 * English keywords implied by a card's Spanish source text.
 *
 * This is the bridge that makes "retroreflective sensor that sees a box at
 * 40 cm" retrieve a `barrera fotoeléctrica de reflexión` row. Order is stable
 * (trigger declaration order) and the list is capped, because a long tail of
 * weakly-related keywords is what turns a keyword line into boilerplate.
 */
export function englishKeywords(spanishText: string, limit = 14): string[] {
  const haystack = normalizeForGloss(spanishText);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [trigger, words] of SYNONYM_TRIGGERS) {
    if (!triggerMatcher(trigger).test(haystack)) continue;
    for (const word of words) {
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unit rendering
// ---------------------------------------------------------------------------

/** Trim float noise without lying about precision. `0.30000000000000004` → `0.3`. */
function num(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

/**
 * Render a millimetre value in every notation an engineer might type.
 *
 * This is load-bearing, not cosmetic. The catalog normalizes everything to mm,
 * but a person describing the job says "sees a box at 40 cm" or "2 metre range".
 * Without the cm/m forms in the card text, the lexical lane cannot match those
 * queries at all and the dense lane has to guess at unit conversion — which it
 * does badly. cm is skipped above a metre (nobody says "600 cm") and µm is added
 * below 1 mm, where displacement sensors actually live.
 */
export function formatMm(value: number): string {
  const alts: string[] = [];
  if (value >= 10 && value < 1000) alts.push(`${num(value / 10)} cm`);
  if (value >= 100) alts.push(`${num(value / 1000)} m`);
  if (value > 0 && value < 1) alts.push(`${num(value * 1000)} µm`);
  return alts.length > 0 ? `${num(value)} mm (${alts.join(" / ")})` : `${num(value)} mm`;
}

/**
 * Render °C with the °F equivalent, because Banner / Keyence US datasheets — the
 * documents a cross-reference query is transcribed from — quote Fahrenheit.
 */
function formatTempC(value: number): string {
  return `${num(value)} °C (${num(Math.round(value * (9 / 5) + 32))} °F)`;
}

function formatHz(value: number): string {
  return value >= 1000 ? `${num(value)} Hz (${num(value / 1000)} kHz)` : `${num(value)} Hz`;
}

function formatMs(value: number): string {
  if (value > 0 && value < 1) return `${num(value)} ms (${num(value * 1000)} µs)`;
  if (value >= 1000) return `${num(value)} ms (${num(value / 1000)} s)`;
  return `${num(value)} ms`;
}

function formatMa(value: number): string {
  return value >= 1000 ? `${num(value)} mA (${num(value / 1000)} A)` : `${num(value)} mA`;
}

/** `min ... max` when both bounds exist, `≤ max` / `≥ min` when only one does. */
function formatRange(
  min: number | undefined,
  max: number | undefined,
  fmt: (v: number) => string,
): string | undefined {
  if (min !== undefined && max !== undefined) {
    return min === max ? fmt(max) : `${fmt(min)} ... ${fmt(max)}`;
  }
  if (max !== undefined) return `≤ ${fmt(max)}`;
  if (min !== undefined) return `≥ ${fmt(min)}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

/**
 * Soft word budget for a SKU card. Cards past this stop accepting further
 * optional lines (lowest priority first). Dense, discriminating text beats long
 * text: BM25 length-normalizes, and a card padded with `other_specs` minutiae
 * ranks *worse* for its own type code. The structured record is untouched, so
 * nothing the solver needs can be lost here.
 */
const SOFT_MAX_SKU_WORDS = 105;
/** Family cards carry the shared context for every SKU below them, so they get more room. */
const SOFT_MAX_FAMILY_WORDS = 170;

const wordCount = (text: string): number =>
  text.trim() === "" ? 0 : text.trim().split(/\s+/).length;

/** Cap a single verbatim value so one 40-word `short_description` cannot eat a whole card. */
function clampWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(" ")} …`;
}

/** `Fotocelulas (Photoelectric sensors)` → `{ es, en }`. The dataset already ships the gloss. */
function splitCategory(category: string): { es: string; en: string | undefined } {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(category);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { es: match[1].trim(), en: match[2].trim() };
  }
  return { es: category.trim(), en: undefined };
}

/** `ES — EN`, collapsing to `ES` when the gloss adds nothing. */
function bilingual(spanish: string | undefined): string | undefined {
  if (spanish === undefined) return undefined;
  const trimmed = spanish.trim();
  if (trimmed === "") return undefined;
  const gloss = glossToEnglish(trimmed);
  if (gloss === undefined) return trimmed;
  return `${trimmed} — ${gloss}`;
}

/** Every Spanish string on a SKU row, for keyword triggering. */
function spanishSurface(product: SickProduct): string {
  return [
    product.productName,
    product.shortDescription,
    product.category,
    product.sensorPrinciple,
    product.detectionPrinciple,
    product.lightType,
    product.connection,
    product.housingMaterial,
    product.scopeOfDelivery,
    product.switchingOutput,
    product.interface,
    ...Object.keys(product.otherSpecs ?? {}),
    ...Object.values(product.otherSpecs ?? {}),
  ]
    .filter((v): v is string => typeof v === "string")
    .join(" ; ");
}

/** Type code with all separators stripped: `GTE6-P4212` → `GTE6P4212`. */
function strippedTypeCode(typeCode: string): string | undefined {
  const stripped = typeCode.replace(/[^A-Za-z0-9]/g, "");
  return stripped.length > 0 && stripped !== typeCode ? stripped : undefined;
}

/**
 * Render one SKU card.
 *
 * The type code leads and is emitted twice — hyphenated and separator-stripped —
 * because BOM rows and label photos arrive in both forms (`GTE6-P4212`,
 * `GTE6P4212`, sometimes `GTE6 P4212`) and a lexical index that only holds one
 * of them misses the exact-part-number query, which is the highest-precision
 * query this system ever receives.
 *
 * Accessory rows are rendered too, not filtered out: a cross-reference answer
 * that omits the bracket and the M8 cordset is not a deliverable solution.
 */
export function renderSkuCard(product: SickProduct): string {
  const { es: categoryEs, en: categoryEn } = splitCategory(product.category);

  const identity: string[] = [];
  if (product.typeCode !== undefined) {
    identity.push(product.typeCode);
    const stripped = strippedTypeCode(product.typeCode);
    if (stripped !== undefined) identity.push(stripped);
  }
  identity.push(product.orderNumber);
  if (product.family !== undefined) {
    identity.push(
      product.subfamily !== undefined ? `${product.family} ${product.subfamily}` : product.family,
    );
  }
  identity.push(product.rowType);
  identity.push(product.sourcePage);

  const required: string[] = [identity.join(" · ")];
  const name = bilingual(product.productName);
  if (name !== undefined) required.push(name);
  // For an accessory the short description IS the product description, so it is
  // never droppable — a bracket card with the description trimmed says nothing.
  if (product.rowType === "accessory") {
    const desc = bilingual(product.shortDescription);
    if (desc !== undefined) required.push(clampWords(desc, 44));
  }
  required.push(categoryEn !== undefined ? `${categoryEs} (${categoryEn})` : categoryEs);

  // Optional lines, highest retrieval value first — see SOFT_MAX_SKU_WORDS.
  const optional: (string | undefined)[] = [];

  const range = formatRange(product.sensingRangeMinMm, product.sensingRangeMaxMm, formatMm);
  if (range !== undefined) optional.push(`sensing range ${range}`);

  const outputs = [bilingual(product.switchingOutput), bilingual(product.outputFunction)].filter(
    (v): v is string => v !== undefined,
  );
  if (outputs.length > 0) optional.push(`output ${outputs.join(" · ")}`);

  const connection = bilingual(product.connection);
  if (connection !== undefined) optional.push(`connection ${connection}`);

  const principles = [
    bilingual(product.sensorPrinciple),
    bilingual(product.detectionPrinciple),
  ].filter((v): v is string => v !== undefined);
  if (principles.length > 0) optional.push(`principle ${principles.join(" · ")}`);

  const light = bilingual(product.lightType);
  if (light !== undefined) optional.push(`light ${light}`);

  const enclosure: string[] = [];
  if (product.enclosureRating !== undefined) enclosure.push(product.enclosureRating.trim());
  const housing = bilingual(product.housingMaterial);
  if (housing !== undefined) enclosure.push(`housing ${housing}`);
  if (enclosure.length > 0) optional.push(`enclosure ${enclosure.join(" · ")}`);

  const supply = formatRange(
    product.supplyVoltageMinV,
    product.supplyVoltageMaxV,
    (v) => `${num(v)} V`,
  );
  if (supply !== undefined) optional.push(`supply voltage ${supply}`);
  if (product.outputCurrentMaxMa !== undefined) {
    optional.push(`output current ≤ ${formatMa(product.outputCurrentMaxMa)}`);
  }
  if (product.responseTimeMs !== undefined) {
    optional.push(`response time ${formatMs(product.responseTimeMs)}`);
  }
  if (product.switchingFrequencyHz !== undefined) {
    optional.push(`switching frequency ${formatHz(product.switchingFrequencyHz)}`);
  }
  const temp = formatRange(product.operatingTempMinC, product.operatingTempMaxC, formatTempC);
  if (temp !== undefined) optional.push(`operating temperature ${temp}`);
  if (product.resolutionValue !== undefined) {
    const unit = product.resolutionUnit !== undefined ? ` ${product.resolutionUnit}` : "";
    optional.push(
      `resolution ${bilingual(`${num(product.resolutionValue)}${unit}`) ?? num(product.resolutionValue)}`,
    );
  }

  if (product.rowType === "product") {
    const desc = bilingual(product.shortDescription);
    if (desc !== undefined) optional.push(clampWords(desc, 30));
  }

  const iface = bilingual(product.interface);
  if (iface !== undefined) optional.push(`interface ${iface}`);

  const spot = bilingual(product.lightSpot);
  if (spot !== undefined) optional.push(`light spot ${spot}`);

  const adjustment = bilingual(product.adjustment);
  if (adjustment !== undefined) optional.push(`adjustment ${adjustment}`);

  const delivery = bilingual(product.scopeOfDelivery);
  if (delivery !== undefined) optional.push(`scope of delivery ${clampWords(delivery, 24)}`);

  for (const [key, value] of Object.entries(product.otherSpecs ?? {}).slice(0, 4)) {
    if (value.trim() === "") continue;
    const glossedKey = glossToEnglish(key);
    const glossedValue = bilingual(value);
    if (glossedValue === undefined) continue;
    const label =
      glossedKey !== undefined && glossedKey !== normalizeForGloss(key)
        ? `${key} / ${glossedKey}`
        : key;
    optional.push(`${label}: ${clampWords(glossedValue, 16)}`);
  }

  if (product.productUrl !== undefined) optional.push(product.productUrl);

  const lines = [...required];
  let words = lines.reduce((sum, line) => sum + wordCount(line), 0);
  for (const line of optional) {
    if (line === undefined) continue;
    if (words >= SOFT_MAX_SKU_WORDS) break;
    lines.push(line);
    words += wordCount(line);
  }

  const keywords = englishKeywords(spanishSurface(product));
  if (keywords.length > 0) lines.push(`keywords: ${keywords.join(", ")}`);

  return lines.join("\n");
}

/** Case-insensitive distinct values, keeping the first spelling seen, most frequent first. */
function topDistinct(values: (string | undefined)[], limit: number): string[] {
  const counts = new Map<string, { display: string; n: number }>();
  for (const value of values) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    const key = normalizeForGloss(trimmed);
    const entry = counts.get(key);
    if (entry) entry.n += 1;
    else counts.set(key, { display: trimmed, n: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((entry) => entry.display);
}

/** `ES — EN; ES — EN` for a small set of distinct values. */
function bilingualList(values: string[]): string | undefined {
  const rendered = values.map((v) => bilingual(v)).filter((v): v is string => v !== undefined);
  return rendered.length > 0 ? rendered.join("; ") : undefined;
}

/**
 * Render the family card — chunk 0 of every document, and the context every SKU
 * vector in that document inherits.
 *
 * This is where the *shared* descriptive material goes: what the family is, what
 * principles and light sources it spans, its full sensing-range envelope, its
 * subfamily prefixes. Deliberately NOT duplicated onto the SKU cards, so the
 * SKU cards stay discriminating from each other while the contextualized
 * embedding still gives every one of them this context for free.
 *
 * `rollup` is the `families.csv` row when one exists; it is optional because the
 * card must still render for a family the rollup does not cover (fail open — a
 * missing rollup must not cost us a whole document).
 */
export function renderFamilyCard(
  family: string,
  section: string,
  category: string,
  products: readonly SickProduct[],
  rollup: SickFamily | undefined,
): string {
  const { es: categoryEs, en: categoryEn } = splitCategory(category);
  const variants = products.filter((p) => p.rowType === "product").length;
  const accessories = products.length - variants;

  const pages = rollup?.pages.length
    ? rollup.pages
    : topDistinct(
        products.map((p) => p.sourcePage),
        8,
      );

  const header = [
    family === NO_FAMILY_KEY
      ? `section ${section} shared parts, no family heading`
      : `${family} family`,
    categoryEn !== undefined ? `${categoryEs} (${categoryEn})` : categoryEs,
    `section ${section}`,
    `pages ${pages.slice(0, 8).join(", ")}`,
    `${variants} variants, ${accessories} accessories`,
  ].join(" · ");

  const required = [header];
  const names = bilingualList(
    topDistinct(
      products.map((p) => p.productName),
      2,
    ),
  );
  if (names !== undefined) required.push(names);

  const optional: (string | undefined)[] = [];

  const subfamilies = topDistinct(
    products.map((p) => p.subfamily),
    8,
  );
  if (subfamilies.length > 0) optional.push(`subfamilies ${subfamilies.join(", ")}`);

  const typePrefixes = topDistinct(
    products.map((p) => {
      const code = p.typeCode;
      if (code === undefined) return undefined;
      const head = /^[A-Za-z]+[0-9]*/.exec(code)?.[0];
      return head !== undefined && head.length >= 2 ? head : undefined;
    }),
    6,
  );
  if (typePrefixes.length > 0) optional.push(`type codes ${typePrefixes.join(", ")}`);

  const principles = bilingualList([
    ...topDistinct(
      products.map((p) => p.sensorPrinciple),
      3,
    ),
    ...topDistinct(
      products.map((p) => p.detectionPrinciple),
      3,
    ),
  ]);
  if (principles !== undefined) optional.push(`principles ${principles}`);

  const lights = bilingualList(
    topDistinct(
      products.map((p) => p.lightType),
      3,
    ),
  );
  if (lights !== undefined) optional.push(`light ${lights}`);

  const mins = products.map((p) => p.sensingRangeMinMm).filter((v): v is number => v !== undefined);
  const maxes = products
    .map((p) => p.sensingRangeMaxMm)
    .filter((v): v is number => v !== undefined);
  if (maxes.length > 0) {
    const low = mins.length > 0 ? Math.min(...mins) : Math.min(...maxes);
    const envelope = formatRange(low, Math.max(...maxes), formatMm);
    if (envelope !== undefined) optional.push(`sensing range across the family ${envelope}`);
  }

  const outputs = topDistinct(
    products.map((p) => p.switchingOutput),
    5,
  );
  if (outputs.length > 0) optional.push(`outputs ${outputs.join(", ")}`);

  const connections = bilingualList(
    topDistinct(
      products.map((p) => p.connection),
      3,
    ),
  );
  if (connections !== undefined) optional.push(`connections ${connections}`);

  const ratings = topDistinct(
    products.map((p) => p.enclosureRating),
    3,
  );
  if (ratings.length > 0) optional.push(`enclosure ${ratings.join(", ")}`);

  const housings = bilingualList(
    topDistinct(
      products.map((p) => p.housingMaterial),
      2,
    ),
  );
  if (housings !== undefined) optional.push(`housing ${housings}`);

  const url = rollup?.productUrl ?? products.find((p) => p.productUrl !== undefined)?.productUrl;
  if (url !== undefined) optional.push(url);

  const lines = [...required];
  let words = lines.reduce((sum, line) => sum + wordCount(line), 0);
  for (const line of optional) {
    if (line === undefined) continue;
    if (words >= SOFT_MAX_FAMILY_WORDS) break;
    lines.push(line);
    words += wordCount(line);
  }

  const keywords = englishKeywords(
    [category, ...products.slice(0, 40).map((p) => spanishSurface(p))].join(" ; "),
    12,
  );
  if (keywords.length > 0) lines.push(`keywords: ${keywords.join(", ")}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Chunk building
// ---------------------------------------------------------------------------

interface DocumentGroup {
  documentId: string;
  family: string;
  section: string;
  category: string;
  products: SickProduct[];
}

/**
 * Build the full chunk corpus.
 *
 * Guarantees the embedding layer depends on:
 * 1. Chunks sharing a `documentId` are **contiguous**.
 * 2. `chunkIndex` runs `0..n-1` within each document.
 * 3. Chunk 0 of every document is its `kind: "family"` card.
 * 4. Every product in the catalog produces exactly one `kind: "sku"` chunk —
 *    including accessories, and including the handful of SKUs the catalog prints
 *    under no family heading (those land in a per-section catch-all document
 *    rather than being dropped).
 *
 * Documents are ordered by section then family, and SKUs within a document by
 * printed page then catalog order, so the output is stable across runs and the
 * contextualized embedding sees variants in the order the page presents them.
 */
export function buildChunks(catalog: Catalog): RagChunk[] {
  const groups = new Map<string, DocumentGroup>();
  const order: string[] = [];

  for (const product of catalog.products) {
    const family = product.family ?? NO_FAMILY_KEY;
    const documentId = documentIdFor(product.section, product.family);
    let group = groups.get(documentId);
    if (group === undefined) {
      group = {
        documentId,
        family,
        section: product.section,
        category: product.category,
        products: [],
      };
      groups.set(documentId, group);
      order.push(documentId);
    }
    group.products.push(product);
  }

  const rollups = new Map<string, SickFamily>();
  for (const rollup of catalog.families) {
    rollups.set(documentIdFor(rollup.section, rollup.family), rollup);
  }

  order.sort((a, b) => {
    const ga = groups.get(a)!;
    const gb = groups.get(b)!;
    if (ga.section !== gb.section) return ga.section < gb.section ? -1 : 1;
    if (ga.family !== gb.family) return ga.family < gb.family ? -1 : 1;
    return 0;
  });

  const chunks: RagChunk[] = [];
  for (const documentId of order) {
    const group = groups.get(documentId)!;
    // Stable sort by printed page, ties broken by the catalog's own row order.
    const products = group.products
      .map((product, index) => ({ product, index }))
      .sort((a, b) =>
        a.product.pdfPage !== b.product.pdfPage
          ? a.product.pdfPage - b.product.pdfPage
          : a.index - b.index,
      )
      .map((entry) => entry.product);

    const anchor = products[0]!;
    chunks.push({
      id: documentId,
      kind: "family",
      documentId,
      chunkIndex: 0,
      text: renderFamilyCard(
        group.family,
        group.section,
        group.category,
        products,
        rollups.get(documentId),
      ),
      ...(group.family !== NO_FAMILY_KEY ? { family: group.family } : {}),
      section: group.section,
      category: group.category,
      sourcePage: anchor.sourcePage,
      pdfPage: anchor.pdfPage,
    });

    products.forEach((product, offset) => {
      chunks.push({
        id: `sku:${product.orderNumber}`,
        kind: "sku",
        documentId,
        chunkIndex: offset + 1,
        text: renderSkuCard(product),
        orderNumber: product.orderNumber,
        ...(product.family !== undefined ? { family: product.family } : {}),
        section: product.section,
        category: product.category,
        rowType: product.rowType,
        sourcePage: product.sourcePage,
        pdfPage: product.pdfPage,
      });
    });
  }

  return chunks;
}

/**
 * Regroup chunks into the documents Voyage's contextualized endpoint expects
 * (one array of chunk texts per document, embedded together).
 *
 * Deliberately tolerant: it groups by `documentId` in first-appearance order and
 * merges a document that somehow appears non-contiguously rather than throwing.
 * The embedding layer runs at index time over the whole catalog; failing the
 * entire build over an ordering surprise would be a far worse outcome than
 * embedding one document's chunks slightly out of page order.
 */
export function groupChunksByDocument(
  chunks: readonly RagChunk[],
): { documentId: string; chunks: RagChunk[] }[] {
  const byId = new Map<string, RagChunk[]>();
  const order: string[] = [];
  for (const chunk of chunks) {
    const bucket = byId.get(chunk.documentId);
    if (bucket) {
      bucket.push(chunk);
    } else {
      byId.set(chunk.documentId, [chunk]);
      order.push(chunk.documentId);
    }
  }
  return order.map((documentId) => ({ documentId, chunks: byId.get(documentId)! }));
}

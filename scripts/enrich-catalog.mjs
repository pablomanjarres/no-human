#!/usr/bin/env node
/**
 * Enrich the extracted SICK catalog into the artifact the consultancy engine consumes.
 *
 * Input:  sick-catalog-dataset/products.jsonl   (faithful extraction, never modified)
 * Output: sick-catalog-dataset/catalog.enriched.json
 *         sick-catalog-dataset/enrichment_report.json
 *
 * Rules honored (see docs/superpowers/specs/2026-07-25-consultancy-tool-design.md):
 *   1. A derived field NEVER overwrites a value stated in the catalog.
 *   2. Every derived field records how it was derived, in `derived_from`.
 *   3. Absence stays absence — nothing is invented to fill a gap.
 *
 * Run: node scripts/enrich-catalog.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATASET = join(ROOT, 'sick-catalog-dataset');

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

/** Catalog section name -> top-level solution class. `category` is 100% populated. */
const SOLUTION_CLASS = {
  'Fotocelulas (Photoelectric sensors)': 'photoelectric',
  'Sensores de fluidos (Fluid sensors)': 'fluid',
  'Dispositivos de proteccion optoelectronicos (Optoelectronic protective devices)':
    'safety_optoelectronic',
  'Sensores de proximidad (Proximity sensors)': 'proximity',
  'Sensores de distancia (Distance sensors)': 'distance',
  'Soluciones de identificacion (Identification)': 'identification',
  'Sensores de registro (Registration/contrast sensors)': 'registration',
  'Interruptores de seguridad (Safety switches)': 'safety_switch',
  Encoders: 'encoder',
  'Sensores magneticos para cilindros (Magnetic cylinder sensors)': 'magnetic_cylinder',
  'Soluciones de control de seguridad sens:Control (Safety control)': 'safety_controller',
  'Rejillas fotoelectricas (Light grids)': 'light_grid',
  'Vision (Vision)': 'vision',
};

/** Solution classes whose recommendation carries a functional-safety obligation. */
const SAFETY_CLASSES = new Set([
  'safety_optoelectronic',
  'safety_switch',
  'safety_controller',
  'light_grid',
]);

/** Verbatim `sensor_principle` -> normalized mode. Same mapping as the Banner equivalence work. */
const PRINCIPLE_TO_MODE = {
  'fotocélula de detección sobre objeto': 'diffuse',
  'barrera fotoeléctrica de reflexión': 'retroreflective',
  'barrera emisor-receptor': 'opposed',
  ultrasonidos: 'ultrasonic',
  'tecnología de ultrasonidos': 'ultrasonic',
  inductivos: 'inductive',
  capacitivos: 'capacitive',
};

/** Protocol tokens worth surfacing, matched against any free-text spec value. */
const PROTOCOL_PATTERNS = [
  [/\bIO-?Link\b/i, 'IO-Link'],
  [/\bSSI\b/i, 'SSI'],
  [/\bTTL\s*\/\s*RS-?422\b/i, 'TTL/RS422'],
  [/\bRS-?422\b/i, 'RS-422'],
  [/\bRS-?232\b/i, 'RS-232'],
  [/\bRS-?485\b/i, 'RS-485'],
  [/\bHTL\b/i, 'HTL'],
  [/\bTTL\b/i, 'TTL'],
  [/4\s*(?:mA)?\s*(?:\.{2,}|…|-|a)\s*20\s*mA/i, '4-20mA'],
  [/\b0\s*V?\s*(?:\.{2,}|…|-|a)\s*10\s*V\b/i, '0-10V'],
  [/\bPROFINET\b/i, 'PROFINET'],
  [/\bPROFIBUS\b/i, 'PROFIBUS'],
  [/\bEtherNet\/IP\b/i, 'EtherNet/IP'],
  [/\bEtherCAT\b/i, 'EtherCAT'],
  [/\bCANopen\b/i, 'CANopen'],
  [/\bDeviceNet\b/i, 'DeviceNet'],
  [/\bModbus\b/i, 'Modbus'],
  [/\bUSB\b/i, 'USB'],
  [/\bEthernet\b/i, 'Ethernet'],
];

// ---------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------

const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => stripAccents(String(s ?? '')).toLowerCase();
const isSet = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/**
 * Parse a number written in Spanish/European convention, where "." groups thousands
 * and "," is the decimal mark. The catalog writes 1020 mm as "1.020 mm" and
 * 0.25 bar as "0,25 bares" — reading either with parseFloat is wrong by 1000x.
 */
function parseEuroNumber(token) {
  if (!isSet(token)) return null;
  let s = String(token).trim().replace(/\+/g, '');
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 -> 1234.56
  } else if (hasComma) {
    s = s.replace(',', '.'); // 0,25 -> 0.25
  } else if (hasDot && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // 1.020 -> 1020 (thousands, not a decimal)
  }
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/** Number token as it appears in the catalog: digits with optional . and , groupings. */
const NUM = String.raw`-?\+?\d[\d.,]*`;

/** "IP 67 (carcasa), IP 65 (eje)" -> {ingress:6, water:7, washdown:false} — takes the best stated. */
function parseIpRating(raw) {
  if (!isSet(raw)) return null;
  const text = String(raw);
  let ingress = null;
  let water = null;
  let washdown = false;
  // IP69K is written both as "IP 69K" and "IP69K"; treat K as water level 9 + washdown.
  for (const m of text.matchAll(/IP\s*(\d|X)\s*(\d|K|X)?\s*(K)?/gi)) {
    const solid = m[1];
    const liquid = m[2];
    if (solid && /\d/.test(solid)) ingress = Math.max(ingress ?? 0, Number(solid));
    if (liquid && /\d/.test(liquid)) water = Math.max(water ?? 0, Number(liquid));
    if ((liquid && /K/i.test(liquid)) || (m[3] && /K/i.test(m[3]))) {
      washdown = true;
      water = Math.max(water ?? 0, 9);
    }
  }
  if (/69\s*K/i.test(text)) washdown = true;
  if (ingress === null && water === null) return null;
  return { ingress, water, washdown };
}

/**
 * Largest millimetre quantity in free text. Takes the max because ranges read
 * "200 mm ... 5.000 mm" and the upper bound is the useful figure.
 */
function parseMm(raw) {
  if (!isSet(raw)) return null;
  const text = String(raw).replace(/\s+/g, ' ');
  const mm = [...text.matchAll(new RegExp(String.raw`(${NUM})\s*mm\b`, 'gi'))]
    .map((m) => parseEuroNumber(m[1]))
    .filter((v) => v !== null);
  if (mm.length) return Math.max(...mm);
  const m = [...text.matchAll(new RegExp(String.raw`(${NUM})\s*m\b`, 'gi'))]
    .map((x) => parseEuroNumber(x[1]))
    .filter((v) => v !== null);
  if (m.length) return Math.max(...m) * 1000;
  return null;
}

/** "-40 ... +80 °C" / "-25°C a 70°C" -> {min,max}. Returns null unless a range is genuinely present. */
function parseTempRange(raw) {
  if (!isSet(raw)) return null;
  const text = String(raw).replace(/\s+/g, ' ');
  const m = text.match(
    new RegExp(
      String.raw`(${NUM})\s*(?:°?\s*C)?\s*(?:\.{2,}|…|—|–|-{1,2}|a|to)\s*(${NUM})\s*°?\s*C`,
      'i',
    ),
  );
  if (!m?.[1] || !m[2]) return null;
  const lo = parseEuroNumber(m[1]);
  const hi = parseEuroNumber(m[2]);
  if (lo === null || hi === null) return null;
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

/** Milliseconds from "Tiempo de respuesta: 1,5 ms" / "500 µs". */
function parseMs(raw) {
  if (!isSet(raw)) return null;
  const text = String(raw);
  let m = text.match(new RegExp(String.raw`(${NUM})\s*ms\b`, 'i'));
  if (m?.[1]) return parseEuroNumber(m[1]);
  m = text.match(new RegExp(String.raw`(${NUM})\s*(?:µs|us|μs)\b`, 'i'));
  const us = m?.[1] ? parseEuroNumber(m[1]) : null;
  return us === null ? null : us / 1000;
}

function extractProtocols(values) {
  const found = new Set();
  for (const v of values) {
    if (!isSet(v)) continue;
    for (const [re, label] of PROTOCOL_PATTERNS) if (re.test(String(v))) found.add(label);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// sensing_mode derivation
// ---------------------------------------------------------------------------

/**
 * Physical detection principle. Prefers the stated `sensor_principle` (362 rows);
 * falls back to name/type-code conventions for the rest.
 * Returns [mode, howItWasDerived] or [null, null].
 */
function deriveSensingMode(p, solutionClass) {
  const stated = norm(p.sensor_principle);
  if (stated) {
    for (const [k, v] of Object.entries(PRINCIPLE_TO_MODE)) {
      if (stated.includes(norm(k))) return [v, `sensor_principle: ${p.sensor_principle}`];
    }
  }

  const name = norm(p.product_name) + ' ' + norm(p.short_description) + ' ' + norm(p.family);
  const type = String(p.type_code ?? '').toUpperCase();
  const hint = (mode, why) => [mode, why];

  if (/ultrasonid/.test(name)) return hint('ultrasonic', 'product_name mentions ultrasonidos');

  switch (solutionClass) {
    case 'photoelectric': {
      if (/emisor-receptor|barrera unidireccional/.test(name))
        return hint('opposed', 'product_name: barrera emisor-receptor');
      if (/reflexion/.test(name)) return hint('retroreflective', 'product_name: reflexión');
      if (/deteccion sobre objeto|difus/.test(name))
        return hint('diffuse', 'product_name: detección sobre objeto');
      // SICK type-code convention: WS/WE = through-beam pair, WL = retro, WT/GT = diffuse.
      if (/^W[SE]\d/.test(type)) return hint('opposed', `type_code prefix ${type.slice(0, 2)}`);
      if (/^WL\d/.test(type)) return hint('retroreflective', 'type_code prefix WL');
      if (/^(WT|GT)/.test(type)) return hint('diffuse', `type_code prefix ${type.slice(0, 2)}`);
      return [null, null];
    }
    case 'proximity': {
      if (/inductiv/.test(name)) return hint('inductive', 'product_name: inductivo');
      if (/capacitiv/.test(name)) return hint('capacitive', 'product_name: capacitivo');
      if (/^(IM|IQ|IME)/.test(type)) return hint('inductive', `type_code prefix ${type.slice(0, 2)}`);
      if (/^CM/.test(type)) return hint('capacitive', 'type_code prefix CM');
      return [null, null];
    }
    case 'registration': {
      if (/horquilla/.test(name)) return hint('fork', 'product_name: sensor de horquilla');
      if (/contraste/.test(name)) return hint('contrast', 'product_name: sensor de contraste');
      if (/luminescen/.test(name)) return hint('luminescence', 'product_name: luminescencia');
      if (/color/.test(name)) return hint('color', 'product_name: color');
      if (/^(WF|WFM)/.test(type)) return hint('fork', `type_code prefix ${type.slice(0, 2)}`);
      if (/^(KT|KTM)/.test(type)) return hint('contrast', `type_code prefix ${type.slice(0, 2)}`);
      return [null, null];
    }
    case 'distance': {
      if (/^(UM|UC)/.test(type)) return hint('ultrasonic', `type_code prefix ${type.slice(0, 2)}`);
      if (/hddm|tiempo de vuelo/.test(name)) return hint('laser_tof', 'HDDM / time-of-flight');
      if (/^(OD)/.test(type)) return hint('laser_triangulation', 'type_code prefix OD');
      if (/^(D[XLST]|DT|DL)/.test(type)) return hint('laser_tof', 'type_code prefix Dx');
      return [null, null];
    }
    case 'identification': {
      if (/camara|basado en camara/.test(name)) return hint('camera', 'product_name: cámara');
      if (/codigos de barras|escaner|lector/.test(name))
        return hint('barcode_laser', 'product_name: escáner de códigos de barras');
      if (/rfid/.test(name)) return hint('rfid', 'product_name: RFID');
      return [null, null];
    }
    case 'encoder': {
      if (/incremental/.test(name)) return hint('encoder_incremental', 'product_name: incremental');
      if (/absolut/.test(name)) return hint('encoder_absolute', 'product_name: absoluto');
      if (/cable/.test(name)) return hint('encoder_wire_draw', 'product_name: encoder de cable');
      return [null, null];
    }
    case 'safety_optoelectronic': {
      if (/cortina/.test(name)) return hint('safety_light_curtain', 'product_name: cortina');
      if (/multihaz/.test(name)) return hint('safety_multibeam', 'product_name: multihaz');
      if (/monohaz/.test(name)) return hint('safety_single_beam', 'product_name: monohaz');
      if (/escaner laser|laser de seguridad/.test(name))
        return hint('safety_laser_scanner', 'product_name: escáner láser de seguridad');
      return [null, null];
    }
    case 'magnetic_cylinder':
      return hint('magnetic', 'category: magnetic cylinder sensors');
    default:
      return [null, null];
  }
}

/** Fluid sensors measure one of four things; the name says which. */
function deriveMeasurand(p, solutionClass) {
  if (solutionClass !== 'fluid') return [null, null];
  const name = norm(p.product_name) + ' ' + norm(p.short_description) + ' ' + norm(p.family);
  if (/nivel/.test(name)) return ['level', 'product_name: nivel'];
  if (/presion/.test(name)) return ['pressure', 'product_name: presión'];
  if (/temperatura/.test(name)) return ['temperature', 'product_name: temperatura'];
  if (/caudal|flujo/.test(name)) return ['flow', 'product_name: caudal'];
  const type = String(p.type_code ?? '').toUpperCase();
  if (/^(LF|UP|MHF)/.test(type)) return ['level', `type_code prefix ${type.slice(0, 2)}`];
  if (/^(PB)/.test(type)) return ['pressure', 'type_code prefix PB'];
  if (/^(TB)/.test(type)) return ['temperature', 'type_code prefix TB'];
  return [null, null];
}

// ---------------------------------------------------------------------------
// other_specs mining: Spanish spec label -> typed field
// ---------------------------------------------------------------------------

const SPEC_MINERS = [
  { key: /^tipo de montaje$/i, field: 'mounting_type', parse: (v) => String(v) },
  { key: /^(carcasa|forma de la carcasa|dise[ñn]o de la carcasa)$/i, field: 'housing_form', parse: (v) => String(v) },
  { key: /^conexi[óo]n a proceso$/i, field: 'process_connection', parse: (v) => String(v) },
  { key: /^longitud de sonda$/i, field: 'probe_length_mm', parse: parseMm },
  { key: /^presi[óo]n de proceso$/i, field: 'process_pressure_raw', parse: (v) => String(v) },
  { key: /^(campo de medici[óo]n|alcance|alcance l[íi]mite)$/i, field: 'measuring_range_raw', parse: (v) => String(v) },
  { key: /^altura del campo de protecci[óo]n$/i, field: 'protective_field_height_mm', parse: parseMm },
  { key: /^n[úu]mero de haces$/i, field: 'beam_count', parse: (v) => { const m = String(v).match(/\d+/); return m ? Number(m[0]) : null; } },
  { key: /^se[ñn]al de salida$/i, field: 'output_signal', parse: (v) => String(v) },
  { key: /^(ancho de horquilla)$/i, field: 'fork_width_mm', parse: parseMm },
  { key: /^(profundidad de horquilla)$/i, field: 'fork_depth_mm', parse: parseMm },
  { key: /^ventana de lectura$/i, field: 'reading_window_raw', parse: (v) => String(v) },
  { key: /^enfoque$/i, field: 'focus', parse: (v) => String(v) },
  { key: /^di[áa]metro del eje$/i, field: 'shaft_diameter_raw', parse: (v) => String(v) },
  { key: /^junta$/i, field: 'seal_material', parse: (v) => String(v) },
];

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

function enrich(p) {
  const derivedFrom = {};
  const solutionClass = SOLUTION_CLASS[p.category] ?? null;
  if (solutionClass) derivedFrom.solution_class = `category: ${p.category}`;

  const out = {
    order_number: p.order_number,
    type_code: p.type_code ?? null,
    family: p.family ?? null,
    subfamily: p.subfamily ?? null,
    row_type: p.row_type,
    category: p.category,
    section: p.section,
    source_page: p.source_page,
    product_url: p.product_url ?? null,
    product_name: p.product_name ?? null,
    short_description: p.short_description ?? null,

    solution_class: solutionClass,
    is_safety_product: solutionClass ? SAFETY_CLASSES.has(solutionClass) : false,

    // stated values, carried through verbatim
    sensing_range_min_mm: p.sensing_range_min_mm ?? null,
    sensing_range_max_mm: p.sensing_range_max_mm ?? null,
    switching_output: p.switching_output ?? null,
    output_function: p.output_function ?? null,
    connection: p.connection ?? null,
    enclosure_rating: p.enclosure_rating ?? null,
    housing_material: p.housing_material ?? null,
    operating_temp_min_c: p.operating_temp_min_c ?? null,
    operating_temp_max_c: p.operating_temp_max_c ?? null,
    resolution_value: p.resolution_value ?? null,
    resolution_unit: p.resolution_unit ?? null,
    interface: p.interface ?? null,
    response_time_ms: p.response_time_ms ?? null,
    supply_voltage_min_v: p.supply_voltage_min_v ?? null,
    supply_voltage_max_v: p.supply_voltage_max_v ?? null,
    sensor_principle: p.sensor_principle ?? null,
    detection_principle: p.detection_principle ?? null,
    light_type: p.light_type ?? null,
    scope_of_delivery: p.scope_of_delivery ?? null,
  };

  // -- sensing mode / measurand ------------------------------------------------
  const [mode, modeWhy] = deriveSensingMode(p, solutionClass);
  out.sensing_mode = mode;
  if (modeWhy) derivedFrom.sensing_mode = modeWhy;

  const [measurand, measurandWhy] = deriveMeasurand(p, solutionClass);
  out.measurand = measurand;
  if (measurandWhy) derivedFrom.measurand = measurandWhy;

  // -- ingress protection ------------------------------------------------------
  const ip = parseIpRating(p.enclosure_rating);
  out.ip_ingress = ip?.ingress ?? null;
  out.ip_water = ip?.water ?? null;
  out.washdown_capable = ip ? ip.washdown : null;
  if (ip) derivedFrom.ip_rating = `enclosure_rating: ${p.enclosure_rating}`;

  // -- other_specs mining ------------------------------------------------------
  const specs = p.other_specs ?? {};
  for (const miner of SPEC_MINERS) out[miner.field] = null;
  for (const [rawKey, rawVal] of Object.entries(specs)) {
    for (const miner of SPEC_MINERS) {
      if (!miner.key.test(rawKey.trim())) continue;
      if (isSet(out[miner.field])) continue; // first stated wins; never overwrite
      const parsed = miner.parse(rawVal);
      if (parsed === null || parsed === undefined || Number.isNaN(parsed)) continue;
      out[miner.field] = parsed;
      derivedFrom[miner.field] = `other_specs["${rawKey}"]: ${rawVal}`;
    }
  }

  // Process temperature is its own range parse.
  for (const [rawKey, rawVal] of Object.entries(specs)) {
    if (!/^temperatura de proceso$/i.test(rawKey.trim())) continue;
    const r = parseTempRange(rawVal);
    if (r) {
      out.process_temp_min_c = r.min;
      out.process_temp_max_c = r.max;
      derivedFrom.process_temp = `other_specs["${rawKey}"]: ${rawVal}`;
    }
  }
  out.process_temp_min_c ??= null;
  out.process_temp_max_c ??= null;

  // Ambient temperature can also hide in other_specs when the mapped column is empty.
  if (out.operating_temp_min_c === null) {
    for (const [rawKey, rawVal] of Object.entries(specs)) {
      if (!/temperatura ambiente|temperatura de servicio|temperatura de funcionamiento/i.test(rawKey))
        continue;
      const r = parseTempRange(rawVal);
      if (r) {
        out.operating_temp_min_c = r.min;
        out.operating_temp_max_c = r.max;
        derivedFrom.operating_temp = `other_specs["${rawKey}"]: ${rawVal}`;
        break;
      }
    }
  }

  // Response time fallback.
  if (out.response_time_ms === null) {
    for (const [rawKey, rawVal] of Object.entries(specs)) {
      if (!/^tiempo de respuesta$/i.test(rawKey.trim())) continue;
      const ms = parseMs(rawVal);
      if (ms !== null) {
        out.response_time_ms = ms;
        derivedFrom.response_time_ms = `other_specs["${rawKey}"]: ${rawVal}`;
        break;
      }
    }
  }

  // Resolution fallback (safety curtains state it as a detectable-object diameter).
  if (!isSet(out.resolution_value)) {
    for (const [rawKey, rawVal] of Object.entries(specs)) {
      if (!/^resoluci[óo]n$/i.test(rawKey.trim())) continue;
      out.resolution_value = String(rawVal);
      derivedFrom.resolution_value = `other_specs["${rawKey}"]: ${rawVal}`;
      break;
    }
  }

  // Safety resolution in mm (finger/hand detection) — drives light-curtain selection.
  //
  // The catalog writes this both as "14 mm" and as a bare "14". A bare number is
  // unambiguously millimetres for a protective device, and failing to read it is
  // not a neutral gap: an unparsed resolution lets a 30 mm hand-detection curtain
  // pass a 14 mm finger-detection requirement as merely "unverified".
  // Scoped to protective devices so encoder resolutions ("16 bits", "1024 ppr")
  // can never be misread as a length.
  if (solutionClass === 'safety_optoelectronic') {
    const bare = /^\s*\d+([.,]\d+)?\s*$/.test(String(out.resolution_value ?? ''))
      ? parseEuroNumber(out.resolution_value)
      : null;
    out.safety_resolution_mm = parseMm(out.resolution_value) ?? bare;
  } else {
    out.safety_resolution_mm = null;
  }
  if (out.safety_resolution_mm !== null)
    derivedFrom.safety_resolution_mm = `resolution_value: ${out.resolution_value}`;

  // Sensing range fallback from mined ranges, for rows where the column was empty.
  if (out.sensing_range_max_mm === null) {
    const cand =
      parseMm(out.measuring_range_raw) ??
      parseMm(specs['Distancia de detección']) ??
      parseMm(specs['Distancia de conmutación Sn']);
    if (cand !== null) {
      out.sensing_range_max_mm = cand;
      derivedFrom.sensing_range_max_mm = 'mined from measuring-range / detection-distance spec';
    }
  }

  // -- protocols ---------------------------------------------------------------
  const protocolSources = [p.interface, out.output_signal, p.connection, ...Object.values(specs)];
  out.protocols = extractProtocols(protocolSources);
  if (out.protocols.length) derivedFrom.protocols = 'matched against interface / señal de salida / other_specs';

  // -- searchable text ---------------------------------------------------------
  out.search_blob = norm(
    [
      p.product_name,
      p.short_description,
      p.family,
      p.subfamily,
      p.type_code,
      p.category,
      p.sensor_principle,
      p.detection_principle,
      p.light_type,
      p.connection,
      ...Object.keys(specs),
      ...Object.values(specs),
    ]
      .filter(isSet)
      .join(' | '),
  );

  out.other_specs = specs;
  out.derived_from = derivedFrom;
  out.low_confidence = p.low_confidence ?? [];
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const raw = readFileSync(join(DATASET, 'products.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const enriched = raw.map(enrich);
const products = enriched.filter((p) => p.row_type === 'product');
const accessories = enriched.filter((p) => p.row_type === 'accessory');

// Link accessories to products by shared family, falling back to shared catalog page.
const accByFamily = new Map();
const accByPage = new Map();
for (const a of accessories) {
  if (a.family) {
    if (!accByFamily.has(a.family)) accByFamily.set(a.family, []);
    accByFamily.get(a.family).push(a.order_number);
  }
  if (!accByPage.has(a.source_page)) accByPage.set(a.source_page, []);
  accByPage.get(a.source_page).push(a.order_number);
}
for (const p of products) {
  const byFamily = (p.family && accByFamily.get(p.family)) || [];
  const byPage = accByPage.get(p.source_page) || [];
  p.accessory_order_numbers = [...new Set([...byFamily, ...byPage])];
}
for (const a of accessories) a.accessory_order_numbers = [];

// -- coverage report ---------------------------------------------------------
const before = (col) => raw.filter((r) => r.row_type === 'product' && isSet(r[col])).length;
const after = (col) =>
  products.filter((r) => {
    const v = r[col];
    return Array.isArray(v) ? v.length > 0 : isSet(v);
  }).length;

const TRACKED = [
  ['sensing_mode', 'sensor_principle'],
  ['sensing_range_max_mm', 'sensing_range_max_mm'],
  ['ip_ingress', 'enclosure_rating'],
  ['protocols', 'interface'],
  ['mounting_type', null],
  ['housing_form', null],
  ['process_connection', null],
  ['process_temp_min_c', null],
  ['operating_temp_min_c', 'operating_temp_min_c'],
  ['protective_field_height_mm', null],
  ['measuring_range_raw', null],
  ['response_time_ms', 'response_time_ms'],
  ['resolution_value', 'resolution_value'],
  ['measurand', null],
  ['solution_class', null],
];

const n = products.length;
const coverage = TRACKED.map(([field, source]) => {
  const b = source ? before(source) : 0;
  const a = after(field);
  return {
    field,
    baseline_field: source,
    before: b,
    after: a,
    before_pct: Number(((100 * b) / n).toFixed(1)),
    after_pct: Number(((100 * a) / n).toFixed(1)),
    lift: a - b,
  };
});

const report = {
  generated_from: 'sick-catalog-dataset/products.jsonl',
  total_rows: enriched.length,
  products: n,
  accessories: accessories.length,
  solution_classes: Object.fromEntries(
    Object.entries(
      products.reduce((acc, p) => {
        const k = p.solution_class ?? 'unclassified';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  ),
  sensing_modes: Object.fromEntries(
    Object.entries(
      products.reduce((acc, p) => {
        if (!p.sensing_mode) return acc;
        acc[p.sensing_mode] = (acc[p.sensing_mode] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  ),
  safety_products: products.filter((p) => p.is_safety_product).length,
  coverage,
};

writeFileSync(join(DATASET, 'catalog.enriched.json'), JSON.stringify(enriched));
writeFileSync(join(DATASET, 'enrichment_report.json'), JSON.stringify(report, null, 2) + '\n');

console.log(`enriched ${enriched.length} rows (${n} products, ${accessories.length} accessories)`);
console.log('\nfield                        before        after      lift');
console.log('-'.repeat(62));
for (const c of coverage) {
  const b = c.baseline_field ? `${c.before} (${c.before_pct}%)` : '—';
  console.log(
    `${c.field.padEnd(28)}${b.padEnd(14)}${`${c.after} (${c.after_pct}%)`.padEnd(14)}${c.lift > 0 ? '+' + c.lift : ''}`,
  );
}
console.log('\nsensing modes:', JSON.stringify(report.sensing_modes));
console.log('unclassified solution_class:', report.solution_classes.unclassified ?? 0);

/**
 * Every fixture below is a real row copied out of
 * `sick-catalog-dataset/products.jsonl`, keyed by its 7-digit order number and
 * annotated with the printed catalog page it came from, so a skeptical reader
 * can open the PDF and check the expectation by hand. `provenance` and
 * `otherSpecs` are the only fields dropped — `normalizeSpec` never reads them.
 *
 * The assertions that matter most are the negative ones: a spec the catalog does
 * not state must come back *absent*, not guessed. Those are grouped under
 * "honest unknowns".
 */

import { describe, expect, it } from "vitest";

import type { SickProduct } from "../types.js";
import { normalizeAll, normalizeSpec } from "./normalize.js";

// ---------------------------------------------------------------------------
// Real catalog rows
// ---------------------------------------------------------------------------

/** B-16 · G6 diffuse photoelectric, PNP, M8 4-pin. */
const P1051781: SickProduct = {
  orderNumber: "1051781",
  typeCode: "GTE6-P4212",
  family: "G6",
  subfamily: "GTE6",
  rowType: "product",
  sourcePage: "B-16",
  pdfPage: 15,
  category: "Fotocelulas (Photoelectric sensors)",
  productName: "Fotocélula de detección sobre objeto, luz roja visible",
  productUrl: "www.mysick.com/es/G6",
  sensingRangeMaxMm: 300,
  switchingOutput: "PNP",
  outputFunction: "conmutación en claro/oscuro",
  connection: "Conector macho M8 de 4 polos",
  scopeOfDelivery: "Escuadra de fijación de acero inoxidable (1.4301/304) BEF‑W100-A",
  sensorPrinciple: "fotocélula de detección sobre objeto",
  detectionPrinciple: "energética",
  lightType: "luz roja visible",
  lightSpot: "Ø 7 mm (90 mm)",
  adjustment: "ajustador mecánico, 5 revoluciones",
  lowConfidence: [
    "product_name",
    "output_function",
    "sensor_principle",
    "detection_principle",
    "light_type",
    "light_spot",
    "adjustment",
  ],
  section: "B",
  occurrences: 1,
  alsoOnPages: [],
};

/** H-162 · DS35 laser distance sensor — push-pull + IO-Link, footnote "8)". */
const P1057654: SickProduct = {
  orderNumber: "1057654",
  typeCode: "DS35-B15521",
  family: "Dx35",
  subfamily: "DS35",
  rowType: "product",
  sourcePage: "H-162",
  pdfPage: 161,
  category: "Sensores de distancia (Distance sensors)",
  productName: "Sensores de distancia de medio alcance",
  productUrl: "www.mysick.com/es/Dx35",
  sensingRangeMinMm: 50,
  sensingRangeMaxMm: 12000,
  switchingOutput: "2 x en contrafase: PNP/ NPN (100 mA), IO-Link 8)",
  lightType: "Láser rojo, clase 1",
  lowConfidence: ["product_name", "sensing_range_min_mm", "sensing_range_max_mm"],
  section: "H",
  occurrences: 1,
  alsoOnPages: [],
};

/** H-162 · DT35 — same page, but the output count is "1 x / 2 x": ambiguous. */
const P1057651: SickProduct = {
  orderNumber: "1057651",
  typeCode: "DT35-B15551",
  family: "Dx35",
  subfamily: "DT35",
  rowType: "product",
  sourcePage: "H-162",
  pdfPage: 161,
  category: "Sensores de distancia (Distance sensors)",
  productName: "Sensores de distancia de medio alcance",
  productUrl: "www.mysick.com/es/Dx35",
  sensingRangeMinMm: 50,
  sensingRangeMaxMm: 12000,
  switchingOutput: "1 x / 2 x en contrafase: PNP/ NPN (100 mA), IO-Link 3)",
  lightType: "Láser rojo, clase 1",
  lowConfidence: ["product_name", "sensing_range_min_mm", "sensing_range_max_mm"],
  section: "H",
  occurrences: 1,
  alsoOnPages: [],
};

/** H-156 · OD Mini — selectable PNP/NPN, aluminium housing with a PPSU lens. */
const P6052308: SickProduct = {
  orderNumber: "6052308",
  typeCode: "OD1-B035C15Q14",
  family: "OD Mini",
  subfamily: "OD1",
  rowType: "product",
  sourcePage: "H-156",
  pdfPage: 155,
  category: "Sensores de distancia (Distance sensors)",
  productName: "Sensores de distancia de corto alcance (desplazamiento)",
  productUrl: "www.mysick.com/es/OD_Mini",
  sensingRangeMinMm: 20,
  sensingRangeMaxMm: 50,
  switchingOutput: "1 x PNP/NPN, seleccionable",
  connection: "Conector macho M8 de 4 polos",
  housingMaterial: "Carcasa de aluminio con lente PPSU",
  lowConfidence: ["product_name"],
  section: "H",
  occurrences: 1,
  alsoOnPages: [],
};

/** F-124 · UP56 level sensor — one PNP switch plus an analog 4…20 mA output. */
const P6039866: SickProduct = {
  orderNumber: "6039866",
  typeCode: "UP56-214178",
  family: "UP56",
  subfamily: "UP56-214",
  rowType: "product",
  sourcePage: "F-124",
  pdfPage: 123,
  category: "Sensores de fluidos (Fluid sensors)",
  productName: "Sensores de nivel",
  sensingRangeMinMm: 350,
  sensingRangeMaxMm: 3400,
  switchingOutput: "1 PNP + 4 mA ... 20 mA / 0 V ... 10 V",
  connection: "1 conector circular M12 de 5 polos",
  enclosureRating: "IP 67",
  housingMaterial: "PVDF, PBT, TPU",
  lowConfidence: ["product_name", "sensing_range_min_mm", "sensing_range_max_mm"],
  section: "F",
  occurrences: 1,
  alsoOnPages: [],
};

/** B-40 · G10 with a relay output and a bare 5-wire cable. */
const P1064686: SickProduct = {
  orderNumber: "1064686",
  typeCode: "GTB10-R3811",
  family: "G10",
  subfamily: "GTB10",
  rowType: "product",
  sourcePage: "B-40",
  pdfPage: 39,
  category: "Fotocelulas (Photoelectric sensors)",
  productName: "fotocélula de detección sobre objeto",
  productUrl: "www.mysick.com/es/G10",
  sensingRangeMinMm: 20,
  sensingRangeMaxMm: 950,
  switchingOutput: "Relé",
  connection: "Cable de 5 hilos, 2 m, PVC",
  sensorPrinciple: "fotocélula de detección sobre objeto",
  detectionPrinciple: "supresión del fondo",
  lightType: "Luz roja visible",
  lightSpot: "Ø 8 mm (700 mm)",
  adjustment: "potenciómetro, 5 revoluciones",
  lowConfidence: ["product_name", "sensor_principle", "detection_principle", "adjustment"],
  section: "B",
  occurrences: 1,
  alsoOnPages: [],
};

/** F-121 · LFV200 — "Conmutador sin contacto": polarity never stated. */
const P6036371: SickProduct = {
  orderNumber: "6036371",
  typeCode: "LFV200-XXTGBCPV",
  family: "LFV200",
  rowType: "product",
  sourcePage: "F-121",
  pdfPage: 120,
  category: "Sensores de fluidos (Fluid sensors)",
  productName: "Sensores de nivel",
  switchingOutput: "Conmutador sin contacto",
  connection: "Conector de válvula DIN 43650",
  enclosureRating: "IP 65",
  operatingTempMinC: -40,
  operatingTempMaxC: 150,
  housingMaterial: "acero inoxidable 1.4404, PEI",
  lowConfidence: ["product_name", "Certificado WHG"],
  section: "F",
  occurrences: 1,
  alsoOnPages: [],
};

/** F-116 · LFP Inox — "IP 67 e IP 69K", housing given only as EN steel no. 1.4305. */
const P1052069: SickProduct = {
  orderNumber: "1052069",
  typeCode: "LFP0400-G1NMB",
  family: "LFP Inox",
  subfamily: "LFP",
  rowType: "product",
  sourcePage: "F-116",
  pdfPage: 115,
  category: "Sensores de fluidos (Fluid sensors)",
  productName: "Medición del nivel en aplicaciones higiénicas",
  productUrl: "www.mysick.com/es/LFP_Inox",
  enclosureRating: "IP 67 e IP 69K",
  connection: "1 conector circular M12 de 5 polos",
  housingMaterial: "1.4305",
  lowConfidence: ["product_name", "enclosure_rating", "Diseño de la carcasa"],
  section: "F",
  occurrences: 1,
  alsoOnPages: [],
};

/** B-32 · PLH25 reflector — an accessory filed under the photoelectric section. */
const P2063403: SickProduct = {
  orderNumber: "2063403",
  typeCode: "PLH25-M12",
  family: "W4S-3",
  rowType: "accessory",
  sourcePage: "B-32",
  pdfPage: 31,
  category: "Fotocelulas (Photoelectric sensors)",
  shortDescription:
    "Reflector de acero inoxidable, diseño higiénico, resistente a productos químicos, grado de protección IP 69K, rosca adaptadora M12, 25 mm x 25 mm, acero inoxidable V4A (1.4404, 316L), rosca adaptadora M12",
  enclosureRating: "IP 69K",
  section: "B",
  occurrences: 2,
  alsoOnPages: ["B-39"],
};

/** N-233 · a USB programming device filed under Encoders. Not an encoder. */
const P1036616: SickProduct = {
  orderNumber: "1036616",
  typeCode: "PGT-08-S",
  family: "DFS60",
  rowType: "accessory",
  sourcePage: "N-233",
  pdfPage: 232,
  category: "Encoders",
  shortDescription:
    "Dispositivo de programación USB, para encoders SICK programables AFS60, AFM60, DFS60, VFS60, DFV60 y encoder de cable con encoders programables.",
  section: "N",
  occurrences: 2,
  alsoOnPages: ["N-237"],
};

/** N-232 · DFS60 incremental encoder, M12 8-pin. */
const P1036726: SickProduct = {
  orderNumber: "1036726",
  typeCode: "DFS60A-S4PC65536",
  family: "DFS60",
  rowType: "product",
  sourcePage: "N-232",
  pdfPage: 231,
  category: "Encoders",
  productName: "Encoders incrementales",
  productUrl: "www.mysick.com/es/DFS60",
  resolutionValue: 65536,
  resolutionUnit: "impulsos por revolución",
  interface: "TTL/HTL programable",
  connection: "conector macho M12 de 8 polos, radial",
  lowConfidence: ["product_name", "resolution_unit"],
  section: "N",
  occurrences: 1,
  alsoOnPages: [],
};

/** N-236 · AFS60 — two IP ratings for two parts of the same device. */
const P1037484: SickProduct = {
  orderNumber: "1037484",
  typeCode: "AFS60B-S4PC032768",
  family: "AFS/AFM60 SSI",
  subfamily: "AFS60",
  rowType: "product",
  sourcePage: "N-236",
  pdfPage: 235,
  category: "Encoders",
  productName: "Encoder absoluto de alta resolución",
  productUrl: "www.mysick.com/es/AFS_AFM60_SSI",
  supplyVoltageMinV: 4.5,
  supplyVoltageMaxV: 32,
  connection: "conector macho M12 de 8 polos, radial",
  interface: "SSI/Gray, programable",
  enclosureRating: "IP 67 (carcasa), IP 65 (eje)",
  operatingTempMinC: -30,
  operatingTempMaxC: 100,
  lowConfidence: [
    "product_name",
    "enclosure_rating",
    "operating_temp_min_c",
    "operating_temp_max_c",
  ],
  section: "N",
  occurrences: 1,
  alsoOnPages: [],
};

/** F-126 · MHF15 — IP cell that also cites the standards (EN 60529 / EN 40050). */
const P1052237: SickProduct = {
  orderNumber: "1052237",
  typeCode: "MHF15-21NG1PSM",
  family: "MHF15",
  rowType: "product",
  sourcePage: "F-126",
  pdfPage: 125,
  category: "Sensores de fluidos (Fluid sensors)",
  productName: "Sensores de nivel",
  productUrl: "www.mysick.com/es/MHF15",
  operatingTempMinC: -25,
  operatingTempMaxC: 55,
  switchingOutput: "1 PNP",
  connection: "1 conector circular M12 de 4 polos",
  enclosureRating: "IP 67: EN 60529, IP 69K: EN 40050",
  housingMaterial: "acero inoxidable 1.4404",
  lowConfidence: ["product_name", "switching_output"],
  section: "F",
  occurrences: 1,
  alsoOnPages: [],
};

/** C-84 · IQ40 — terminal box with an M20 cable gland, not an M20 connector. */
const P6025815: SickProduct = {
  orderNumber: "6025815",
  typeCode: "IQ40-20NPP-KK1",
  family: "IQ Standard",
  subfamily: "IQ40",
  rowType: "product",
  sourcePage: "C-84",
  pdfPage: 83,
  category: "Sensores de proximidad (Proximity sensors)",
  productName: "Sensores de proximidad inductivos",
  switchingOutput: "PNP",
  outputFunction: "Antivalente",
  connection: "Conexión de bornes con racor M20",
  lowConfidence: ["product_name"],
  section: "C",
  occurrences: 1,
  alsoOnPages: [],
};

/** L-207 · i16S safety switch with three M20 cable entries. */
const P6025063: SickProduct = {
  orderNumber: "6025063",
  typeCode: "i16-SA203",
  family: "i16S",
  rowType: "product",
  sourcePage: "L-207",
  pdfPage: 206,
  category: "Interruptores de seguridad (Safety switches)",
  productName: "Interruptores de seguridad electromecánicos",
  productUrl: "www.mysick.com/es/i16S",
  connection: "Entrada de cable, 3 x M20",
  enclosureRating: "IP 67",
  lowConfidence: ["product_name", "enclosure_rating"],
  section: "L",
  occurrences: 1,
  alsoOnPages: [],
};

/** G-141 · KT5RG contrast sensor — bicolour red/green LED. */
const P1027393: SickProduct = {
  orderNumber: "1027393",
  typeCode: "KT5RG-2P1116",
  family: "KT5",
  subfamily: "KT5RG",
  rowType: "product",
  sourcePage: "G-141",
  pdfPage: 140,
  category: "Sensores de registro (Registration/contrast sensors)",
  productName: "Sensor de contraste KT5",
  productUrl: "www.mysick.com/es/KT5",
  lightType: "LED rojo, verde",
  adjustment: "Aprendizaje de 2 puntos estático",
  switchingOutput: "PNP",
  lightSpot: "1,2 mm x 4,2 mm",
  sensingRangeMaxMm: 10,
  switchingFrequencyHz: 10000,
  lowConfidence: ["product_name", "switching_frequency_hz", "other_specs"],
  section: "G",
  occurrences: 1,
  alsoOnPages: [],
};

/** G-139 · KTM Inox — RGB LED, stainless 316L, M12 pigtail. */
const P1052956: SickProduct = {
  orderNumber: "1052956",
  typeCode: "KTM-WP1A182V",
  family: "KTM",
  subfamily: "KTM Inox",
  rowType: "product",
  sourcePage: "G-139",
  pdfPage: 138,
  category: "Sensores de registro (Registration/contrast sensors)",
  switchingOutput: "PNP",
  connection: "Cable con conector macho M12 de 4 polos",
  adjustment: "Aprendizaje de 2 puntos estático/dinámico + proximidad a la marca",
  lightType: "LED rojo, verde, azul",
  lightSpot: "1,5 mm x 6,5 mm",
  housingMaterial: "acero inoxidable 316L",
  responseTimeMs: 0.035,
  section: "G",
  occurrences: 1,
  alsoOnPages: [],
};

/** B-50 · WTF11-2 — foreground suppression, light type printed as a bare "LED". */
const P1041380: SickProduct = {
  orderNumber: "1041380",
  typeCode: "WTF11-2P2431",
  family: "W11-2",
  subfamily: "WTF11-2",
  rowType: "product",
  sourcePage: "B-50",
  pdfPage: 49,
  category: "Fotocelulas (Photoelectric sensors)",
  productName: "Fotocélula de detección sobre objeto, supresión del primer plano",
  sensingRangeMinMm: 35,
  sensingRangeMaxMm: 350,
  switchingOutput: "PNP",
  outputFunction: "Conmutación en claro/oscuro",
  connection: "Conector macho M12 de 4 polos",
  sensorPrinciple: "fotocélula de detección sobre objeto",
  detectionPrinciple: "supresión del primer plano",
  lightType: "LED",
  lightSpot: "Ø 6 mm (200 mm)",
  adjustment: "Potenciómetro, 5 revoluciones",
  lowConfidence: ["sensor_principle", "detection_principle", "light_type", "light_spot"],
  section: "B",
  occurrences: 1,
  alsoOnPages: [],
};

/** J-179 · Inspector PIM60-LUT — UV illumination. */
const P1062409: SickProduct = {
  orderNumber: "1062409",
  typeCode: "VSPM-6F2313",
  family: "Inspector PIM series",
  rowType: "product",
  sourcePage: "J-179",
  pdfPage: 178,
  category: "Vision (Vision)",
  productName: "Inspector PIM60-LUT",
  lightType: "UV",
  lowConfidence: ["light_type"],
  section: "J",
  occurrences: 1,
  alsoOnPages: [],
};

/** C-76 · IME08 — connection cell reads "M8 de 3 pines" and is low-confidence. */
const P1040869: SickProduct = {
  orderNumber: "1040869",
  typeCode: "IME08-02BPSZT0K",
  family: "IM Standard",
  subfamily: "IME08",
  rowType: "product",
  sourcePage: "C-76",
  pdfPage: 75,
  category: "Sensores de proximidad (Proximity sensors)",
  productName: "Sensores de proximidad inductivos",
  productUrl: "www.mysick.com/es/IM_Standard",
  sensingRangeMaxMm: 2,
  switchingOutput: "PNP",
  connection: "M8 de 3 pines",
  enclosureRating: "IP 67",
  operatingTempMinC: -25,
  operatingTempMaxC: 70,
  detectionPrinciple: "inductivo",
  lowConfidence: [
    "connection",
    "enclosure_rating",
    "operating_temp_min_c",
    "operating_temp_max_c",
    "detection_principle",
  ],
  section: "C",
  occurrences: 1,
  alsoOnPages: [],
};

/** I-174 · ELG3 light grid — "2 PNP (Q y /Q)". */
const P1024290: SickProduct = {
  orderNumber: "1024290",
  typeCode: "ELG3-0090P511",
  family: "ELG",
  subfamily: "ELG3",
  rowType: "product",
  sourcePage: "I-174",
  pdfPage: 173,
  category: "Rejillas fotoelectricas (Light grids)",
  productName: "Rejillas fotoeléctricas conmutables",
  productUrl: "www.mysick.com/es/ELG",
  sensingRangeMaxMm: 5000,
  switchingOutput: "2 PNP (Q y /Q)",
  housingMaterial: "aluminio",
  lowConfidence: ["product_name", "housing_material", "sensing_range_max_mm"],
  section: "I",
  occurrences: 1,
  alsoOnPages: [],
};

/** H-165 · DL50 — "2 x / 1 PNP (100 mA)" plus a labelled current column. */
const P1048418: SickProduct = {
  orderNumber: "1048418",
  typeCode: "DL50-P2225",
  family: "Dx50",
  subfamily: "DL50",
  rowType: "product",
  sourcePage: "H-165",
  pdfPage: 164,
  category: "Sensores de distancia (Distance sensors)",
  sensingRangeMinMm: 200,
  sensingRangeMaxMm: 50000,
  switchingOutput: "2 x / 1 PNP (100 mA)",
  outputCurrentMaxMa: 100,
  section: "H",
  occurrences: 1,
  alsoOnPages: [],
};

/** C-79 · IM12 Inox — "IP 68 / IP 69K". */
const P6027572: SickProduct = {
  orderNumber: "6027572",
  typeCode: "IM12-06BPS-NC1",
  family: "IM Inox",
  subfamily: "IM12",
  rowType: "product",
  sourcePage: "C-79",
  pdfPage: 78,
  category: "Sensores de proximidad (Proximity sensors)",
  productName: "Sensores de proximidad inductivos",
  productUrl: "www.mysick.com/es/IM_Inox",
  sensingRangeMaxMm: 6,
  switchingOutput: "PNP",
  connection: "Conector macho M12 de 4 polos",
  enclosureRating: "IP 68 / IP 69K",
  housingMaterial: "acero inoxidable (316L/1.4404)",
  lowConfidence: ["product_name", "enclosure_rating", "housing_material"],
  section: "C",
  occurrences: 1,
  alsoOnPages: [],
};

/** H-166 · UM30 ultrasonic — filed under distance sensors. */
const P6036916: SickProduct = {
  orderNumber: "6036916",
  typeCode: "UM30-211113",
  family: "UM30",
  subfamily: "UM30-2",
  rowType: "product",
  sourcePage: "H-166",
  pdfPage: 165,
  category: "Sensores de distancia (Distance sensors)",
  productUrl: "www.mysick.com/es/UM30",
  sensingRangeMinMm: 30,
  sensingRangeMaxMm: 250,
  responseTimeMs: 50,
  sensorPrinciple: "Ultrasonidos",
  lowConfidence: ["sensor_principle", "alcance límite"],
  section: "H",
  occurrences: 1,
  alsoOnPages: [],
};

/** C-87 · CM18 capacitive proximity sensor on a 4-wire cable. */
const P6020389: SickProduct = {
  orderNumber: "6020389",
  typeCode: "CM18-12NPP-KW1",
  family: "CM",
  subfamily: "CM18",
  rowType: "product",
  sourcePage: "C-87",
  pdfPage: 86,
  category: "Sensores de proximidad (Proximity sensors)",
  sensingRangeMaxMm: 12,
  switchingOutput: "PNP",
  outputFunction: "Antivalente",
  connection: "Cable de 4 hilos, 2 m, PVC",
  sensorPrinciple: "capacitivos",
  lowConfidence: ["sensor_principle"],
  section: "C",
  occurrences: 1,
  alsoOnPages: [],
};

/** K-184 · S300 Mini safety laser scanner. */
const P1050932: SickProduct = {
  orderNumber: "1050932",
  typeCode: "S32B-2011BA",
  family: "S300 Mini Standard",
  rowType: "product",
  sourcePage: "K-184",
  pdfPage: 183,
  category: "Dispositivos de proteccion optoelectronicos (Optoelectronic protective devices)",
  productName: "Escáneres láser de seguridad",
  productUrl: "www.mysick.com/es/S300_Mini_Standard",
  sensingRangeMaxMm: 2000,
  lowConfidence: ["product_name", "sensing_range_max_mm"],
  section: "K",
  occurrences: 1,
  alsoOnPages: [],
};

/** M-224 · MOC3SA speed monitor on screw terminals. */
const P6034245: SickProduct = {
  orderNumber: "6034245",
  typeCode: "MOC3SA-AAB43D31",
  family: "MOC3SA",
  rowType: "product",
  sourcePage: "M-224",
  pdfPage: 223,
  category: "Soluciones de control de seguridad sens:Control (Safety control)",
  productName: "Monitorización de velocidad y parada segura",
  productUrl: "www.mysick.com/es/Speed_Monitor",
  connection: "Terminales roscados",
  lowConfidence: ["product_name"],
  section: "M",
  occurrences: 1,
  alsoOnPages: [],
};

/** E-102 · CLV620 bar-code scanner, Ethernet connection. */
const P1041547: SickProduct = {
  orderNumber: "1041547",
  typeCode: "CLV620-0120",
  family: "CLV62x",
  subfamily: "CLV620",
  rowType: "product",
  sourcePage: "E-102",
  pdfPage: 101,
  category: "Soluciones de identificacion (Identification)",
  productName: "Escáner de códigos de barras",
  productUrl: "www.mysick.com/es/CLV62x",
  sensingRangeMinMm: 60,
  sensingRangeMaxMm: 365,
  connection: "Ethernet",
  enclosureRating: "IP 65",
  lowConfidence: ["product_name", "sensing_range_min_mm", "sensing_range_max_mm"],
  section: "E",
  occurrences: 1,
  alsoOnPages: [],
};

/** D-92 · MZC1 magnetic cylinder sensor, M8 pigtail. */
const P1059735: SickProduct = {
  orderNumber: "1059735",
  typeCode: "MZC1-2V2PS-KP0",
  family: "MZC1",
  rowType: "product",
  sourcePage: "D-92",
  pdfPage: 91,
  category: "Sensores magneticos para cilindros (Magnetic cylinder sensors)",
  productName: "Sensores para cilindros con ranura en C",
  productUrl: "www.mysick.com/es/MZC1",
  switchingOutput: "PNP",
  outputFunction: "normalmente abierto",
  connection: "Cable con conector macho M8 de 3 polos, 0,3 m",
  enclosureRating: "IP 68",
  lowConfidence: ["product_name", "output_function", "Sobrecarrera típ."],
  section: "D",
  occurrences: 1,
  alsoOnPages: [],
};

/** B-23 · PL80A reflector — PMMA/ABS, shared across seven pages. */
const P1003865: SickProduct = {
  orderNumber: "1003865",
  typeCode: "PL80A",
  family: "W2S-2",
  rowType: "accessory",
  sourcePage: "B-23",
  pdfPage: 22,
  category: "Fotocelulas (Photoelectric sensors)",
  shortDescription:
    "Rectangular, atornillable, 80 mm x 80 mm, PMMA/ABS, atornillable, fijación de 2 orificios",
  housingMaterial: "PMMA/ABS",
  lowConfidence: ["row_type", "housing_material"],
  section: "B",
  occurrences: 7,
  alsoOnPages: ["B-48", "B-51", "B-55", "B-58", "B-64", "B-69"],
};

// ---------------------------------------------------------------------------

describe("normalizeSpec — switching output", () => {
  it("reads the plain 'PNP' cell (1051781, B-16)", () => {
    const s = normalizeSpec(P1051781);
    expect(s.outputType).toBe("PNP");
    expect(s.outputCount).toBeUndefined(); // "PNP" states no count
    expect(s.ioLink).toBeUndefined();
  });

  it("maps 'en contrafase' to push-pull and reads IO-Link (1057654, H-162)", () => {
    const s = normalizeSpec(P1057654);
    expect(s.outputType).toBe("push-pull");
    expect(s.ioLink).toBe(true);
    expect(s.outputCount).toBe(2);
    expect(s.outputCurrentMaxMa).toBe(100);
  });

  it("does not read the footnote marker '8)' as a number (1057654, H-162)", () => {
    const s = normalizeSpec(P1057654);
    expect(s.outputCount).not.toBe(8);
    expect(s.outputCurrentMaxMa).not.toBe(8);
  });

  it("refuses to pick between '1 x / 2 x' (1057651, H-162)", () => {
    const s = normalizeSpec(P1057651);
    expect(s.outputCount).toBeUndefined();
    // ...while everything unambiguous on the same cell still comes through.
    expect(s.outputType).toBe("push-pull");
    expect(s.ioLink).toBe(true);
    expect(s.outputCurrentMaxMa).toBe(100);
  });

  it("treats 'seleccionable' as PNP/NPN (6052308, H-156)", () => {
    const s = normalizeSpec(P6052308);
    expect(s.outputType).toBe("PNP/NPN");
    expect(s.outputCount).toBe(1);
  });

  it("does not mistake an analog 4…20 mA range for a current rating (6039866, F-124)", () => {
    const s = normalizeSpec(P6039866);
    expect(s.outputType).toBe("PNP");
    expect(s.outputCount).toBe(1);
    expect(s.outputCurrentMaxMa).toBeUndefined();
  });

  it("reads a relay output and states no count (1064686, B-40)", () => {
    const s = normalizeSpec(P1064686);
    expect(s.outputType).toBe("relay");
    expect(s.outputCount).toBeUndefined();
  });

  it("reads '2 PNP (Q y /Q)' as two PNP outputs (1024290, I-174)", () => {
    const s = normalizeSpec(P1024290);
    expect(s.outputType).toBe("PNP");
    expect(s.outputCount).toBe(2);
    expect(s.outputCurrentMaxMa).toBeUndefined();
  });

  it("prefers the labelled current column over the switching text (1048418, H-165)", () => {
    const s = normalizeSpec(P1048418);
    expect(s.outputCurrentMaxMa).toBe(100);
    expect(s.outputType).toBe("PNP");
    expect(s.outputCount).toBeUndefined(); // "2 x / 1" is an alternative
  });
});

describe("normalizeSpec — connection", () => {
  it("splits 'Conector macho M8 de 4 polos' (1051781, B-16)", () => {
    const s = normalizeSpec(P1051781);
    expect(s.connector).toBe("M8");
    expect(s.connectorPins).toBe(4);
  });

  it("keys a pigtail by its connector, not its lead (1052956, G-139)", () => {
    const s = normalizeSpec(P1052956);
    expect(s.connector).toBe("M12");
    expect(s.connectorPins).toBe(4);
  });

  it("accepts 'pines' as well as 'polos' (1040869, C-76)", () => {
    const s = normalizeSpec(P1040869);
    expect(s.connector).toBe("M8");
    expect(s.connectorPins).toBe(3);
  });

  it("reads a bare cable without inventing pins from 'hilos' (1064686, B-40)", () => {
    const s = normalizeSpec(P1064686);
    expect(s.connector).toBe("cable");
    expect(s.connectorPins).toBeUndefined();
  });

  it("never reads an M20 cable gland as a connector (6025815 C-84, 6025063 L-207)", () => {
    const terminals = normalizeSpec(P6025815);
    expect(terminals.connector).toBe("terminal");
    expect(terminals.connectorPins).toBeUndefined();

    const glands = normalizeSpec(P6025063);
    expect(glands.connector).toBe("cable");
    expect(glands.connectorPins).toBeUndefined();
  });

  it("classifies screw terminals and non-circular plugs (6034245 M-224, 1041547 E-102, 6036371 F-121)", () => {
    expect(normalizeSpec(P6034245).connector).toBe("terminal");
    expect(normalizeSpec(P1041547).connector).toBe("other"); // Ethernet
    expect(normalizeSpec(P6036371).connector).toBe("other"); // DIN 43650 valve plug
  });

  it("reads an 8-pin M12 (1036726, N-232)", () => {
    const s = normalizeSpec(P1036726);
    expect(s.connector).toBe("M12");
    expect(s.connectorPins).toBe(8);
  });
});

describe("normalizeSpec — enclosure rating", () => {
  it("reads a single rating (6039866, F-124)", () => {
    const s = normalizeSpec(P6039866);
    expect(s.ipRating).toBe(67);
    expect(s.ip69k).toBeUndefined();
  });

  it("takes the lowest rating when several are listed (1037484, N-236)", () => {
    // "IP 67 (carcasa), IP 65 (eje)" — the shaft seal is the weak point.
    expect(normalizeSpec(P1037484).ipRating).toBe(65);
  });

  it("keeps the numeric floor while recording IP69K separately (1052069 F-116, 6027572 C-79)", () => {
    const lfp = normalizeSpec(P1052069); // "IP 67 e IP 69K"
    expect(lfp.ipRating).toBe(67);
    expect(lfp.ip69k).toBe(true);

    const im12 = normalizeSpec(P6027572); // "IP 68 / IP 69K"
    expect(im12.ipRating).toBe(68);
    expect(im12.ip69k).toBe(true);
  });

  it("reads IP 69K alone as 69 (2063403, B-32)", () => {
    const s = normalizeSpec(P2063403);
    expect(s.ipRating).toBe(69);
    expect(s.ip69k).toBe(true);
  });

  it("ignores standard numbers cited in the same cell (1052237, F-126)", () => {
    // "IP 67: EN 60529, IP 69K: EN 40050" — 60529 and 40050 are standards.
    const s = normalizeSpec(P1052237);
    expect(s.ipRating).toBe(67);
    expect(s.ip69k).toBe(true);
  });
});

describe("normalizeSpec — sensing principle", () => {
  it("lets the detection field refine a diffuse sensor (1064686 B-40, 1041380 B-50)", () => {
    expect(normalizeSpec(P1064686).principle).toBe("background-suppression");
    expect(normalizeSpec(P1041380).principle).toBe("foreground-suppression");
  });

  it("keeps 'energética' as plain diffuse (1051781, B-16)", () => {
    expect(normalizeSpec(P1051781).principle).toBe("diffuse");
  });

  it("reads the detection field when no sensor principle is printed (1040869, C-76)", () => {
    expect(normalizeSpec(P1040869).principle).toBe("inductive");
  });

  it("normalizes ultrasonic and capacitive sensor principles (6036916 H-166, 6020389 C-87)", () => {
    expect(normalizeSpec(P6036916).principle).toBe("ultrasonic");
    expect(normalizeSpec(P6020389).principle).toBe("capacitive");
  });

  it("falls back to unambiguous section names for product rows", () => {
    expect(normalizeSpec(P1036726).principle).toBe("encoder");
    expect(normalizeSpec(P6034245).principle).toBe("safety-controller");
    expect(normalizeSpec(P1041547).principle).toBe("identification");
    expect(normalizeSpec(P1059735).principle).toBe("magnetic");
    expect(normalizeSpec(P6025063).principle).toBe("safety-switch");
    expect(normalizeSpec(P1024290).principle).toBe("light-grid");
    expect(normalizeSpec(P1062409).principle).toBe("vision");
    expect(normalizeSpec(P6039866).principle).toBe("fluid");
  });

  it("never gives an accessory the principle of the section it is filed under", () => {
    expect(normalizeSpec(P1036616).principle).toBeUndefined(); // USB programmer, Encoders
    expect(normalizeSpec(P2063403).principle).toBeUndefined(); // reflector, Fotocélulas
    expect(normalizeSpec(P1003865).principle).toBeUndefined(); // reflector, Fotocélulas
  });
});

describe("normalizeSpec — housing and light", () => {
  it("classifies stainless from prose, EN steel number, and AISI grade", () => {
    expect(normalizeSpec(P6036371).housing).toBe("stainless-steel"); // "acero inoxidable 1.4404, PEI"
    expect(normalizeSpec(P1052069).housing).toBe("stainless-steel"); // bare "1.4305"
    expect(normalizeSpec(P1052956).housing).toBe("stainless-steel"); // "acero inoxidable 316L"
  });

  it("reads the body material, not the lens (6052308, H-156)", () => {
    // "Carcasa de aluminio con lente PPSU" is a metal-bodied sensor.
    expect(normalizeSpec(P6052308).housing).toBe("metal");
    expect(normalizeSpec(P1024290).housing).toBe("metal"); // "aluminio"
  });

  it("classifies plastics (6039866 F-124, 1003865 B-23)", () => {
    expect(normalizeSpec(P6039866).housing).toBe("plastic"); // "PVDF, PBT, TPU"
    expect(normalizeSpec(P1003865).housing).toBe("plastic"); // "PMMA/ABS"
  });

  it("normalizes light sources (1051781 B-16, 1057654 H-162, 1052956 G-139, 1062409 J-179)", () => {
    expect(normalizeSpec(P1051781).light).toBe("red");
    expect(normalizeSpec(P1064686).light).toBe("red");
    expect(normalizeSpec(P1057654).light).toBe("laser"); // "Láser rojo, clase 1"
    expect(normalizeSpec(P1052956).light).toBe("rgb"); // "LED rojo, verde, azul"
    expect(normalizeSpec(P1062409).light).toBe("other"); // "UV"
  });
});

describe("normalizeSpec — numerics copy straight across", () => {
  it("carries the already-normalized columns (1037484 N-236, 1052956 G-139, 1027393 G-141)", () => {
    const enc = normalizeSpec(P1037484);
    expect(enc.supplyVoltageMinV).toBe(4.5);
    expect(enc.supplyVoltageMaxV).toBe(32);
    expect(enc.operatingTempMinC).toBe(-30);
    expect(enc.operatingTempMaxC).toBe(100);

    expect(normalizeSpec(P1052956).responseTimeMs).toBe(0.035);
    expect(normalizeSpec(P1027393).switchingFrequencyHz).toBe(10000);

    const dx35 = normalizeSpec(P1057654);
    expect(dx35.sensingRangeMinMm).toBe(50);
    expect(dx35.sensingRangeMaxMm).toBe(12000);
  });
});

describe("normalizeSpec — honest unknowns", () => {
  it("omits the property entirely rather than defaulting it (2063403, B-32)", () => {
    const s = normalizeSpec(P2063403);
    // A reflector: no output, no connection, no principle on the page.
    expect("outputType" in s).toBe(false);
    expect("connector" in s).toBe(false);
    expect("principle" in s).toBe(false);
    expect(s.orderNumber).toBe("2063403");
  });

  it("leaves outputType unknown for 'Conmutador sin contacto' (6036371, F-121)", () => {
    const s = normalizeSpec(P6036371);
    expect(s.outputType).toBeUndefined();
    expect("outputType" in s).toBe(false);
    // The rest of the row still normalizes.
    expect(s.ipRating).toBe(65);
    expect(s.housing).toBe("stainless-steel");
  });

  it("never guesses a principle for a mixed-principle section (6025815 C-84, 1027393 G-141, 6052308 H-156)", () => {
    // The proximity section holds inductive AND capacitive parts; the product
    // name says "inductivos" but the principle cell is empty on this page.
    expect(normalizeSpec(P6025815).principle).toBeUndefined();
    // Registration sensors: contrast, luminescence and colour share a section.
    expect(normalizeSpec(P1027393).principle).toBeUndefined();
    // Distance sensors: laser AND ultrasonic share a section.
    expect(normalizeSpec(P6052308).principle).toBeUndefined();
    // "Dispositivos de proteccion optoelectronicos" holds light curtains,
    // single-beam barriers AND laser scanners. 1050932 is an S300 Mini laser
    // scanner: calling it a safety light curtain would be fabricated evidence.
    expect(normalizeSpec(P1050932).principle).toBeUndefined();
  });

  it("leaves an unparseable light type unknown rather than guessing (1041380 B-50, 1027393 G-141)", () => {
    expect(normalizeSpec(P1041380).light).toBeUndefined(); // bare "LED": no colour stated
    expect(normalizeSpec(P1027393).light).toBeUndefined(); // "LED rojo, verde": neither red nor green
  });

  it("never asserts the absence of IO-Link or IP69K", () => {
    // Silence in a summary catalog is not a denial — these must be unknown, not
    // false, or the solver would hard-fail candidates on missing evidence.
    const s = normalizeSpec(P6039866); // "1 PNP + 4 mA…", "IP 67"
    expect("ioLink" in s).toBe(false);
    expect("ip69k" in s).toBe(false);
    expect(normalizeSpec(P1051781).ioLink).toBeUndefined();
  });
});

describe("normalizeSpec — lowConfidence propagation", () => {
  it("reports the NORMALIZED field name, not the source column (1052069, F-116)", () => {
    const s = normalizeSpec(P1052069); // enclosure_rating flagged
    expect(s.lowConfidence).toContain("ipRating");
    expect(s.lowConfidence).toContain("ip69k");
    expect(s.lowConfidence).not.toContain("enclosure_rating");
  });

  it("propagates a flagged switching-output cell to every field derived from it (1052237, F-126)", () => {
    const s = normalizeSpec(P1052237);
    expect(s.lowConfidence).toContain("outputType");
    expect(s.lowConfidence).toContain("outputCount");
  });

  it("propagates connection, principle, housing, light and numeric flags", () => {
    const ime08 = normalizeSpec(P1040869);
    expect(ime08.lowConfidence).toEqual(
      expect.arrayContaining([
        "connector",
        "connectorPins",
        "ipRating",
        "operatingTempMinC",
        "operatingTempMaxC",
        "principle",
      ]),
    );

    expect(normalizeSpec(P1024290).lowConfidence).toContain("housing");
    expect(normalizeSpec(P1062409).lowConfidence).toContain("light");
    expect(normalizeSpec(P1027393).lowConfidence).toContain("switchingFrequencyHz");
    expect(normalizeSpec(P6036916).lowConfidence).toContain("principle");
  });

  it("does not flag a field that was not derived from a flagged column (1064686, B-40)", () => {
    const s = normalizeSpec(P1064686);
    // detection_principle is flagged, light_type is not.
    expect(s.lowConfidence).toContain("principle");
    expect(s.lowConfidence).not.toContain("light");
    expect(s.lowConfidence).not.toContain("outputType");
    expect(s.lowConfidence).not.toContain("connector");
  });

  it("never flags a field it did not emit (1041380, B-50)", () => {
    const s = normalizeSpec(P1041380);
    // light_type IS flagged, but "LED" yields no canonical light — so there is
    // nothing for the agent to double-check.
    expect(s.light).toBeUndefined();
    expect(s.lowConfidence).not.toContain("light");
    expect(s.lowConfidence).toContain("principle");
  });

  it("matches flags whether the loader emits snake_case or camelCase", () => {
    const camel: SickProduct = { ...P1052237, lowConfidence: ["productName", "switchingOutput"] };
    expect(normalizeSpec(camel).lowConfidence).toContain("outputType");
  });

  it("emits an empty array, not undefined, when nothing is flagged (1052956, G-139)", () => {
    expect(normalizeSpec(P1052956).lowConfidence).toEqual([]);
  });

  it("deduplicates and stays stable across calls", () => {
    const a = normalizeSpec(P1040869);
    const b = normalizeSpec(P1040869);
    expect(a.lowConfidence).toEqual(b.lowConfidence);
    expect(new Set(a.lowConfidence).size).toBe(a.lowConfidence.length);
  });
});

describe("normalizeAll", () => {
  const products = [P1051781, P1057654, P2063403, P1036616, P6034245];

  it("preserves input order and length, which SerializedIndex alignment depends on", () => {
    const specs = normalizeAll(products);
    expect(specs).toHaveLength(products.length);
    expect(specs.map((s) => s.orderNumber)).toEqual(products.map((p) => p.orderNumber));
  });

  it("is a pure projection — same input, same output", () => {
    expect(normalizeAll(products)).toEqual(normalizeAll(products));
  });
});

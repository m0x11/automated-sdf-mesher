#!/usr/bin/env node

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── CLI ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let inputPath = null;
let sizeMM = null;
let density = 130;
let bboxOverride = null; // --bbox minX,minY,minZ,maxX,maxY,maxZ (model units)

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--size" && args[i + 1]) {
    sizeMM = parseFloat(args[++i]);
  } else if (args[i] === "--density" && args[i + 1]) {
    density = parseFloat(args[++i]);
  } else if (args[i] === "--bbox" && args[i + 1]) {
    const v = args[++i].split(",").map(parseFloat);
    if (v.length !== 6 || v.some((x) => !Number.isFinite(x))) {
      console.error("--bbox expects minX,minY,minZ,maxX,maxY,maxZ");
      process.exit(1);
    }
    bboxOverride = {
      size: [v[3] - v[0], v[4] - v[1], v[5] - v[2]],
      center: [(v[0] + v[3]) / 2, (v[1] + v[4]) / 2, (v[2] + v[5]) / 2],
    };
  } else if (!args[i].startsWith("--")) {
    inputPath = args[i];
  }
}

if (!inputPath) {
  console.error(
    "Usage: node batch-scene.js <scene.json | scenes-dir/> [--size 30] [--density 130] [--bbox minX,minY,minZ,maxX,maxY,maxZ]"
  );
  console.error(
    "\nRequires sdf-mesher server running: python3 -m http.server 8000"
  );
  process.exit(1);
}

// ── Resolve input files ──────────────────────────────────────────────
const resolvedInput = path.resolve(inputPath);
let sceneFiles;
if (fs.statSync(resolvedInput).isDirectory()) {
  sceneFiles = fs
    .readdirSync(resolvedInput)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(resolvedInput, f));
} else {
  sceneFiles = [resolvedInput];
}

if (sceneFiles.length === 0) {
  console.error("No .json files found in", resolvedInput);
  process.exit(1);
}

// ── Flurry source paths ──────────────────────────────────────────────
const flurryDir = path.join(__dirname, "..", "flurry");
const paramsTs = fs.readFileSync(
  path.join(flurryDir, "src/lib/params.ts"),
  "utf8"
);
const pageTsx = fs.readFileSync(
  path.join(flurryDir, "src/app/page.tsx"),
  "utf8"
);

// ── Parse param definitions from params.ts ──────────────────────────
const snowflakeParamKeys = [];
const snowflakeDefaults = {};
const paramDefsStart = paramsTs.indexOf("export const paramDefs");
const paramDefsEnd = paramsTs.indexOf("];", paramDefsStart);
const paramDefsBlock = paramsTs.slice(paramDefsStart, paramDefsEnd);

const pdRegex = /key:\s*"(\w+)"[^}]*?default:\s*([-\d.eE+/*() ]+)/g;
let pm;
while ((pm = pdRegex.exec(paramDefsBlock)) !== null) {
  snowflakeParamKeys.push(pm[1]);
  snowflakeDefaults[pm[1]] = eval(pm[2]);
}

// Type-specific param definitions
const TYPE_PARAMS = {
  snowflake: snowflakeParamKeys,
  snowflakeRail: snowflakeParamKeys,
  sphere: ["radius"],
  torus: ["majorRadius", "minorRadius", "vesica", "disc", "concentricCount", "concentricSpacing", "concentricBlend"],
  diamondTorus: ["majorRadius", "minorRadius", "edgeSoften", "vesica", "concentricCount", "concentricSpacing", "concentricBlend"],
  cylinder: ["radius", "height"],
  box: ["sizeX", "sizeY", "sizeZ", "rounding", "taperAxis", "taperPosEnd", "taperNegEnd", "taperLength", "taperAmount", "bulgeAxis", "bulgeAmount", "bulgePos", "bulgeLength", "bulgeBlend", "endRoundAxis", "endRoundPos", "endRoundNeg"],
  disk: ["radius", "thickness", "rounding"],
  tube: ["radius", "height", "wall", "rounding"],
  relicBand: ["boreRadius", "halfWidth", "depth", "domeMid", "domeEdge", "edgeRound", "flareMid", "flareEdge", "boreBlend"],
  cipherBand: ["boreRadius", "wall", "halfWidth", "fillet"],
  frame: ["pitch", "frameW", "frameH", "frameY", "barSize", "blend", "innerCut", "scaleA", "scaleB", "scaleC", "cellBlend"],
};

const TYPE_DEFAULTS = {
  snowflake: snowflakeDefaults,
  snowflakeRail: snowflakeDefaults,
  sphere: { radius: 1 },
  torus: { majorRadius: 1, minorRadius: 0.3, vesica: 0, disc: 0, concentricCount: 1, concentricSpacing: 0.5, concentricBlend: 0 },
  diamondTorus: { majorRadius: 1, minorRadius: 0.3, edgeSoften: 0, vesica: 0, concentricCount: 1, concentricSpacing: 0.5, concentricBlend: 0 },
  cylinder: { radius: 1, height: 2 },
  box: { sizeX: 1, sizeY: 1, sizeZ: 1, rounding: 0, taperAxis: 1, taperPosEnd: 0, taperNegEnd: 0, taperLength: 1, taperAmount: 0.5, bulgeAxis: 1, bulgeAmount: 0, bulgePos: 0, bulgeLength: 1, bulgeBlend: 0.25, endRoundAxis: 1, endRoundPos: 0, endRoundNeg: 0 },
  disk: { radius: 2, thickness: 0.2, rounding: 0 },
  tube: { radius: 1, height: 2, wall: 0.2, rounding: 0 },
  relicBand: { boreRadius: 3.9, halfWidth: 1.2433, depth: 0.7067, domeMid: 0.155, domeEdge: 0.115, edgeRound: 0.16, flareMid: 0.04, flareEdge: 0.05, boreBlend: 0.13 },
  cipherBand: { boreRadius: 3.9, wall: 0.45, halfWidth: 0.95, fillet: 0.05 },
  frame: { pitch: 4.2, frameW: 10.1, frameH: 14.35, frameY: -0.15, barSize: 0, blend: 0.3, innerCut: 1, scaleA: 1.59, scaleB: 1.59, scaleC: 1.59, cellBlend: 0 },
};
// Frame border grid (locked; matches FRAME_ROWS/FRAME_COLS in the shader)
const FRAME_ROWS = 9;
const FRAME_COLS = 7;

const SDF_TYPE_INDEX = { snowflake: 0, sphere: 1, torus: 2, diamondTorus: 3, stamp: 4, cylinder: 5, box: 6, disk: 7, tube: 8, group: 9, snowflakeRail: 10, frame: 11, relicBand: 12, cipherBand: 13 };
const PARAM_START_INDEX = 19;
const TEX_WIDTH = 64;

// Slot indices (matching param-texture.ts)
const SLOT = {
  POS_X: 0, POS_Y: 1, POS_Z: 2,
  TYPE: 3, MODE: 4,
  CLIP_ENABLED: 5, CLIP_NX: 6, CLIP_NY: 7, CLIP_NZ: 8, CLIP_OFFSET: 9,
  BOWL_AMOUNT: 10, BOWL_RADIUS: 11,
  ROT_X: 12, ROT_Y: 13, ROT_Z: 14,
  SCALE: 15,
  WARP_X: 16, WARP_Y: 17, WARP_Z: 18,
  GRID_SPACING_X: 240, GRID_SPACING_Y: 241, GRID_SPACING_Z: 242,
  GRID_COUNT_X: 243, GRID_COUNT_Y: 244, GRID_COUNT_Z: 245,
  GRID_SELF_BLEND: 246,
  GRID_RANGE: 247,
  GRID_WRAP_MODE: 248,
  GRID_FOLD: 205,
  GRID_SCALE: 204,         // warpTarget 2 ("Both"): whole-grid uniform scale
  PINCH_KEEP_THICK: 203,   // 1 = thickness params divided by the local pinch factor
  PINCH_KEEP_TMAX: 202,    // max compensated thickness (Lipschitz/bounds; viewer-side mostly)
  BOWL_MODE: 201,          // 0 = Lift (legacy shear), 1 = Bend (isometric sphere wrap)
  BOWL_KEEP_THICK: 200,    // Bend: thickness params × θ/sinθ
  GRID_WRAP_RADIUS: 249,
  GRID_WRAP_AXIS: 250,
  GRID_WRAP_COUNT: 251,
  GRID_CREASE_BLEND: 253,
  GRID_FLOWER_AMOUNT: 254,
  SPIRAL_TIGHTNESS: 252,
  SPIRAL_GROWTH: 255,
  SPIRAL_SINGLE: 236,
  SPIRAL_TURN: 237,
  LSYS_NODE_COUNT: 228,
  LSYS_ALIGN: 229,
  OUTER_CUT_ENABLED: 232,
  OUTER_CUT_SHAPE: 233,
  OUTER_CUT_SIZE: 234,
  OUTER_CUT_BLEND: 235,
  OUTER_CUT_TARGET: 238,
  OUTER_CUT_OFF_X: 230,
  OUTER_CUT_OFF_Y: 231,
  OUTER_CUT_OFF_Z: 239,
  OUTER_CUT_SIZE_Y: 218,
  OUTER_CUT_SIZE_Z: 219,
  WARP_TARGET: 220,
  BOWL_AXIS: 221,
  BOWL_TARGET: 222,
  PINCH_AMOUNT: 223,
  PINCH_CENTER: 224,
  PINCH_AXIS: 225,
  PINCH_RANGE: 226,
  PINCH_TARGET: 227,
  PINCH_MODE: 207, // 0 = gaussian, 1 = profile curve LUT (row PINCH_CURVE_BASE_ROW + i)
  // Bend warp (freeform bowl): axial shear by a curve LUT of radial distance
  // (row BEND_CURVE_BASE_ROW + i). Curve is the only mode.
  BEND_MAX_DISP: 191,   // CPU-only: |amount| * max|C| (viewer bounds; unused here)
  BEND_AMOUNT: 192,
  BEND_RANGE: 193,
  BEND_AXIS: 194,
  BEND_TARGET: 195,     // 0 = object (per copy), 1 = grid (whole repeated field)
  BEND_MAX_SLOPE: 196,  // global |d(disp)/dr| bound (viewer step cap; harmless here)
  BEND_ON: 197,         // 1 = curve LUT baked and non-identity
  // Object groups: member rows point at their group's row (index + 1, 0 =
  // ungrouped); group rows are geometry-less (type 9), read only as a frame.
  // Slot 189 (group pinch step bound) is viewer-only — the mesher never
  // marches, so it stays 0 here.
  GROUP_IDX: 190,
  // Subtract mode: row index + 1 of the one object (or group → members) this
  // carves; 0 = whole-scene subtract (legacy).
  SUBTRACT_BLEND: 185,
  SUBTRACT_TARGET: 186,
  // Frame (type 11): baked in buildScene's second pass — bar half-size, the
  // largest scaled snowflake reach (cell cull), A/B/C snowflake rows + 1.
  FRAME_BAR: 180,
  FRAME_REACH: 181,
  FRAME_SNOW_A: 182,
  FRAME_SNOW_B: 183,
  FRAME_SNOW_C: 184,
};

// ── Pinch profile curve (keep in sync with flurry/src/lib/pinch-curve.ts) ─
// Object i's 256-float LUT lives in texture row PINCH_CURVE_BASE_ROW + i,
// matching the shader const PINCH_CURVE_ROW in page.tsx.
const PINCH_CURVE_BASE_ROW = 320;
const PINCH_CURVE_SAMPLES = 256;
// s may go negative: the pinch crosses the axis and mirrors the geometry
// (keep in sync with flurry/src/lib/pinch-curve.ts; shader clamps |f| >= 0.1)
const PINCH_S_MIN = -2;
const PINCH_S_MAX = 2;

function sanitizePinchPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const pts = [];
  for (const p of points) {
    if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1])) continue;
    pts.push([
      Math.min(Math.max(p[0], 0), 1),
      Math.min(Math.max(p[1], PINCH_S_MIN), PINCH_S_MAX),
    ]);
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a[0] - b[0]);
  pts[0] = [0, pts[0][1]];
  pts[pts.length - 1] = [1, pts[pts.length - 1][1]];
  return pts;
}

function isIdentityPinchCurve(points) {
  if (!points || points.length < 2) return true;
  return points.every((p) => Math.abs(p[1] - 1) < 1e-3);
}

// Fritsch–Carlson monotone cubic tangents (no overshoot)
function pchipSlopes(xs, ys) {
  const n = xs.length;
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(Math.max(xs[i + 1] - xs[i], 1e-6));
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = new Array(n);
  if (n === 2) {
    m[0] = m[1] = d[0];
    return m;
  }
  const endSlope = (h0, h1, d0, d1) => {
    let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(s) !== Math.sign(d0)) s = 0;
    else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > 3 * Math.abs(d0)) s = 3 * d0;
    return s;
  };
  m[0] = endSlope(h[0], h[1], d[0], d[1]);
  m[n - 1] = endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return m;
}

function samplePinchCurve(pts, n) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const m = pchipSlopes(xs, ys);
  const out = new Float32Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    while (seg < xs.length - 2 && t > xs[seg + 1]) seg++;
    const h = Math.max(xs[seg + 1] - xs[seg], 1e-6);
    const u = Math.min(Math.max((t - xs[seg]) / h, 0), 1);
    const u2 = u * u;
    const u3 = u2 * u;
    const v =
      (2 * u3 - 3 * u2 + 1) * ys[seg] +
      (u3 - 2 * u2 + u) * h * m[seg] +
      (-2 * u3 + 3 * u2) * ys[seg + 1] +
      (u3 - u2) * h * m[seg + 1];
    out[i] = Math.min(Math.max(v, PINCH_S_MIN), PINCH_S_MAX);
  }
  return out;
}

// ── Bend profile curve (keep in sync with flurry/src/lib/bend-curve.ts) ──
// Object i's 256-float LUT lives in texture row BEND_CURVE_BASE_ROW + i,
// matching the shader const BEND_CURVE_ROW in page.tsx. s in [-1, 1] is the
// axial displacement profile over radial distance [0, bendRange].
const BEND_CURVE_BASE_ROW = 256;
const BEND_CURVE_SAMPLES = 256;
const BEND_S_MIN = -1;
const BEND_S_MAX = 1;

function sanitizeBendPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const pts = [];
  for (const p of points) {
    if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1])) continue;
    pts.push([
      Math.min(Math.max(p[0], 0), 1),
      Math.min(Math.max(p[1], BEND_S_MIN), BEND_S_MAX),
    ]);
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a[0] - b[0]);
  pts[0] = [0, pts[0][1]];
  pts[pts.length - 1] = [1, pts[pts.length - 1][1]];
  return pts;
}

function isIdentityBendCurve(points) {
  if (!points || points.length < 2) return true;
  return points.every((p) => Math.abs(p[1]) < 1e-3);
}

function sampleBendCurve(pts, n) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const m = pchipSlopes(xs, ys);
  const out = new Float32Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    while (seg < xs.length - 2 && t > xs[seg + 1]) seg++;
    const h = Math.max(xs[seg + 1] - xs[seg], 1e-6);
    const u = Math.min(Math.max((t - xs[seg]) / h, 0), 1);
    const u2 = u * u;
    const u3 = u2 * u;
    const v =
      (2 * u3 - 3 * u2 + 1) * ys[seg] +
      (u3 - 2 * u2 + u) * h * m[seg] +
      (-2 * u3 + 3 * u2) * ys[seg + 1] +
      (u3 - u2) * h * m[seg + 1];
    out[i] = Math.min(Math.max(v, BEND_S_MIN), BEND_S_MAX);
  }
  return out;
}

// Effective bend state for an object: {active, maxDisp (bounds inflation)}
function bendState(obj) {
  const amt = obj.bendAmount ?? 1;
  const pts = sanitizeBendPoints(obj.bendPoints);
  if (!pts || isIdentityBendCurve(pts) || Math.abs(amt) < 1e-3) return { active: false, pts: null, maxDisp: 0 };
  let maxAbs = 0;
  for (const p of pts) maxAbs = Math.max(maxAbs, Math.abs(p[1]));
  return { active: true, pts, maxDisp: Math.abs(amt) * maxAbs };
}

// Effective pinch state for an object: {curveOn, pts, maxF (bounds factor),
// minF (smallest factor, for "Keep thickness" inflation), active}
function pinchState(obj) {
  const curveSel = (obj.pinchMode ?? 0) > 0.5;
  if (curveSel) {
    const pts = sanitizePinchPoints(obj.pinchPoints);
    if (!pts || isIdentityPinchCurve(pts)) return { curveOn: false, pts: null, maxF: 1, minF: 1, active: false };
    // Negative s mirrors through the axis: radial bounds use |s|; the
    // effective min |f| floors at the shader's 0.1 clamp when the control
    // points straddle zero (PCHIP keeps the curve inside [min, max] pts).
    let maxS = 1;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      maxS = Math.max(maxS, Math.abs(p[1]));
      lo = Math.min(lo, p[1]);
      hi = Math.max(hi, p[1]);
    }
    const minF = lo < 0 && hi > 0 ? 0.1 : Math.max(Math.min(Math.abs(lo), Math.abs(hi)), 0.1);
    return { curveOn: true, pts, maxF: maxS + 0.1, minF, active: true };
  }
  const amt = obj.pinchAmount ?? 0;
  if (Math.abs(amt) <= 1e-3) return { curveOn: false, pts: null, maxF: 1, minF: 1, active: false };
  return {
    curveOn: false, pts: null,
    maxF: Math.max(1 + Math.max(amt, 0), Math.abs(1 + Math.min(amt, 0))) + 0.1,
    minF: Math.max(1 + Math.min(amt, 0), 0.1),
    active: true,
  };
}

// ── Extract shader GLSL from page.tsx ────────────────────────────────

// Snowflake thickness params multiplied by _pnThick ("Keep thickness") —
// keep in sync with SNOWFLAKE_THICKNESS_KEYS in flurry/src/lib/pinch-curve.ts
const SNOWFLAKE_THICKNESS_KEYS = [
  "rayThickness", "t3CenterThickness", "t3NeighborThickness",
  "secT3CenterThickness", "secT3NeighborThickness", "outerThickness",
  "substrateThickness", "hookThickness", "hookThickness2",
];
function typeMaxThickness(obj) {
  const p = { ...(TYPE_DEFAULTS[obj.type] || {}), ...(obj.params || {}) };
  switch (obj.type) {
    case "tube": return Math.abs(p.wall ?? 0.2);
    case "relicBand": return Math.abs(p.depth ?? 0.7067);
    case "cipherBand": return Math.abs(p.wall ?? 0.45);
    case "torus":
    case "diamondTorus": return Math.abs(p.minorRadius ?? 0.3);
    case "disk": return Math.abs(p.thickness ?? 0.2);
    case "snowflake":
    case "snowflakeRail": return Math.max(0, ...SNOWFLAKE_THICKNESS_KEYS.map((k) => Math.abs(p[k] ?? 0)));
    default: return 0;
  }
}
function pinchKeepMaxThickness(obj) {
  if (!((obj.pinchKeepThickness ?? 0) > 0.5)) return 0;
  return typeMaxThickness(obj);
}
// A member's max compensated thickness in its group's frame (the frame the
// group's warps run in): local thickness × the member's scale/warp chain.
// Mirrors memberThicknessInGroupFrame in flurry/src/lib/param-texture.ts.
function memberThicknessInGroupFrame(member) {
  const t = typeMaxThickness(member);
  if (t <= 0) return 0;
  const s = member.scale > 0.001 ? member.scale : 1;
  const maxW = Math.max(member.warpX || 1, member.warpY || 1, member.warpZ || 1);
  const gs2 = (member.warpTarget ?? 0) === 2 && member.gridScale > 0.001 ? member.gridScale : 1;
  return t * s * maxW * gs2;
}

// 1. Generate snowflake #defines (same as generateSnowflakeDefines in param-texture.ts)
function generateSnowflakeDefines() {
  const lines = [];
  for (let i = 0; i < snowflakeParamKeys.length; i++) {
    const key = snowflakeParamKeys[i];
    const uName = "u" + key.charAt(0).toUpperCase() + key.slice(1);
    const thick = SNOWFLAKE_THICKNESS_KEYS.includes(key) ? " * _pnThick" : "";
    lines.push(`#define ${uName} (P(_oid, ${PARAM_START_INDEX + i})${thick})`);
  }
  return lines.join("\n");
}

// 2. Extract SDF body (SDF_START to SDF_END)
const startMarker = "// SDF_START";
const endMarker = "// SDF_END";
const startIdx = pageTsx.indexOf(startMarker);
const endIdx = pageTsx.indexOf(endMarker);
if (startIdx === -1 || endIdx === -1) {
  console.error("Could not find SDF_START / SDF_END markers in page.tsx");
  process.exit(1);
}
let sdfBody = pageTsx.slice(pageTsx.indexOf("\n", startIdx) + 1, endIdx);
sdfBody = sdfBody.replace(/^  /gm, "");

// 3. Extract post-SDF_END scene evaluation code (primitives + scene composition)
const pbrMarker = "// ========== PBR UTILITIES ==========";
const postSdfStart = pageTsx.indexOf("\n", endIdx) + 1;
const postSdfEnd = pageTsx.indexOf(pbrMarker);
if (postSdfEnd === -1) {
  console.error("Could not find PBR UTILITIES marker in page.tsx");
  process.exit(1);
}
let sceneCode = pageTsx.slice(postSdfStart, postSdfEnd);
sceneCode = sceneCode.replace(/^  /gm, "");

// ── WebGL 2 / GLSL ES 3.0 ────────────────────────────────────────────
// The mesher now uses WebGL 2 (GLSL ES 3.0), matching page.tsx.
// No compatibility patches needed — texelFetch, abs(int), min/max(int),
// dynamic array indexing, and round() are all natively supported.

// ── Build param texture data ────────────────────────────────────────
function writeObjectToTexture(data, objIdx, obj) {
  const rowOffset = objIdx * TEX_WIDTH * 4;
  const params = obj.params || {};

  // Clear row
  for (let i = 0; i < TEX_WIDTH * 4; i++) {
    data[rowOffset + i] = 0;
  }

  // Common slots
  data[rowOffset + SLOT.POS_X] = obj.position?.[0] ?? 0;
  data[rowOffset + SLOT.POS_Y] = obj.position?.[1] ?? 0;
  data[rowOffset + SLOT.POS_Z] = obj.position?.[2] ?? 0;
  data[rowOffset + SLOT.TYPE] = SDF_TYPE_INDEX[obj.type] ?? 0;
  data[rowOffset + SLOT.MODE] = obj.hidden ? 2 : (obj.mode === "subtract" ? 1 : 0);
  data[rowOffset + SLOT.CLIP_ENABLED] = obj.clipEnabled ? 1 : 0;

  // Compute clip normal from yaw/pitch
  const cy = Math.cos(obj.clipYaw ?? 0);
  const sy = Math.sin(obj.clipYaw ?? 0);
  const cp = Math.cos(obj.clipPitch ?? 0);
  const sp = Math.sin(obj.clipPitch ?? 0);
  data[rowOffset + SLOT.CLIP_NX] = cp * sy;
  data[rowOffset + SLOT.CLIP_NY] = sp;
  data[rowOffset + SLOT.CLIP_NZ] = cp * cy;
  data[rowOffset + SLOT.CLIP_OFFSET] = obj.clipOffset ?? 0;

  data[rowOffset + SLOT.BOWL_AMOUNT] = obj.bowlAmount ?? 0;
  data[rowOffset + SLOT.BOWL_RADIUS] = obj.bowlRadius ?? 5;
  data[rowOffset + SLOT.ROT_X] = obj.rotX ?? 0;
  data[rowOffset + SLOT.ROT_Y] = obj.rotY ?? 0;
  data[rowOffset + SLOT.ROT_Z] = obj.rotZ ?? 0;
  data[rowOffset + SLOT.SCALE] = obj.scale ?? 1;
  data[rowOffset + SLOT.WARP_X] = obj.warpX ?? 1;
  data[rowOffset + SLOT.WARP_Y] = obj.warpY ?? 1;
  data[rowOffset + SLOT.WARP_Z] = obj.warpZ ?? 1;

  // Grid repetition
  data[rowOffset + SLOT.GRID_SPACING_X] = obj.gridSpacingX ?? 0;
  data[rowOffset + SLOT.GRID_SPACING_Y] = obj.gridSpacingY ?? 0;
  data[rowOffset + SLOT.GRID_SPACING_Z] = obj.gridSpacingZ ?? 0;
  data[rowOffset + SLOT.GRID_COUNT_X] = obj.gridCountX ?? 0;
  data[rowOffset + SLOT.GRID_COUNT_Y] = obj.gridCountY ?? 0;
  data[rowOffset + SLOT.GRID_COUNT_Z] = obj.gridCountZ ?? 0;
  data[rowOffset + SLOT.GRID_SELF_BLEND] = obj.gridSelfBlend ?? 0;
  data[rowOffset + SLOT.GRID_RANGE] = obj.gridRange ?? 1;
  data[rowOffset + SLOT.GRID_WRAP_MODE] = obj.gridWrapMode ?? 0;
  data[rowOffset + SLOT.GRID_FOLD] = obj.gridFold ?? 0;
  data[rowOffset + SLOT.GRID_WRAP_RADIUS] = obj.gridWrapRadius ?? 2;
  data[rowOffset + SLOT.GRID_WRAP_AXIS] = obj.gridWrapAxis ?? 1;
  data[rowOffset + SLOT.GRID_WRAP_COUNT] = obj.gridWrapCount ?? 6;

  // Warp extension params
  data[rowOffset + SLOT.WARP_TARGET] = obj.warpTarget ?? 0;
  data[rowOffset + SLOT.GRID_SCALE] = obj.gridScale > 0.001 ? obj.gridScale : 1;
  data[rowOffset + SLOT.BOWL_AXIS] = obj.bowlAxis ?? 0;
  data[rowOffset + SLOT.BOWL_MODE] = (obj.bowlMode ?? 0) > 0.5 ? 1 : 0;
  data[rowOffset + SLOT.BOWL_KEEP_THICK] = (obj.bowlKeepThickness ?? 0) > 0.5 ? 1 : 0;
  data[rowOffset + SLOT.BOWL_TARGET] = obj.bowlTarget ?? 0;
  data[rowOffset + SLOT.PINCH_CENTER] = obj.pinchCenter ?? 0;
  data[rowOffset + SLOT.PINCH_AXIS] = obj.pinchAxis ?? 1;
  data[rowOffset + SLOT.PINCH_RANGE] = obj.pinchRange ?? 3;
  data[rowOffset + SLOT.PINCH_TARGET] = obj.pinchTarget ?? 0;
  // Bitfield (matches param-texture.ts): bit 0 = keep thickness,
  // bit 1 = smooth cutoff (soft |f| floor at the +-0.1 pinch clamp)
  data[rowOffset + SLOT.PINCH_KEEP_THICK] =
    ((obj.pinchKeepThickness ?? 0) > 0.5 ? 1 : 0) + ((obj.pinchSmooth ?? 0) > 0.5 ? 2 : 0);
  data[rowOffset + SLOT.PINCH_KEEP_TMAX] = pinchKeepMaxThickness(obj);

  // Pinch mode: Curve mode zeroes the gaussian amount and bakes the profile
  // LUT into row PINCH_CURVE_BASE_ROW + objIdx (see param-texture.ts)
  const pinch = pinchState(obj);
  const curveSel = (obj.pinchMode ?? 0) > 0.5;
  const curveRowOff = (PINCH_CURVE_BASE_ROW + objIdx) * TEX_WIDTH * 4;
  const curveOn = pinch.curveOn && curveRowOff + PINCH_CURVE_SAMPLES <= data.length;
  data[rowOffset + SLOT.PINCH_AMOUNT] = curveSel ? 0 : (obj.pinchAmount ?? 0);
  data[rowOffset + SLOT.PINCH_MODE] = curveOn ? 1 : 0;
  if (curveOn) data.set(samplePinchCurve(pinch.pts, PINCH_CURVE_SAMPLES), curveRowOff);

  // Bend warp (freeform bowl): curve-only — LUT into row BEND_CURVE_BASE_ROW
  // + objIdx (see param-texture.ts). Rows run out where the pinch LUTs start
  // (same ≤64-object limit).
  const bend = bendState(obj);
  const bendRowOff = (BEND_CURVE_BASE_ROW + objIdx) * TEX_WIDTH * 4;
  const bendOn = bend.active &&
    BEND_CURVE_BASE_ROW + objIdx < PINCH_CURVE_BASE_ROW &&
    bendRowOff + BEND_CURVE_SAMPLES <= data.length;
  data[rowOffset + SLOT.BEND_ON] = bendOn ? 1 : 0;
  if (bendOn) {
    const bendSamples = sampleBendCurve(bend.pts, BEND_CURVE_SAMPLES);
    data.set(bendSamples, bendRowOff);
    const bendRng = Math.max(obj.bendRange ?? 5, 0.01);
    data[rowOffset + SLOT.BEND_AMOUNT] = obj.bendAmount ?? 1;
    data[rowOffset + SLOT.BEND_RANGE] = bendRng;
    data[rowOffset + SLOT.BEND_AXIS] = Math.min(Math.max(Math.round(obj.bendAxis ?? 0), 0), 2);
    data[rowOffset + SLOT.BEND_TARGET] = (obj.bendTarget ?? 0) > 0.5 ? 1 : 0;
    let maxDs = 0;
    for (let i = 0; i < BEND_CURVE_SAMPLES - 1; i++) maxDs = Math.max(maxDs, Math.abs(bendSamples[i + 1] - bendSamples[i]));
    data[rowOffset + SLOT.BEND_MAX_SLOPE] = 1.5 * Math.abs(obj.bendAmount ?? 1) * maxDs * (BEND_CURVE_SAMPLES - 1) / bendRng; // 1.5x: Catmull-Rom LUT slope headroom
    data[rowOffset + SLOT.BEND_MAX_DISP] = bend.maxDisp;
  }

  // Grid blend params
  data[rowOffset + SLOT.GRID_CREASE_BLEND] = obj.gridCreaseBlend ?? 0;
  data[rowOffset + SLOT.GRID_FLOWER_AMOUNT] = obj.gridFlowerAmount ?? 0;

  // Spiral (wrapMode 4) + L-system (wrapMode 5) params
  data[rowOffset + SLOT.SPIRAL_TIGHTNESS] = obj.spiralTightness ?? 0.5;
  data[rowOffset + SLOT.SPIRAL_GROWTH] = obj.spiralGrowth ?? 1;
  data[rowOffset + SLOT.SPIRAL_SINGLE] = obj.spiralSingle ?? 0;
  data[rowOffset + SLOT.SPIRAL_TURN] = obj.spiralTurn ?? 30;
  // bit0 = align, bits1+ = flat plane (0 = 3D, 1/2/3 = normal X/Y/Z)
  data[rowOffset + SLOT.LSYS_ALIGN] =
    ((obj.lsysAlign ?? 1) > 0.5 ? 1 : 0) + 2 * (obj.lsysPlane ?? 0);

  // Outer cutout (bounding sphere/cube intersection)
  data[rowOffset + SLOT.OUTER_CUT_ENABLED] = obj.outerCutEnabled ? 1 : 0;
  data[rowOffset + SLOT.OUTER_CUT_SHAPE] = obj.outerCutShape ?? 0;
  data[rowOffset + SLOT.OUTER_CUT_SIZE] = obj.outerCutSize ?? 2;
  data[rowOffset + SLOT.OUTER_CUT_SIZE_Y] = obj.outerCutSizeY ?? obj.outerCutSize ?? 2;
  data[rowOffset + SLOT.OUTER_CUT_SIZE_Z] = obj.outerCutSizeZ ?? obj.outerCutSize ?? 2;
  data[rowOffset + SLOT.OUTER_CUT_BLEND] = obj.outerCutBlend ?? 0;
  data[rowOffset + SLOT.OUTER_CUT_TARGET] = obj.outerCutTarget ?? 0;
  data[rowOffset + SLOT.OUTER_CUT_OFF_X] = obj.outerCutX ?? 0;
  data[rowOffset + SLOT.OUTER_CUT_OFF_Y] = obj.outerCutY ?? 0;
  data[rowOffset + SLOT.OUTER_CUT_OFF_Z] = obj.outerCutZ ?? 0;

  // Type-specific params starting at PARAM_START_INDEX
  const typeKeys = TYPE_PARAMS[obj.type] || [];
  const typeDefaults = TYPE_DEFAULTS[obj.type] || {};
  for (let i = 0; i < typeKeys.length; i++) {
    const val = params[typeKeys[i]] ?? typeDefaults[typeKeys[i]] ?? 0;
    data[rowOffset + PARAM_START_INDEX + i] = val;
  }
}

// ── L-system expansion (keep in sync with flurry/src/lib/lsystem.ts) ─
const MAX_LSYS_NODES = 128;
const LSYS_BASE_ROW = 64;
const LSYS_ROWS_PER_OBJ = 4; // 4 rows x 64 texels = 128 nodes x 2 texels
const MAX_LSYS_STRING = 100000;

function rotateVec(v, k, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const cross = [
    k[1] * v[2] - k[2] * v[1],
    k[2] * v[0] - k[0] * v[2],
    k[0] * v[1] - k[1] * v[0],
  ];
  return [
    v[0] * c + cross[0] * s + k[0] * dot * (1 - c),
    v[1] * c + cross[1] * s + k[1] * dot * (1 - c),
    v[2] * c + cross[2] * s + k[2] * dot * (1 - c),
  ];
}

function expandLSystem(cfg) {
  const ruleMap = {};
  for (const part of (cfg.rules || "").split(/[;\n]/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      const key = part.slice(0, eq).trim();
      if (key.length === 1) ruleMap[key] = part.slice(eq + 1).trim();
    }
  }

  let s = (cfg.axiom || "F").trim() || "F";
  const iters = Math.max(0, Math.min(8, Math.round(cfg.iterations)));
  for (let i = 0; i < iters; i++) {
    let next = "";
    for (const ch of s) {
      next += ruleMap[ch] ?? ch;
      if (next.length > MAX_LSYS_STRING) break;
    }
    s = next.slice(0, MAX_LSYS_STRING);
  }

  const angle = (cfg.angle * Math.PI) / 180;
  const step = cfg.step;
  const decay = cfg.decay;

  let pos = [0, 0, 0];
  // Flat mode: pin "up" to the plane normal, start heading in-plane, ignore pitch/roll
  const plane = cfg.plane ?? 0;
  let H = [0, 1, 0];
  let L = [1, 0, 0];
  let U = [0, 0, 1];
  if (plane === 1)      { H = [0, 1, 0]; L = [0, 0, 1]; U = [1, 0, 0]; } // YZ plane
  else if (plane === 2) { H = [0, 0, 1]; L = [1, 0, 0]; U = [0, 1, 0]; } // XZ plane
  else if (plane === 3) { H = [1, 0, 0]; L = [0, 1, 0]; U = [0, 0, 1]; } // XY plane
  const flat = plane > 0;
  let depth = 0;
  let parentIdx = -1;
  const stack = [];
  const nodes = [];
  const posIndex = new Map();

  for (const ch of s) {
    switch (ch) {
      case "F": {
        const len = step * Math.pow(decay, depth);
        pos = [pos[0] + H[0] * len, pos[1] + H[1] * len, pos[2] + H[2] * len];
        const key =
          Math.round(pos[0] * 1000) + "," +
          Math.round(pos[1] * 1000) + "," +
          Math.round(pos[2] * 1000);
        let idx = posIndex.get(key);
        if (idx === undefined) {
          if (nodes.length >= MAX_LSYS_NODES) break;
          idx = nodes.length;
          nodes.push({ pos: [...pos], dir: [...H], scale: Math.pow(decay, depth), childCount: 0 });
          posIndex.set(key, idx);
        }
        if (parentIdx >= 0 && parentIdx !== idx) nodes[parentIdx].childCount++;
        parentIdx = idx;
        break;
      }
      case "f": {
        const len = step * Math.pow(decay, depth);
        pos = [pos[0] + H[0] * len, pos[1] + H[1] * len, pos[2] + H[2] * len];
        break;
      }
      case "+": { const nH = rotateVec(H, U, angle);  const nL = rotateVec(L, U, angle);  H = nH; L = nL; break; }
      case "-": { const nH = rotateVec(H, U, -angle); const nL = rotateVec(L, U, -angle); H = nH; L = nL; break; }
      case "&": { if (flat) break; const nH = rotateVec(H, L, angle);  const nU = rotateVec(U, L, angle);  H = nH; U = nU; break; }
      case "^": { if (flat) break; const nH = rotateVec(H, L, -angle); const nU = rotateVec(U, L, -angle); H = nH; U = nU; break; }
      case "\\": { if (flat) break; const nL = rotateVec(L, H, angle);  const nU = rotateVec(U, H, angle);  L = nL; U = nU; break; }
      case "/": { if (flat) break; const nL = rotateVec(L, H, -angle); const nU = rotateVec(U, H, -angle); L = nL; U = nU; break; }
      case "|": { const nH = rotateVec(H, U, Math.PI); const nL = rotateVec(L, U, Math.PI); H = nH; L = nL; break; }
      case "[":
        stack.push({ pos: [...pos], H: [...H], L: [...L], U: [...U], depth, parentIdx });
        depth++;
        break;
      case "]": {
        const st = stack.pop();
        if (st) { pos = st.pos; H = st.H; L = st.L; U = st.U; depth = st.depth; parentIdx = st.parentIdx; }
        break;
      }
      default:
        break;
    }
  }

  return nodes.map((n) => ({ pos: n.pos, dir: n.dir, scale: n.scale, leaf: n.childCount === 0 }));
}

function lsysNodesForObject(obj) {
  if ((obj.gridWrapMode ?? 0) !== 5) return null;
  const nodes = expandLSystem({
    axiom: obj.lsysAxiom ?? "F",
    rules: obj.lsysRules ?? "",
    iterations: obj.lsysIterations ?? 3,
    angle: obj.lsysAngle ?? 25,
    step: obj.lsysStep ?? 1,
    decay: obj.lsysDecay ?? 0.85,
    plane: obj.lsysPlane ?? 0,
  });
  return (obj.lsysLeavesOnly ?? 0) > 0.5 ? nodes.filter((n) => n.leaf) : nodes;
}

function writeLsysNodesToTexture(data, objIdx, nodes) {
  const base = (LSYS_BASE_ROW + objIdx * LSYS_ROWS_PER_OBJ) * TEX_WIDTH * 4;
  const n = Math.min(nodes.length, MAX_LSYS_NODES);
  for (let i = 0; i < n; i++) {
    const o = base + i * 8; // 2 texels = 8 floats per node
    data[o + 0] = nodes[i].pos[0];
    data[o + 1] = nodes[i].pos[1];
    data[o + 2] = nodes[i].pos[2];
    data[o + 3] = nodes[i].scale;
    data[o + 4] = nodes[i].dir[0];
    data[o + 5] = nodes[i].dir[1];
    data[o + 6] = nodes[i].dir[2];
    data[o + 7] = 0;
  }
  data[objIdx * TEX_WIDTH * 4 + SLOT.LSYS_NODE_COUNT] = n;
}

// ── Build blend texture data ────────────────────────────────────────
// A pair naming a group expands to one pair per member — exact for the
// union since smin is monotone (keep in sync with the page.tsx expansion).
function buildBlendTexture(sceneJson) {
  const blends = sceneJson.blends || [];
  if (blends.length === 0) return { data: new Float32Array(4), count: 0 };

  const objects = sceneJson.objects;
  const expandBlendId = (id) => {
    const idx = objects.findIndex((o) => o.id === id);
    if (idx < 0) return [];
    if (objects[idx].type !== "group") return [idx];
    return objects
      .map((o, i) => (o.groupId === id && o.type !== "group" ? i : -1))
      .filter((i) => i >= 0);
  };

  const pairs = [];
  for (const blend of blends) {
    for (const i of expandBlendId(blend.objectId1)) {
      for (const j of expandBlendId(blend.objectId2)) {
        if (i !== j && pairs.length < 128) pairs.push([i, j, blend.strength]);
      }
    }
  }
  if (pairs.length === 0) return { data: new Float32Array(4), count: 0 };

  const data = new Float32Array(pairs.length * 4);
  for (let b = 0; b < pairs.length; b++) {
    data[b * 4 + 0] = pairs[b][0];
    data[b * 4 + 1] = pairs[b][1];
    data[b * 4 + 2] = pairs[b][2];
    data[b * 4 + 3] = 0;
  }

  return { data, count: pairs.length };
}

// ── Compute bounding box ────────────────────────────────────────────
// Mirrors the shader's eulerRotation(rx,ry,rz) (GLSL mat3 is column-major, so
// the constructor's three vec3 groups are the COLUMNS). Returns row arrays.
function eulerRotationRows(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const c0 = [cy * cz, -cy * sz, sy];
  const c1 = [sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy];
  const c2 = [-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy];
  return [
    [c0[0], c1[0], c2[0]],
    [c0[1], c1[1], c2[1]],
    [c0[2], c1[2], c2[2]],
  ];
}

// Compose a member's group-frame AABB (half-extents `ext` centered at `pos`)
// through its group's transform: recenter on the group origin, add the
// repetition-fold span, apply scale/warp, pinch/bowl/bend inflation, the
// group rotation's AABB, and finally the group position. Conservative at
// every step — mirrors the member-level inflation chain in computeBBox.
function applyGroupEnvelope(ext, pos, g, member) {
  let e = [
    Math.abs(pos[0]) + ext[0],
    Math.abs(pos[1]) + ext[1],
    Math.abs(pos[2]) + ext[2],
  ];
  // Repetition fold span
  e[0] += (g.gridSpacingX || 0) * (g.gridCountX || 0);
  e[1] += (g.gridSpacingY || 0) * (g.gridCountY || 0);
  e[2] += (g.gridSpacingZ || 0) * (g.gridCountZ || 0);
  if ((g.gridWrapMode || 0) === 1) {
    // Match the object-level wrap bbox: conforming (unbent) copies live
    // inside radius R + extent, and the envelope is CUBED — the mesher
    // produces dust / non-watertight specks on strongly flattened volumes
    // (654x132x654 reproduces it even for plain object-level wraps; the
    // cubic shape is the proven one).
    const env = Math.abs(g.gridWrapRadius || 0) + Math.max(e[0], e[1], e[2]);
    e = [env, env, env];
  }
  // Scale / warp
  const gs = g.scale > 0.001 ? g.scale : 1;
  const gw = [g.warpX || 1, g.warpY || 1, g.warpZ || 1];
  e = [e[0] * gs * gw[0], e[1] * gs * gw[1], e[2] * gs * gw[2]];
  // Pinch radial growth (the two axes perpendicular to the pinch axis)
  const pinch = pinchState(g);
  if (pinch.active && pinch.maxF > 1.001) {
    const pAxis = Math.min(Math.max(Math.round(g.pinchAxis ?? 1), 0), 2);
    for (let i = 0; i < 3; i++) if (i !== pAxis) e[i] *= pinch.maxF;
  }
  // Group "Keep thickness": member thickness params grow along the group's
  // pinch axis by up to t·(1/minF − 1) in the group's FLAT (divided) frame;
  // e is already in the output frame here, so scale the inflation through
  // the group's scale/warp like the geometry it thickens.
  if (pinch.active && (g.pinchKeepThickness ?? 0) > 0.5 && member) {
    const pAxis = Math.min(Math.max(Math.round(g.pinchAxis ?? 1), 0), 2);
    e[pAxis] += memberThicknessInGroupFrame(member) * (1 / pinch.minF - 1) * gs * (gw[pAxis] || 1);
  }
  // Bowl displacement along its axis
  const bowlAmt = g.bowlAmount || 0;
  if (Math.abs(bowlAmt) > 1e-3) {
    const axis = Math.min(Math.max(Math.round(g.bowlAxis || 0), 0), 2);
    const planar = Math.max(e[(axis + 1) % 3], e[(axis + 2) % 3]);
    const bend = (g.bowlMode ?? 0) > 0.5;
    const R2 = (2 * Math.max(g.bowlRadius || 5, 0.05)) / Math.abs(bowlAmt);
    e[axis] += (bend ? Math.min(planar, R2) : planar) + 0.3;
  }
  // Bend (freeform bowl) displacement
  const bendW = bendState(g);
  if (bendW.active) {
    const axis = Math.min(Math.max(Math.round(g.bendAxis ?? 0), 0), 2);
    e[axis] += bendW.maxDisp * gs * (gw[axis] || 1) + 0.3;
  }
  // Group rotation → world AABB
  const rx = g.rotX || 0, ry = g.rotY || 0, rz = g.rotZ || 0;
  if (Math.abs(rx) + Math.abs(ry) + Math.abs(rz) > 0.001) {
    const M = eulerRotationRows(-rx, -ry, -rz);
    e = [0, 1, 2].map((i) =>
      Math.abs(M[0][i]) * e[0] + Math.abs(M[1][i]) * e[1] + Math.abs(M[2][i]) * e[2]
    );
  }
  return { ext: e, pos: [g.position?.[0] ?? 0, g.position?.[1] ?? 0, g.position?.[2] ?? 0] };
}

// Snowflake is complex — a generous half-extent box [x, planar, planar]
function snowflakeExtent(p) {
  const outerR = p.outerEnabled > 0.5 ? p.outerRadius + p.outerThickness : 0;
  const hookExt = (p.hookPosY || 0) + (p.hookSize || 0) + 1.5;
  const torusExt = Math.max(
    Math.abs(p.t3CenterPosY) + p.t3CenterRadius + 0.5,
    Math.abs(p.t3NeighborPosY) + p.t3NeighborRadius + 0.5,
    p.secEnabled > 0.5 ? Math.abs(p.secT3NeighborPosY) + p.secT3NeighborRadius + 0.5 : 0
  );
  const halfExtent = Math.max(outerR + 0.5, hookExt, torusExt) + 0.3;
  const hookMaxX = p.hookType > 0.5
    ? Math.abs(p.hookXOffset || 0) + 3.0
    : Math.abs(p.hookXOffset || 0) + 2.033;
  const xHalf = Math.max(0.75, hookMaxX + 0.3);
  return [xHalf, halfExtent, halfExtent];
}

// Frame (type 11): the referenced snowflake rows, effective bar half-size and
// largest scaled reach — keep in sync with bakeFrameRow in param-texture.ts
function frameBake(obj, objects) {
  const p = { ...TYPE_DEFAULTS.frame, ...(obj.params || {}) };
  const find = (id) => (id ? objects.findIndex((o) => o.id === id && o.type === "snowflake") : -1);
  const ia = find(obj.frameSnowA), ib = find(obj.frameSnowB), ic = find(obj.frameSnowC);
  const sc = (v) => (v > 0.001 ? v : 1);
  // reach = bounding-sphere radius of a scaled copy (the shader's cell cull);
  // reachX = its thin-axis half extent (the bbox only needs that in X)
  let reach = 0, reachX = 0;
  for (const [idx, scale] of [[ia, sc(p.scaleA)], [ib, sc(p.scaleB)], [ic, sc(p.scaleC)]]) {
    if (idx < 0) continue;
    const e = snowflakeExtent({ ...snowflakeDefaults, ...(objects[idx].params || {}) });
    reach = Math.max(reach, Math.hypot(e[0], e[1], e[2]) * scale);
    reachX = Math.max(reachX, e[0] * scale);
  }
  const barAuto = ia >= 0 ? (objects[ia].params?.rayThickness ?? 0.172) * sc(p.scaleA) : 0.27;
  const bar = p.barSize > 0.0005 ? p.barSize : barAuto;
  return { ia, ib, ic, reach, reachX, bar, p };
}

function computeBBox(sceneJson) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const obj of sceneJson.objects) {
    if (obj.hidden) continue;
    // Group rows have no geometry; their transforms enter via their members
    if (obj.type === "group") continue;

    const type = obj.type;
    const params = obj.params || {};
    const typeDefaults = TYPE_DEFAULTS[type] || {};
    const scale = obj.scale || 1;
    const warpX = obj.warpX || 1;
    const warpY = obj.warpY || 1;
    const warpZ = obj.warpZ || 1;

    // Base extent from type
    let baseExtent;
    if (type === "snowflake" || type === "snowflakeRail") {
      const p = { ...snowflakeDefaults, ...params };
      baseExtent = snowflakeExtent(p);
      const halfExtent = baseExtent[1];
      const xHalf = baseExtent[0];
      if (type === "snowflakeRail") {
        // Rail: spokes strung along one in-plane axis (see param-texture.ts)
        const railHalf = halfExtent + 0.5 * Math.max(p.numSpokes ?? 8, 1) * Math.abs(p.railSpacing ?? 2.5);
        baseExtent = [xHalf, railHalf, railHalf];
      }
    } else if (type === "sphere") {
      const r = params.radius ?? typeDefaults.radius ?? 1;
      baseExtent = [r, r, r];
    } else if (type === "torus") {
      // sdfTorus ring plane is YZ (uses length(p.yz)), thickness in X
      const R = params.majorRadius ?? typeDefaults.majorRadius ?? 1;
      const r = params.minorRadius ?? typeDefaults.minorRadius ?? 0.3;
      const concCount = params.concentricCount ?? typeDefaults.concentricCount ?? 1;
      const concSpacing = params.concentricSpacing ?? typeDefaults.concentricSpacing ?? 0.5;
      const outerR = R + (Math.max(1, concCount) - 1) * concSpacing;
      baseExtent = [r, outerR + r, outerR + r];
    } else if (type === "diamondTorus") {
      // sdDiamondTorusVesica ring plane is XZ (uses length(p.xz)), thickness in Y
      const R = params.majorRadius ?? typeDefaults.majorRadius ?? 1;
      const r = params.minorRadius ?? typeDefaults.minorRadius ?? 0.3;
      const concCount = params.concentricCount ?? typeDefaults.concentricCount ?? 1;
      const concSpacing = params.concentricSpacing ?? typeDefaults.concentricSpacing ?? 0.5;
      const outerR = R + (Math.max(1, concCount) - 1) * concSpacing;
      baseExtent = [outerR + r, r, outerR + r];
    } else if (type === "cylinder") {
      // sdfCylinder: axis along Y, radius in XZ
      const r = params.radius ?? typeDefaults.radius ?? 1;
      const h = params.height ?? typeDefaults.height ?? 2;
      baseExtent = [r, h / 2, r];
    } else if (type === "disk") {
      // sdfDisk: circle in YZ (normal along X), thickness along X
      const r = params.radius ?? typeDefaults.radius ?? 2;
      const th = params.thickness ?? typeDefaults.thickness ?? 0.2;
      baseExtent = [th / 2, r, r];
    } else if (type === "tube") {
      // sdfTube: hollow cylinder along Y, bounded by outer radius
      const R = params.radius ?? typeDefaults.radius ?? 1;
      const h = params.height ?? typeDefaults.height ?? 2;
      baseExtent = [R, h / 2, R];
    } else if (type === "relicBand") {
      // sdfRelicBand: ring axis X, outer face within bore + depth
      const R = (params.boreRadius ?? typeDefaults.boreRadius) + (params.depth ?? typeDefaults.depth);
      baseExtent = [params.halfWidth ?? typeDefaults.halfWidth, R, R];
    } else if (type === "cipherBand") {
      // sdfCipherBand: ring axis X, section within bore + wall
      const R = (params.boreRadius ?? typeDefaults.boreRadius) + (params.wall ?? typeDefaults.wall);
      baseExtent = [params.halfWidth ?? typeDefaults.halfWidth, R, R];
    } else if (type === "box") {
      // sdfBoxPrism rotates the XZ profile 45°, so its world AABB grows in X/Z
      let sx = params.sizeX ?? typeDefaults.sizeX ?? 1;
      let sy = params.sizeY ?? typeDefaults.sizeY ?? 1;
      let sz = params.sizeZ ?? typeDefaults.sizeZ ?? 1;
      const round = params.rounding ?? typeDefaults.rounding ?? 0;
      // Bulge (anti-taper) inflation — keep in sync with param-texture.ts
      const bAmt = Math.max(params.bulgeAmount ?? 0, 0);
      if (bAmt > 0.001) {
        const f = 1 + bAmt;
        const ax = Math.min(Math.max(Math.round(params.bulgeAxis ?? 1), 0), 2);
        const reach = Math.abs(params.bulgePos ?? 0) + (params.bulgeLength ?? 1) / 2 + (params.bulgeBlend ?? 0) / 4;
        if (ax === 0) { sy *= f; sz *= f; sx = Math.max(sx, reach); }
        else if (ax === 1) { sx *= f; sz *= f; sy = Math.max(sy, reach); }
        else { sx *= f; sy *= f; sz = Math.max(sz, reach); }
      }
      const xz = (sx + sz) / Math.SQRT2 + round;
      baseExtent = [xz, sy + round, xz];
    } else if (type === "frame") {
      const fb = frameBake(obj, sceneJson.objects);
      const bar = fb.bar * Math.SQRT2;
      const hy = 0.5 * (FRAME_ROWS - 1) * fb.p.pitch;
      const hz = 0.5 * (FRAME_COLS - 1) * fb.p.pitch;
      const bulge = ((fb.p.blend || 0) + (fb.p.cellBlend || 0)) / 4 + 0.3;
      baseExtent = [
        Math.max(fb.reachX, bar) + bulge,
        Math.max(hy + fb.reach, fb.p.frameH + Math.abs(fb.p.frameY) + bar) + bulge,
        Math.max(hz + fb.reach, fb.p.frameW + bar) + bulge,
      ];
    } else {
      baseExtent = [2, 2, 2]; // fallback
    }

    // Apply scale and warp
    let ext = [
      baseExtent[0] * scale * warpX,
      baseExtent[1] * scale * warpY,
      baseExtent[2] * scale * warpZ,
    ];

    // Grid expansion
    const spacingX = obj.gridSpacingX || 0;
    const spacingY = obj.gridSpacingY || 0;
    const spacingZ = obj.gridSpacingZ || 0;
    const countX = obj.gridCountX || 0;
    const countY = obj.gridCountY || 0;
    const countZ = obj.gridCountZ || 0;
    ext[0] += spacingX * countX;
    ext[1] += spacingY * countY;
    ext[2] += spacingZ * countZ;

    // Wrap expansion
    const wrapMode = obj.gridWrapMode || 0;
    if (wrapMode === 6) {
      // Fan: copies spun about wrapAxis through the origin — the two
      // perpendicular extents become the planar radius of the copy box
      const ax = Math.min(Math.max(Math.round(obj.gridWrapAxis ?? 1), 0), 2);
      const rp = Math.hypot(ext[(ax + 1) % 3], ext[(ax + 2) % 3]);
      ext[(ax + 1) % 3] = rp;
      ext[(ax + 2) % 3] = rp;
    }
    const wrapRadius = obj.gridWrapRadius || 2;
    const wrapCount = obj.gridWrapCount || 6;
    if (wrapMode >= 1 && wrapMode <= 4) {
      let effectiveRadius = wrapRadius;
      let copyScale = 1;
      if (wrapMode === 3) {
        // Polygon tessellation: outermost ring at rings * spacing
        const rings = Math.max(1, Math.round(obj.gridRange || 1));
        effectiveRadius = rings * wrapRadius;
      } else if (wrapMode === 4) {
        // Golden spiral: outermost copy at spacing * count^tightness
        const tight = Math.max(obj.spiralTightness ?? 0.5, 0.01);
        effectiveRadius = wrapRadius * Math.pow(Math.max(wrapCount, 1), tight);
        copyScale = Math.max(1, obj.spiralGrowth ?? 1);
      }
      const wrapEnvelope = effectiveRadius + Math.max(ext[0], ext[1], ext[2]) * copyScale;
      ext = [wrapEnvelope, wrapEnvelope, wrapEnvelope];
    } else if (wrapMode === 5) {
      // L-system: envelope from baked node positions + per-node copy extent.
      // Aligned copies can rotate arbitrarily, so use the bounding sphere.
      const nodes = lsysNodesForObject(obj) || [];
      const m = (obj.lsysAlign ?? 1) > 0.5
        ? Math.hypot(ext[0], ext[1], ext[2])
        : Math.max(ext[0], ext[1], ext[2]);
      let ex = ext[0], ey = ext[1], ez = ext[2];
      for (const nd of nodes) {
        ex = Math.max(ex, Math.abs(nd.pos[0]) + m * nd.scale);
        ey = Math.max(ey, Math.abs(nd.pos[1]) + m * nd.scale);
        ez = Math.max(ez, Math.abs(nd.pos[2]) + m * nd.scale);
      }
      ext = [ex, ey, ez];
    }

    // Pinch expansion: radial scaling can push the surface out by up to the
    // curve's (or gaussian's) max factor — applies to object and grid targets
    const pinch = pinchState(obj);
    if (pinch.active && pinch.maxF > 1.001) {
      ext = [ext[0] * pinch.maxF, ext[1] * pinch.maxF, ext[2] * pinch.maxF];
    }
    // "Keep thickness" thickens features along the pinch axis by up to
    // t·(1/minF − 1) in world units (the axis dim is not re-compressed by
    // the warp output).
    if (pinch.active && (obj.pinchKeepThickness ?? 0) > 0.5) {
      const pAxis = Math.min(Math.max(Math.round(obj.pinchAxis ?? 1), 0), 2);
      const gsK = (obj.warpTarget ?? 0) === 2 && obj.gridScale > 0.001 ? obj.gridScale : 1;
      ext[pAxis] += typeMaxThickness(obj) * scale * Math.max(warpX, warpY, warpZ) * gsK * (1 / pinch.minF - 1);
    }

    // warpTarget 2 ("Both"): the whole repeated field is scaled uniformly on top
    if ((obj.warpTarget ?? 0) === 2 && obj.gridScale > 0.001) {
      ext = ext.map((e) => e * obj.gridScale);
    }

    // Bowl warp displaces along its axis: Lift by up to the planar extent,
    // Bend curls up by at most the sphere diameter 2R (R = radius/|amount|).
    // (Grid-level bowl acts on the whole field, so this covers both targets.)
    const bowlAmt = obj.bowlAmount || 0;
    if (Math.abs(bowlAmt) > 1e-3) {
      const axis = Math.min(Math.max(Math.round(obj.bowlAxis || 0), 0), 2);
      const planar = Math.max(ext[(axis + 1) % 3], ext[(axis + 2) % 3]);
      const bend = (obj.bowlMode ?? 0) > 0.5;
      const R2 = (2 * Math.max(obj.bowlRadius || 5, 0.05)) / Math.abs(bowlAmt);
      ext[axis] += (bend ? Math.min(planar, R2) : planar) + 0.3;
    }

    // Bend warp (freeform bowl) shears along its axis by at most
    // |amount| * max|C| — PCHIP never overshoots the control points. The
    // displacement is in the object's divided frame, so scale it back up.
    // (Covers both object and grid targets, like the bowl above.)
    const bendW = bendState(obj);
    if (bendW.active) {
      const axis = Math.min(Math.max(Math.round(obj.bendAxis ?? 0), 0), 2);
      const warpAxis = [warpX, warpY, warpZ][axis] || 1;
      const gs = (obj.warpTarget ?? 0) === 2 && obj.gridScale > 0.001 ? obj.gridScale : 1;
      ext[axis] += bendW.maxDisp * scale * warpAxis * gs + 0.3;
    }

    // Rotation expansion: exact AABB of the rotated local box. The shader
    // maps world→local with lp = eulerRotation(-rx,-ry,-rz) * p, so the
    // local→world map is that matrix's transpose; the world half-extent per
    // axis is the abs-row-sum of it applied to the local half-extents.
    // (Always ≤ the old bounding-sphere fallback, which blew the bbox up
    // to a huge cube for scenes with several rotated objects.)
    const rotX = obj.rotX || 0;
    const rotY = obj.rotY || 0;
    const rotZ = obj.rotZ || 0;
    if (Math.abs(rotX) + Math.abs(rotY) + Math.abs(rotZ) > 0.001) {
      const M = eulerRotationRows(-rotX, -rotY, -rotZ); // rows of world→local
      // world half-extent_i = sum_j |M^T[i][j]| * ext[j] = sum_j |M[j][i]| * ext[j]
      ext = [0, 1, 2].map((i) =>
        Math.abs(M[0][i]) * ext[0] + Math.abs(M[1][i]) * ext[1] + Math.abs(M[2][i]) * ext[2]
      );
    }

    // Position offset — grouped members compose through the group envelope
    // (their position is in the group's frame, not the world)
    let pos = [obj.position?.[0] ?? 0, obj.position?.[1] ?? 0, obj.position?.[2] ?? 0];
    const grp = obj.groupId
      ? sceneJson.objects.find((o) => o.id === obj.groupId && o.type === "group")
      : null;
    if (grp) {
      if (grp.hidden) continue;
      const composed = applyGroupEnvelope(ext, pos, grp, obj);
      ext = composed.ext;
      pos = composed.pos;
    }

    minX = Math.min(minX, pos[0] - ext[0]);
    minY = Math.min(minY, pos[1] - ext[1]);
    minZ = Math.min(minZ, pos[2] - ext[2]);
    maxX = Math.max(maxX, pos[0] + ext[0]);
    maxY = Math.max(maxY, pos[1] + ext[1]);
    maxZ = Math.max(maxZ, pos[2] + ext[2]);
  }

  // Add padding
  const pad = 0.5;
  minX -= pad; minY -= pad; minZ -= pad;
  maxX += pad; maxY += pad; maxZ += pad;

  return {
    size: [
      Math.round((maxX - minX) * 1000) / 1000,
      Math.round((maxY - minY) * 1000) / 1000,
      Math.round((maxZ - minZ) * 1000) / 1000,
    ],
    center: [
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2,
    ],
  };
}

// ── Build scene GLSL + textures ──────────────────────────────────────
function buildScene(sceneJson) {
  const objects = sceneJson.objects;
  const numObjects = objects.length;

  // Build param texture — extra rows past LSYS_BASE_ROW hold L-system node
  // blocks (4 rows per object) and rows past PINCH_CURVE_BASE_ROW hold pinch
  // profile LUTs (1 row per object), matching the shader's hardcoded row math
  const texHeight = Math.max(
    LSYS_BASE_ROW + numObjects * LSYS_ROWS_PER_OBJ,
    PINCH_CURVE_BASE_ROW + numObjects
  );
  const paramData = new Float32Array(TEX_WIDTH * 4 * texHeight);
  for (let i = 0; i < objects.length; i++) {
    writeObjectToTexture(paramData, i, objects[i]);
    const nodes = lsysNodesForObject(objects[i]);
    if (nodes) writeLsysNodesToTexture(paramData, i, nodes);
  }
  // Group wiring (second pass — needs every row's index): members point at
  // their group's row; group rows get bend forced to the grid-owner target
  // that evalEntity's applyBend call uses.
  for (let i = 0; i < objects.length; i++) {
    const rowOffset = i * TEX_WIDTH * 4;
    const obj = objects[i];
    const gIdx = obj.type !== "group" && obj.groupId
      ? objects.findIndex((o) => o.id === obj.groupId && o.type === "group")
      : -1;
    paramData[rowOffset + SLOT.GROUP_IDX] = gIdx >= 0 ? gIdx + 1 : 0;
    const tIdx = obj.mode === "subtract" && obj.subtractTarget
      ? objects.findIndex((o) => o.id === obj.subtractTarget)
      : -1;
    paramData[rowOffset + SLOT.SUBTRACT_TARGET] = tIdx >= 0 ? tIdx + 1 : 0;
    paramData[rowOffset + SLOT.SUBTRACT_BLEND] = obj.mode === "subtract" ? Math.max(0, obj.subtractBlend ?? 0) : 0;
    if (obj.type === "frame") {
      const fb = frameBake(obj, objects);
      paramData[rowOffset + SLOT.FRAME_SNOW_A] = fb.ia >= 0 ? fb.ia + 1 : 0;
      paramData[rowOffset + SLOT.FRAME_SNOW_B] = fb.ib >= 0 ? fb.ib + 1 : 0;
      paramData[rowOffset + SLOT.FRAME_SNOW_C] = fb.ic >= 0 ? fb.ic + 1 : 0;
      paramData[rowOffset + SLOT.FRAME_BAR] = fb.bar;
      paramData[rowOffset + SLOT.FRAME_REACH] = fb.reach;
    }
    if (obj.type === "group" && paramData[rowOffset + SLOT.BEND_ON] > 0.5) {
      paramData[rowOffset + SLOT.BEND_TARGET] = 1;
    }
    // Group pinch "Keep thickness": bake the max compensated member thickness
    // (group-frame units) into the GROUP row's tMax slot — writeObjectToTexture
    // bakes 0 for group rows since it can't see the members.
    if (obj.type === "group" && (obj.pinchKeepThickness ?? 0) > 0.5) {
      let tMax = 0;
      for (const m of objects) {
        if (m.groupId !== obj.id || m.type === "group" || m.hidden) continue;
        tMax = Math.max(tMax, memberThicknessInGroupFrame(m));
      }
      paramData[rowOffset + SLOT.PINCH_KEEP_TMAX] = tMax;
    }
  }

  // Build blend texture
  const blend = buildBlendTexture(sceneJson);

  // Compute bbox
  const bbox = bboxOverride || computeBBox(sceneJson);

  // Build GLSL
  const blendH = Math.max(blend.count, 1);
  const sdfCode = [
    `#define PI 3.141592653589793`,
    `#define TEX_H ${texHeight}.0`,
    `#define BLEND_H ${blendH}.0`,
    ``,
    `int _oid;`,
    `int _hitId;`,
    ``,
    `// Texture access helpers`,
    `float P(int obj, int idx) {`,
    `  float fidx = float(idx);`,
    `  float texel = floor(fidx / 4.0);`,
    `  float ch = fidx - texel * 4.0;`,
    `  vec2 uv = vec2((texel + 0.5) / 64.0, (float(obj) + 0.5) / TEX_H);`,
    `  vec4 v = texture2D(uParamTex, uv);`,
    `  if (ch < 0.5) return v.x;`,
    `  if (ch < 1.5) return v.y;`,
    `  if (ch < 2.5) return v.z;`,
    `  return v.w;`,
    `}`,
    `vec4 P4(int obj, int texel) {`,
    `  vec2 uv = vec2((float(texel) + 0.5) / 64.0, (float(obj) + 0.5) / TEX_H);`,
    `  return texture2D(uParamTex, uv);`,
    `}`,
    ``,
    `#define RAIL 1 // Snowflake Rail paths compiled in (viewer toggles this per scene)`,
    `// "Keep thickness" multiplier (set by applyPinch)`,
    `float _pnThick = 1.0;`,
    `// Snowflake param defines`,
    generateSnowflakeDefines(),
    ``,
    sdfBody,
    sceneCode,
    `float mapDistance(vec3 p) {`,
    `  return sceneSdf(p);`,
    `}`,
    ``,
  ].join("\n");

  const textureDeclarations = [
    `uniform sampler2D uParamTex;`,
    `uniform sampler2D uBlendTex;`,
    `uniform int uObjectCount;`,
    `uniform int uTargetedSubCount;`,
    `uniform int uBlendCount;`,
  ].join("\n");

  const resolution = bbox.size.map((s) => Math.round(s * density));

  // DUMP=dir env: write the generated shader + param rows for debugging
  if (process.env.DUMP) {
    const fs = require("fs");
    fs.mkdirSync(process.env.DUMP, { recursive: true });
    fs.writeFileSync(`${process.env.DUMP}/sdf.glsl`, sdfCode);
    fs.writeFileSync(`${process.env.DUMP}/paramData.json`, JSON.stringify(Array.from(paramData)));
    console.log(`  [dump] shader + paramData -> ${process.env.DUMP}`);
  }

  return {
    sdfCode,
    textureDeclarations,
    paramData,
    texHeight,
    blendData: blend.data,
    objectCount: numObjects,
    targetedSubCount: objects.filter((o) => o.mode === "subtract" && !o.hidden && o.subtractTarget && objects.some((t) => t.id === o.subtractTarget)).length,
    blendCount: blend.count,
    size: bbox.size,
    center: bbox.center,
    resolution,
  };
}

// ── Download tracking ────────────────────────────────────────────────
function createDownloadTracker(cdpSession) {
  let completedCount = 0;
  const pending = new Map();

  cdpSession.on("Browser.downloadWillBegin", (evt) => {
    pending.set(evt.guid, evt.suggestedFilename);
    console.log(`  Download started: ${evt.suggestedFilename}`);
  });

  cdpSession.on("Browser.downloadProgress", (evt) => {
    if (evt.state === "completed" || evt.state === "canceled") {
      const name = pending.get(evt.guid) || evt.guid;
      if (evt.state === "completed") {
        console.log(`  Download complete: ${name}`);
        completedCount++;
      } else {
        console.log(`  Download canceled: ${name}`);
      }
      pending.delete(evt.guid);
    }
  });

  return {
    waitForCount: (expectedCount) =>
      new Promise((resolve) => {
        console.log(`  Waiting for ${expectedCount} download(s) to complete...`);
        const check = () => {
          if (completedCount >= expectedCount && pending.size === 0) {
            return resolve();
          }
          setTimeout(check, 500);
        };
        check();
      }),
  };
}

// ── Main: batch process ──────────────────────────────────────────────
async function main() {
  const jobs = sceneFiles.map((f) => {
    const json = JSON.parse(fs.readFileSync(f, "utf8"));
    const name = json.name || path.basename(f, ".json");
    const scene = buildScene(json);
    const finalSizeMM = sizeMM ?? json.sizeMM ?? 30;
    return { name, scene, sizeMM: finalSizeMM, file: f };
  });

  console.log(`\nBatch scene meshing: ${jobs.length} scene(s)\n`);
  for (const j of jobs) {
    console.log(
      `   ${j.name}  size:[${j.scene.size}]  res:[${j.scene.resolution}]  objects:${j.scene.objectCount}  blends:${j.scene.blendCount}`
    );
  }
  console.log("");

  const downloadPath = path.join(os.homedir(), "Downloads");

  const browser = await puppeteer.launch({
    headless: false,
    protocolTimeout: 0,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const browserCdp = await browser.target().createCDPSession();
  await browserCdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadPath,
    eventsEnabled: true,
  });

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const s = job.scene;
    console.log(
      `\n[${i + 1}/${jobs.length}] ${job.name} (${s.resolution.join("x")}, ${s.objectCount} objects)`
    );

    const page = await browser.newPage();

    const pageCdp = await page.createCDPSession();
    await pageCdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadPath,
      eventsEnabled: true,
    });
    const tracker = createDownloadTracker(pageCdp);

    page.on("console", (msg) => console.log(`  [Browser] ${msg.text()}`));

    const SERVER_PORT = process.env.MESHER_PORT || 8000;
    await page.goto(`http://localhost:${SERVER_PORT}?cachebust=` + Date.now());
    await page.waitForSelector(".editor");
    await page.waitForFunction(
      () =>
        window.cubeMarch &&
        window.twgl &&
        window.exporter &&
        window.editor &&
        window.ractive,
      { timeout: 10000 }
    );

    // Pass all data into page.evaluate
    const result = await page.evaluate(
      (sdfCode, texDecl, paramDataArr, texHeight, blendDataArr, objectCount, targetedSubCount, blendCount, sceneSize, sceneCenter, resolution, meshName, finalSizeMM) => {
        return new Promise((resolve) => {
          const run = async () => {
            try {
              const gl = window.cubeMarch.scene.gl;

              // WebGL 2: float textures are native (no OES_texture_float needed)
              // Use RGBA32F sized internal format for float texture creation

              // Create param texture (TEX_WIDTH x texHeight, RGBA Float32);
              // rows past 64 hold L-system node blocks
              const paramTex = gl.createTexture();
              gl.bindTexture(gl.TEXTURE_2D, paramTex);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
              gl.texImage2D(
                gl.TEXTURE_2D, 0, gl.RGBA32F,
                64, texHeight,
                0, gl.RGBA, gl.FLOAT,
                new Float32Array(paramDataArr)
              );

              // Create blend texture (1 x blendH, RGBA Float32)
              const blendH = Math.max(blendCount, 1);
              const blendTex = gl.createTexture();
              gl.bindTexture(gl.TEXTURE_2D, blendTex);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
              gl.texImage2D(
                gl.TEXTURE_2D, 0, gl.RGBA32F,
                1, blendH,
                0, gl.RGBA, gl.FLOAT,
                new Float32Array(blendDataArr)
              );

              gl.bindTexture(gl.TEXTURE_2D, null);

              // Set up editor and ractive controls
              window.editor.setValue(sdfCode);
              window.ractive.set("bounding.size.width", sceneSize[0]);
              window.ractive.set("bounding.size.height", sceneSize[1]);
              window.ractive.set("bounding.size.depth", sceneSize[2]);
              window.ractive.set("download.resolution.x", resolution[0]);
              window.ractive.set("download.resolution.y", resolution[1]);
              window.ractive.set("download.resolution.z", resolution[2]);

              const dims = resolution;
              const cx = sceneCenter[0];
              const cy = sceneCenter[1];
              const cz = sceneCenter[2];
              const bounds = [
                [cx - sceneSize[0] / 2, cy - sceneSize[1] / 2, cz - sceneSize[2] / 2],
                [cx + sceneSize[0] / 2, cy + sceneSize[1] / 2, cz + sceneSize[2] / 2],
              ];

              window.cubeMarch.setVolume(dims, bounds);
              window.exporter.startModel(
                meshName + "-" + dims[0] + "x" + dims[1] + "x" + dims[2]
              );

              console.log("Starting mesh generation for " + meshName + "...");

              window.cubeMarch.march({
                mapDistance: sdfCode,
                textureDeclarations: texDecl,
                uniforms: {
                  uParamTex: paramTex,
                  uBlendTex: blendTex,
                  uObjectCount: objectCount,
                  uTargetedSubCount: targetedSubCount,
                  uBlendCount: blendCount,
                },
                onSection: (data) => {
                  window.exporter.addSection(data.vertices, data.faces);
                },
                onProgress: (cubesMarched, totalCubes) => {
                  const pct = ((cubesMarched / totalCubes) * 100).toFixed(1);
                  window.ractive.set("progress", meshName + ": " + pct + "%");
                },
                onDone: () => {
                  console.log("Mesh complete: " + meshName);
                  window.exporter.finishModel();
                  const totalParts = window.exporter.part + 1;
                  console.log("Total parts: " + totalParts);
                  resolve({ status: "done", totalParts });
                },
              });
            } catch (err) {
              console.error("Error:", err.message);
              resolve({ status: "error", message: err.message });
            }
          };
          run();
        });
      },
      s.sdfCode,
      s.textureDeclarations,
      Array.from(s.paramData),
      s.texHeight,
      Array.from(s.blendData),
      s.objectCount,
      s.targetedSubCount,
      s.blendCount,
      s.size,
      s.center,
      s.resolution,
      job.name,
      job.sizeMM
    );

    if (result.status === "error") {
      console.error(`  ERROR: ${job.name}: ${result.message}`);
    } else {
      await tracker.waitForCount(result.totalParts);
      console.log(`  Done: ${job.name} (${result.totalParts} parts)`);
    }

    await pageCdp.detach();
    await page.close();
  }

  await browserCdp.detach();
  console.log(
    `\nAll done! ${jobs.length} mesh(es) downloaded to ~/Downloads`
  );
  console.log("   Closing browser...");
  await browser.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

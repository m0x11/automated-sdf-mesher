// Ephemeris ring sizing — parametric, replacing uniform mesh scaling.
// JS port of product-playground/src/products/ephemeris/{sizing,facemetrics}.ts
// (keep in lockstep with the playground — it is the design source of truth).
//
// SIZE 6 IS CANONICAL: at and below size 6 the ring scales uniformly with
// the bore, exactly reproducing the old pipeline. Above 6:
//   - bore follows the US chart,
//   - the cap (top part) is SOLVED so the MEASURED face (dish lip including
//     the shoulder bulge, via a numeric mirror of the head solid) hits the
//     tier target: Medium continues the size-6 face at its bottom size,
//     Large lands LARGE_FACE_TARGET_MM at size 13,
//   - the dial keeps the canonical size-6 edge margin against the measured
//     face,
//   - band cross-section / stamp / engraving are pinned at canonical scale.
//
// The five dials {boreR, bandDepth, capScale, dialScale, detail} drive every
// derived dimension in the sized SDF (setup-ephemeris-sized.js).

// US ring size -> inner diameter in mm (ring_ray_resizer.py chart)
const SIZE_CHART_MM = {
  3: 14.1, 3.5: 14.5, 4: 14.9, 4.5: 15.3,
  5: 15.7, 5.5: 16.1, 6: 16.5, 6.5: 16.9,
  7: 17.3, 7.5: 17.7, 8: 18.1, 8.5: 18.5,
  9: 19.0, 9.5: 19.4, 10: 19.8, 10.5: 20.2,
  11: 20.6, 11.5: 21.0, 12: 21.4, 12.5: 21.8,
  13: 22.2,
};

const MM_PER_UNIT = 18.1 / 7.8; // 3.9 model units == the size-8 bore radius
const UNIT_PER_MM = 7.8 / 18.1;
const CANONICAL_SIZE = 6;
const CANON_SCALE = SIZE_CHART_MM[6] / SIZE_CHART_MM[8]; // 0.9116...
const CAP_BASE_MM = 6.0 * MM_PER_UNIT; // un-scaled face: ringTop radius 3.0
const BAND_DEPTH_BASE_MM = 0.58 * MM_PER_UNIT;
const LARGE_FACE_TARGET_MM = 15.5;
const DIAL_EDGE_UNITS = 2.2 * 1.32 + 0.04 * 1.5; // Neptune channel outer edge

const TIERS = [
  { id: 'S', min: 3, max: 6, bandDepthMm: BAND_DEPTH_BASE_MM * CANON_SCALE },
  { id: 'M', min: 6.5, max: 9.5, bandDepthMm: BAND_DEPTH_BASE_MM * CANON_SCALE + 0.1 },
  { id: 'L', min: 10, max: 13, bandDepthMm: BAND_DEPTH_BASE_MM * CANON_SCALE + 0.2 },
];

function innerDiameterMm(size) {
  const d = SIZE_CHART_MM[size];
  if (d === undefined) throw new Error(`unknown US ring size: ${size}`);
  return d;
}
function boreRadiusUnits(size) { return (innerDiameterMm(size) / 2) * UNIT_PER_MM; }
function oldScale(size) { return innerDiameterMm(size) / SIZE_CHART_MM[8]; }
function tierOf(size) { return TIERS.find((t) => size <= t.max) || TIERS[TIERS.length - 1]; }
function uniformScaleOrNull(size) { return size <= CANONICAL_SIZE ? oldScale(size) : null; }

function bandDepthUnits(size) {
  const k = uniformScaleOrNull(size);
  if (k !== null) return 0.58 * k;
  return tierOf(size).bandDepthMm * UNIT_PER_MM;
}
function detailScale(size) { return uniformScaleOrNull(size) ?? CANON_SCALE; }
// bore-engraving em multiplier: the engraving table authored the text at
// 1.0 em-per-unit and the old pipeline scaled it WITH the ring — keeping
// that (not the canonical detail scale) keeps the date as big as it always
// was at every size, continuous with the uniform region below size 6
function textScale(size) { return oldScale(size); }

// --------------------------------------------------------------------------
// Numeric mirror of the head SOLID (facemetrics.ts port) — measures the true
// dish lip per size. KEEP IN LOCKSTEP with the sized SDF geometry.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
const smin = (a, b, k) => { const h = clamp01(0.5 + (0.5 * (b - a)) / k); return mix(b, a, h) - k * h * (1 - h); };
const smax = (a, b, k) => { const h = clamp01(0.5 + (0.5 * (a - b)) / k); return mix(b, a, h) + k * h * (1 - h); };
const cyl = (p, r, hh) => {
  const dx = Math.hypot(p[0], p[2]) - r;
  const dy = Math.abs(p[1]) - hh;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
};
const torusX = (p, major, minor) => Math.hypot(Math.hypot(p[1], p[2]) - major, p[0]) - minor;
const box = (p, s) => {
  const qx = Math.abs(p[0]) - s[0];
  const qy = Math.abs(p[1]) - s[1];
  const qz = Math.abs(p[2]) - s[2];
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) +
         Math.min(Math.max(qx, Math.max(qy, qz)), 0);
};

function headSolid(p, d) {
  const outerR = d.boreR + d.bandDepth;
  const bcy = -(outerR + 0.02 * d.cap);
  const shoulderK = (7.3 * -bcy) / 4.5;
  const minor = 0.48 * d.detail;
  const major = outerR - minor;

  const fx = p[0] / d.cap, fy = p[1] / d.cap + 0.8, fz = p[2] / d.cap;
  const ref = cyl([fx, fy + 0.5, fz], 1.2, 0.4) * d.cap;
  const top = cyl([fx, fy - 0.4, fz], 3.0, 2.0) * d.cap;

  const band = torusX([p[0] / 2, p[1] - bcy, p[2]], major, minor);
  const drill = cyl([-(p[1] - bcy), p[0], p[2]], d.boreR, 5.0);
  const reach = outerR + 1.5;
  const sa = Math.abs(p[0]) - (d.boreR + 0.85 * d.detail);
  const sb = p[1] - bcy;
  const edge = box([-sb - d.boreR, p[2], -sa], [d.boreR, reach, d.boreR]);
  const shave = Math.min(edge, cyl([-sb / 1.11, p[2], -sa], d.boreR, reach));

  const smoothedBand = smin(ref, band, shoulderK);
  const ring = smin(top, smoothedBand, 0.32 * d.cap);
  let full = smax(ring, -shave, 0.64 * d.detail);
  full = Math.max(-drill, full);
  return full;
}

function faceLipRadius(d) {
  const sphereR = 15 * d.cap;
  let lip = Infinity;
  const STEPS = 24;
  for (let i = 0; i <= STEPS; i++) {
    const th = (i / STEPS) * (Math.PI / 2);
    const co = Math.cos(th), si = Math.sin(th);
    let last = 0;
    for (let r = 0.1; r < 4.8 * d.cap; r += 0.004) {
      const y = sphereR - Math.sqrt(sphereR * sphereR - r * r);
      if (headSolid([r * co, y, r * si], d) < 0) last = r;
      else if (last > 0) break;
    }
    lip = Math.min(lip, last);
  }
  return lip;
}

// --------------------------------------------------------------------------
// Cap solving (measured-face targets) + dial derivation.

const capCache = new Map();
function measuredFaceMmAt6() {
  const k = CANON_SCALE;
  return 2 * MM_PER_UNIT * faceLipRadius({ boreR: boreRadiusUnits(6), bandDepth: 0.58 * k, cap: k, detail: k });
}
function solveCapScale(anchorSize, faceTargetMm, bandDepthMm) {
  const targetR = (faceTargetMm / 2) * UNIT_PER_MM;
  const boreR = boreRadiusUnits(anchorSize);
  const bandDepth = bandDepthMm * UNIT_PER_MM;
  let lo = 0.5, hi = 1.6;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (faceLipRadius({ boreR, bandDepth, cap: mid, detail: CANON_SCALE }) < targetR) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
function capScale(size) {
  const k = uniformScaleOrNull(size);
  if (k !== null) return k;
  const t = tierOf(size);
  let v = capCache.get(t.id);
  if (v === undefined) {
    if (t.id === 'L') v = solveCapScale(t.max, LARGE_FACE_TARGET_MM, t.bandDepthMm);
    else v = solveCapScale(t.min, measuredFaceMmAt6(), t.bandDepthMm);
    capCache.set(t.id, v);
  }
  return v;
}

const lipCache = new Map();
function faceLipUnits(size) {
  let v = lipCache.get(size);
  if (v === undefined) {
    v = faceLipRadius({
      boreR: boreRadiusUnits(size), bandDepth: bandDepthUnits(size),
      cap: capScale(size), detail: detailScale(size),
    });
    lipCache.set(size, v);
  }
  return v;
}
function dialMarginUnits() { return faceLipUnits(CANONICAL_SIZE) - DIAL_EDGE_UNITS * CANON_SCALE; }
function dialScale(size) {
  const k = uniformScaleOrNull(size);
  if (k !== null) return k;
  return (faceLipUnits(size) - dialMarginUnits()) / DIAL_EDGE_UNITS;
}

// --------------------------------------------------------------------------
// Public API.

/** The five geometry dials for a size, plus mesher framing helpers. */
function computeSizeDials(size) {
  if (SIZE_CHART_MM[size] === undefined) throw new Error(`unknown US ring size: ${size}`);
  const boreR = boreRadiusUnits(size);
  const bandDepth = bandDepthUnits(size);
  const cap = capScale(size);
  const dial = dialScale(size);
  const detail = detailScale(size);

  const outer = boreR + bandDepth;
  const bandCenterY = -(outer + 0.02 * cap);
  const ringBotY = bandCenterY - outer;
  const lip = faceLipUnits(size);
  const sphereR = 15 * cap;
  const lipHeight = sphereR - Math.sqrt(Math.max(sphereR * sphereR - lip * lip, 0));
  // vertical middle of the ring (scene frame) — the mesher centers on this
  const centerY = (lipHeight + ringBotY) / 2;
  const halfSpanY = (lipHeight - ringBotY) / 2;
  const halfWidth = Math.max(outer, lip * 1.25 + 0.3);
  // cubic bounding box with margin
  const boxSize = Math.ceil((2 * Math.max(halfSpanY, halfWidth) + 0.7) * 10) / 10;

  return {
    size,
    uniforms: {
      uBoreR: boreR,
      uBandDepth: bandDepth,
      uCapScale: cap,
      uDialScale: dial,
      uDetail: detail,
      uTextScale: textScale(size),
      uCenterY: centerY,
    },
    innerDiameterMm: innerDiameterMm(size),
    faceMm: 2 * lip * MM_PER_UNIT,
    mmPerUnit: MM_PER_UNIT,
    boxSize,
  };
}

module.exports = {
  computeSizeDials,
  MM_PER_UNIT,
  SIZE_CHART_MM,
  innerDiameterMm,
};

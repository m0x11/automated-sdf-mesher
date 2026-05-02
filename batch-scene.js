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

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--size" && args[i + 1]) {
    sizeMM = parseFloat(args[++i]);
  } else if (args[i] === "--density" && args[i + 1]) {
    density = parseFloat(args[++i]);
  } else if (!args[i].startsWith("--")) {
    inputPath = args[i];
  }
}

if (!inputPath) {
  console.error(
    "Usage: node batch-scene.js <scene.json | scenes-dir/> [--size 30] [--density 130]"
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
  sphere: ["radius"],
  torus: ["majorRadius", "minorRadius", "vesica", "disc"],
  diamondTorus: ["majorRadius", "minorRadius", "edgeSoften", "vesica"],
};

const TYPE_DEFAULTS = {
  snowflake: snowflakeDefaults,
  sphere: { radius: 1 },
  torus: { majorRadius: 1, minorRadius: 0.3, vesica: 0, disc: 0 },
  diamondTorus: { majorRadius: 1, minorRadius: 0.3, edgeSoften: 0, vesica: 0 },
};

const SDF_TYPE_INDEX = { snowflake: 0, sphere: 1, torus: 2, diamondTorus: 3 };
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
  GRID_WRAP_RADIUS: 249,
  GRID_WRAP_AXIS: 250,
  GRID_WRAP_COUNT: 251,
  WARP_TARGET: 220,
  BOWL_AXIS: 221,
  BOWL_TARGET: 222,
  PINCH_AMOUNT: 223,
  PINCH_CENTER: 224,
  PINCH_AXIS: 225,
  PINCH_RANGE: 226,
  PINCH_TARGET: 227,
};

// ── Extract shader GLSL from page.tsx ────────────────────────────────

// 1. Generate snowflake #defines (same as generateSnowflakeDefines in param-texture.ts)
function generateSnowflakeDefines() {
  const lines = [];
  for (let i = 0; i < snowflakeParamKeys.length; i++) {
    const key = snowflakeParamKeys[i];
    const uName = "u" + key.charAt(0).toUpperCase() + key.slice(1);
    lines.push(`#define ${uName} P(_oid, ${PARAM_START_INDEX + i})`);
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
  data[rowOffset + SLOT.GRID_WRAP_RADIUS] = obj.gridWrapRadius ?? 2;
  data[rowOffset + SLOT.GRID_WRAP_AXIS] = obj.gridWrapAxis ?? 1;
  data[rowOffset + SLOT.GRID_WRAP_COUNT] = obj.gridWrapCount ?? 6;

  // Warp extension params
  data[rowOffset + SLOT.WARP_TARGET] = obj.warpTarget ?? 0;
  data[rowOffset + SLOT.BOWL_AXIS] = obj.bowlAxis ?? 0;
  data[rowOffset + SLOT.BOWL_TARGET] = obj.bowlTarget ?? 0;
  data[rowOffset + SLOT.PINCH_AMOUNT] = obj.pinchAmount ?? 0;
  data[rowOffset + SLOT.PINCH_CENTER] = obj.pinchCenter ?? 0;
  data[rowOffset + SLOT.PINCH_AXIS] = obj.pinchAxis ?? 1;
  data[rowOffset + SLOT.PINCH_RANGE] = obj.pinchRange ?? 3;
  data[rowOffset + SLOT.PINCH_TARGET] = obj.pinchTarget ?? 0;

  // Type-specific params starting at PARAM_START_INDEX
  const typeKeys = TYPE_PARAMS[obj.type] || [];
  const typeDefaults = TYPE_DEFAULTS[obj.type] || {};
  for (let i = 0; i < typeKeys.length; i++) {
    const val = params[typeKeys[i]] ?? typeDefaults[typeKeys[i]] ?? 0;
    data[rowOffset + PARAM_START_INDEX + i] = val;
  }
}

// ── Build blend texture data ────────────────────────────────────────
function buildBlendTexture(sceneJson) {
  const blends = sceneJson.blends || [];
  if (blends.length === 0) return { data: new Float32Array(4), count: 0 };

  const objects = sceneJson.objects;
  const idToIndex = {};
  for (let i = 0; i < objects.length; i++) {
    idToIndex[objects[i].id] = i;
  }

  const data = new Float32Array(blends.length * 4);
  for (let b = 0; b < blends.length; b++) {
    const blend = blends[b];
    const i = idToIndex[blend.objectId1];
    const j = idToIndex[blend.objectId2];
    if (i === undefined || j === undefined) continue;
    data[b * 4 + 0] = i;
    data[b * 4 + 1] = j;
    data[b * 4 + 2] = blend.strength;
    data[b * 4 + 3] = 0;
  }

  return { data, count: blends.length };
}

// ── Compute bounding box ────────────────────────────────────────────
function computeBBox(sceneJson) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const obj of sceneJson.objects) {
    if (obj.hidden) continue;

    const type = obj.type;
    const params = obj.params || {};
    const typeDefaults = TYPE_DEFAULTS[type] || {};
    const scale = obj.scale || 1;
    const warpX = obj.warpX || 1;
    const warpY = obj.warpY || 1;
    const warpZ = obj.warpZ || 1;

    // Base extent from type
    let baseExtent;
    if (type === "snowflake") {
      // Snowflake is complex — use a generous default
      const p = { ...snowflakeDefaults, ...params };
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
      baseExtent = [xHalf, halfExtent, halfExtent];
    } else if (type === "sphere") {
      const r = params.radius ?? typeDefaults.radius ?? 1;
      baseExtent = [r, r, r];
    } else if (type === "torus") {
      // sdfTorus ring plane is YZ (uses length(p.yz)), thickness in X
      const R = params.majorRadius ?? typeDefaults.majorRadius ?? 1;
      const r = params.minorRadius ?? typeDefaults.minorRadius ?? 0.3;
      baseExtent = [r, R + r, R + r];
    } else if (type === "diamondTorus") {
      // sdDiamondTorusVesica ring plane is XZ (uses length(p.xz)), thickness in Y
      const R = params.majorRadius ?? typeDefaults.majorRadius ?? 1;
      const r = params.minorRadius ?? typeDefaults.minorRadius ?? 0.3;
      baseExtent = [R + r, r, R + r];
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
    const wrapRadius = obj.gridWrapRadius || 2;
    const wrapCount = obj.gridWrapCount || 6;
    if (wrapMode > 0) {
      // Cylindrical or spherical wrap: geometry is distributed on a shell of radius wrapRadius
      const wrapEnvelope = wrapRadius + Math.max(ext[0], ext[1], ext[2]);
      ext = [wrapEnvelope, wrapEnvelope, wrapEnvelope];
    }

    // Rotation expansion: use bounding sphere for safety
    const rotX = obj.rotX || 0;
    const rotY = obj.rotY || 0;
    const rotZ = obj.rotZ || 0;
    if (Math.abs(rotX) + Math.abs(rotY) + Math.abs(rotZ) > 0.001) {
      const maxExt = Math.sqrt(ext[0] * ext[0] + ext[1] * ext[1] + ext[2] * ext[2]);
      ext = [maxExt, maxExt, maxExt];
    }

    // Position offset
    const posX = obj.position?.[0] ?? 0;
    const posY = obj.position?.[1] ?? 0;
    const posZ = obj.position?.[2] ?? 0;

    minX = Math.min(minX, posX - ext[0]);
    minY = Math.min(minY, posY - ext[1]);
    minZ = Math.min(minZ, posZ - ext[2]);
    maxX = Math.max(maxX, posX + ext[0]);
    maxY = Math.max(maxY, posY + ext[1]);
    maxZ = Math.max(maxZ, posZ + ext[2]);
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

  // Build param texture
  const paramData = new Float32Array(TEX_WIDTH * 4 * numObjects);
  for (let i = 0; i < objects.length; i++) {
    writeObjectToTexture(paramData, i, objects[i]);
  }

  // Build blend texture
  const blend = buildBlendTexture(sceneJson);

  // Compute bbox
  const bbox = computeBBox(sceneJson);

  // Build GLSL
  const blendH = Math.max(blend.count, 1);
  const sdfCode = [
    `#define PI 3.141592653589793`,
    `#define TEX_H ${numObjects}.0`,
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
    `uniform int uBlendCount;`,
  ].join("\n");

  const resolution = bbox.size.map((s) => Math.round(s * density));

  return {
    sdfCode,
    textureDeclarations,
    paramData,
    blendData: blend.data,
    objectCount: numObjects,
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

    await page.goto("http://localhost:8000?cachebust=" + Date.now());
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
      (sdfCode, texDecl, paramDataArr, blendDataArr, objectCount, blendCount, sceneSize, sceneCenter, resolution, meshName, finalSizeMM) => {
        return new Promise((resolve) => {
          const run = async () => {
            try {
              const gl = window.cubeMarch.scene.gl;

              // WebGL 2: float textures are native (no OES_texture_float needed)
              // Use RGBA32F sized internal format for float texture creation

              // Create param texture (TEX_WIDTH x numObjects, RGBA Float32)
              const numObjects = objectCount;
              const paramTex = gl.createTexture();
              gl.bindTexture(gl.TEXTURE_2D, paramTex);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
              gl.texImage2D(
                gl.TEXTURE_2D, 0, gl.RGBA32F,
                64, numObjects,
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
      Array.from(s.blendData),
      s.objectCount,
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

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
    "Usage: node batch-snowflake.js <form.json | forms-dir/> [--size 30] [--density 130]"
  );
  console.error(
    "\nRequires sdf-mesher server running: python3 -m http.server 8000"
  );
  process.exit(1);
}

// ── Resolve input files ──────────────────────────────────────────────
const resolvedInput = path.resolve(inputPath);
let formFiles;
if (fs.statSync(resolvedInput).isDirectory()) {
  formFiles = fs
    .readdirSync(resolvedInput)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(resolvedInput, f));
} else {
  formFiles = [resolvedInput];
}

if (formFiles.length === 0) {
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

// ── Parse param defaults from params.ts ──────────────────────────────
const defaults = {};
const defRegex =
  /\{\s*key:\s*"(\w+)"[^}]*?default:\s*([-\d.eE+]+(?:\s*\*\s*[-\d.eE+]+)?)/g;
let m;
while ((m = defRegex.exec(paramsTs)) !== null) {
  defaults[m[1]] = parseFloat(m[2]);
}

// ── Extract SDF GLSL from page.tsx ───────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────
function paramToUniform(key) {
  return "u" + key.charAt(0).toUpperCase() + key.slice(1);
}

function formatFloat(v) {
  const s = String(v);
  if (!s.includes(".") && !s.includes("e")) return s + ".0";
  return s;
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function buildSdf(formJson) {
  const formParams = formJson.params;
  const merged = { ...defaults, ...formParams };

  const constLines = [];
  for (const key of Object.keys(defaults)) {
    const val = merged[key] ?? defaults[key];
    constLines.push(
      `const float ${paramToUniform(key)} = ${formatFloat(val)};`
    );
  }

  const outerRadius = merged.outerEnabled > 0.5 ? merged.outerRadius : 0;
  const outerThickness = merged.outerEnabled > 0.5 ? merged.outerThickness : 0;
  const hookPosY = merged.hookPosY || 0;
  const hookSize = merged.hookSize || 0;
  const torusExtent = Math.max(
    Math.abs(merged.t3CenterPosY) + merged.t3CenterRadius + 0.5,
    Math.abs(merged.t3NeighborPosY) + merged.t3NeighborRadius + 0.5,
    merged.secEnabled > 0.5
      ? Math.abs(merged.secT3NeighborPosY) + merged.secT3NeighborRadius + 0.5
      : 0
  );
  const hookExtent = hookPosY + hookSize + 1.5;
  const halfExtent =
    Math.max(outerRadius + outerThickness + 0.5, hookExtent, torusExtent) + 0.3;
  // X extent: hook displaces ~1.0 in X plus its radius, and may have xOffset
  const hookXExtent = 1.1 + hookSize + Math.abs(merged.hookXOffset || 0) + 0.3;
  const xHalf = Math.max(0.75, hookXExtent);
  const bboxSize = [xHalf * 2, halfExtent * 2, halfExtent * 2].map(round3);
  const resolution = bboxSize.map((s) => Math.round(s * density));

  const sdfCode = [
    "#define PI 3.141592653589793",
    "",
    "// Form parameters (baked from " + formJson.name + ")",
    ...constLines,
    "",
    sdfBody,
    "float mapDistance(vec3 p) {",
    "  return Form(p);",
    "}",
    "",
  ].join("\n");

  return { sdfCode, size: bboxSize, resolution };
}

// ── Download tracking ────────────────────────────────────────────────
function createDownloadTracker(cdpSession) {
  let completedCount = 0;
  const pending = new Map(); // guid -> filename

  cdpSession.on("Browser.downloadWillBegin", (evt) => {
    pending.set(evt.guid, evt.suggestedFilename);
    console.log(`  📥 Download started: ${evt.suggestedFilename}`);
  });

  cdpSession.on("Browser.downloadProgress", (evt) => {
    if (evt.state === "completed" || evt.state === "canceled") {
      const name = pending.get(evt.guid) || evt.guid;
      if (evt.state === "completed") {
        console.log(`  💾 Download complete: ${name}`);
        completedCount++;
      } else {
        console.log(`  ⚠️  Download canceled: ${name}`);
      }
      pending.delete(evt.guid);
    }
  });

  return {
    // Wait until we've seen exactly `expectedCount` downloads complete
    waitForCount: (expectedCount) =>
      new Promise((resolve) => {
        console.log(`  ⏳ Waiting for ${expectedCount} download(s) to complete...`);
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
  const jobs = formFiles.map((f) => {
    const json = JSON.parse(fs.readFileSync(f, "utf8"));
    const name = json.name || path.basename(f, ".json");
    const finalSizeMM = sizeMM ?? json.sizeMM ?? 30;
    const { sdfCode, size, resolution } = buildSdf(json);
    return { name, sdfCode, size, resolution, sizeMM: finalSizeMM, file: f };
  });

  console.log(`\n🎄 Batch snowflake meshing: ${jobs.length} form(s)\n`);
  for (const j of jobs) {
    console.log(
      `   ${j.name}  size:[${j.size}]  res:[${j.resolution}]  ${j.sizeMM}mm`
    );
  }
  console.log("");

  const downloadPath = path.join(os.homedir(), "Downloads");

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  // Set download behavior at the browser level — suppresses the
  // "allow downloading multiple files?" prompt entirely
  const browserCdp = await browser.target().createCDPSession();
  await browserCdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadPath,
    eventsEnabled: true,
  });

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    console.log(
      `\n[${i + 1}/${jobs.length}] 🚀 ${job.name} (${job.resolution.join("x")})`
    );

    const page = await browser.newPage();

    // Per-page CDP for download events (browser-level events don't
    // always fire on page sessions, so listen on both)
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

    const meshParams = { size: job.size, resolution: job.resolution };

    // page.evaluate returns the total number of parts saved
    const result = await page.evaluate(
      (sdfCode, params, meshName) => {
        return new Promise((resolve) => {
          const run = async () => {
            try {
              window.editor.setValue(sdfCode);
              window.ractive.set("bounding.size.width", params.size[0]);
              window.ractive.set("bounding.size.height", params.size[1]);
              window.ractive.set("bounding.size.depth", params.size[2]);
              window.ractive.set("download.resolution.x", params.resolution[0]);
              window.ractive.set("download.resolution.y", params.resolution[1]);
              window.ractive.set("download.resolution.z", params.resolution[2]);

              const dims = params.resolution;
              const bounds = [
                [-params.size[0] / 2, -params.size[1] / 2, -params.size[2] / 2],
                [params.size[0] / 2, params.size[1] / 2, params.size[2] / 2],
              ];

              window.cubeMarch.setVolume(dims, bounds);
              window.exporter.startModel(
                meshName + "-" + dims[0] + "x" + dims[1] + "x" + dims[2]
              );

              console.log("Starting mesh generation for " + meshName + "...");

              window.cubeMarch.march({
                mapDistance: sdfCode,
                textureDeclarations: "",
                uniforms: {},
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
                  // Return total part count (0-indexed part + 1)
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
      job.sdfCode,
      meshParams,
      job.name
    );

    if (result.status === "error") {
      console.error(`  ❌ ${job.name}: ${result.message}`);
    } else {
      // Wait until exactly totalParts downloads have completed
      await tracker.waitForCount(result.totalParts);
      console.log(`  ✅ ${job.name} done (${result.totalParts} parts)`);
      console.log(
        `     To size: python factory.py --parts-dir ~/Downloads --size ${job.sizeMM} --axis y`
      );
    }

    await pageCdp.detach();
    await page.close();
  }

  await browserCdp.detach();
  console.log(
    `\n🎉 All done! ${jobs.length} mesh(es) downloaded to ~/Downloads`
  );
  console.log("   Closing browser...");
  await browser.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

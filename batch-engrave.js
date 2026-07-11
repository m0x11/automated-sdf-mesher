#!/usr/bin/env node

/**
 * Batch mesh generation for engraved ephemeris rings.
 *
 * Usage:
 *   node batch-engrave.js 07-04-1776 01-01-2000 12-25-2024
 *   node batch-engrave.js --file dates.txt
 *   node batch-engrave.js --resolution 400 07-04-1776
 *
 * Requires ephemeris-variable SDF to be set up first:
 *   cd ../engraving-table && node setup-ephemeris-variable.js
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Glyph index mapping (must match setup-ephemeris-variable.js)
const GLYPH_MAP = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4,
  '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '·': 10,
  'A': 11, 'B': 12, 'C': 13, 'D': 14, 'E': 15,
  'F': 16, 'G': 17, 'J': 18, 'L': 19, 'M': 20,
  'N': 21, 'O': 22, 'P': 23, 'R': 24, 'S': 25,
  'T': 26, 'U': 27, 'V': 28, 'Y': 29
};

const MONTH_ABBREVS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'
];

const MONTH_NAMES = {
  'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
  'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
};

// Normalize any supported date format to { date: 'MM-DD-YYYY', dateFormat: 'mdy'|'dmy' }
// Supported inputs:
//   MM-DD-YYYY  (numeric)       → mdy
//   Mon-DD-YYYY (e.g. Jul-24-2025) → mdy
//   DD-Mon-YYYY (e.g. 20-Jan-2026) → dmy
function normalizeDate(dateStr) {
  // Already in MM-DD-YYYY format
  const numericMatch = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (numericMatch) {
    return { date: dateStr, dateFormat: 'mdy' };
  }

  // Mon-DD-YYYY (e.g. Jul-24-2025)
  const mdyMatch = dateStr.match(/^([A-Za-z]{3})-(\d{1,2})-(\d{4})$/);
  if (mdyMatch) {
    const month = MONTH_NAMES[mdyMatch[1].toUpperCase()];
    if (!month) throw new Error(`Unknown month: ${mdyMatch[1]}`);
    const mm = String(month).padStart(2, '0');
    const dd = mdyMatch[2].padStart(2, '0');
    return { date: `${mm}-${dd}-${mdyMatch[3]}`, dateFormat: 'mdy' };
  }

  // DD-Mon-YYYY (e.g. 20-Jan-2026)
  const dmyMatch = dateStr.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (dmyMatch) {
    const month = MONTH_NAMES[dmyMatch[2].toUpperCase()];
    if (!month) throw new Error(`Unknown month: ${dmyMatch[2]}`);
    const mm = String(month).padStart(2, '0');
    const dd = dmyMatch[1].padStart(2, '0');
    return { date: `${mm}-${dd}-${dmyMatch[3]}`, dateFormat: 'dmy' };
  }

  throw new Error(`Unrecognized date format: ${dateStr}. Expected MM-DD-YYYY, Mon-DD-YYYY, or DD-Mon-YYYY`);
}

function parseDateToUnix(dateStr) {
  const match = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) {
    throw new Error(`Invalid date format: ${dateStr}. Expected mm-dd-yyyy (run through normalizeDate first)`);
  }

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);

  if (month < 1 || month > 12) throw new Error(`Invalid month: ${month}`);
  if (day < 1 || day > 31) throw new Error(`Invalid day: ${day}`);

  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return Math.floor(date.getTime() / 1000);
}

function formatDateForFilename(dateStr, dateFormat = 'mdy') {
  const match = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) throw new Error(`Invalid date format: ${dateStr}`);

  const monthNum = parseInt(match[1], 10);
  const monthAbbrev = MONTH_ABBREVS[monthNum - 1].charAt(0) + MONTH_ABBREVS[monthNum - 1].slice(1).toLowerCase();
  const day = match[2].padStart(2, '0');
  const year = match[3];

  if (dateFormat === 'dmy') {
    return `${day}-${monthAbbrev}-${year}`;
  }
  return `${monthAbbrev}-${day}-${year}`;
}

function formatDateWithDots(dateStr, dateFormat = 'mdy') {
  const match = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) throw new Error(`Invalid date format: ${dateStr}`);

  const monthNum = parseInt(match[1], 10);
  const monthAbbrev = MONTH_ABBREVS[monthNum - 1];
  const day = match[2].padStart(2, '0');
  const year = match[3];

  if (dateFormat === 'dmy') {
    return `${day}·${monthAbbrev}·${year}`;
  }
  return `${monthAbbrev}·${day}·${year}`;
}

function dateToGlyphIndices(dateStr, dateFormat = 'mdy') {
  const displayText = formatDateWithDots(dateStr, dateFormat);
  const indices = [];

  for (const char of displayText) {
    if (GLYPH_MAP.hasOwnProperty(char)) {
      indices.push(GLYPH_MAP[char]);
    } else {
      throw new Error(`Unknown character in date: '${char}'`);
    }
  }

  if (indices.length !== 11) {
    throw new Error(`Expected 11 characters, got ${indices.length}: ${displayText}`);
  }

  return indices;
}

async function generateMeshForDate(page, item, sdfCode, params, textureBase64, resolution) {
  const dateStr = item.date;
  const dateFormat = item.dateFormat || 'mdy';
  const unixTime = parseDateToUnix(dateStr);
  const displayText = formatDateWithDots(dateStr, dateFormat);
  const glyphIndices = dateToGlyphIndices(dateStr, dateFormat);

  // Build filename: ring(index)_date(Mon-DD-YYYY)_size(size)_batch(batch)
  const fileDate = formatDateForFilename(dateStr, dateFormat);
  let filename;
  if (item.index !== undefined) {
    const parts = [`ring(${item.index})`];
    parts.push(`date(${fileDate})`);
    if (item.size) parts.push(`size(${item.size})`);
    if (item.batch) parts.push(`batch(${item.batch})`);
    filename = parts.join('_');
  } else {
    filename = `ephemeris-${fileDate}-${resolution}`;
  }

  console.log(`\n📅 Processing: ${dateStr}${item.id ? ` (${item.id})` : ''}`);
  console.log(`   Display: ${displayText} (${dateFormat === 'dmy' ? 'dd·MON·yyyy' : 'MON·dd·yyyy'})`);
  console.log(`   Unix: ${unixTime}`);
  console.log(`   Filename: ${filename}`);

  const result = await page.evaluate(
    async (sdfCode, params, textureBase64, unixTime, glyphIndices, resolution, dateStr, filename) => {
      return new Promise((resolve) => {
        const runGeneration = async () => {
          try {
            // Set SDF code
            window.editor.setValue(sdfCode);

            // Set bounding box
            window.ractive.set('bounding.size.width', params.size[0]);
            window.ractive.set('bounding.size.height', params.size[1]);
            window.ractive.set('bounding.size.depth', params.size[2]);

            // Set resolution
            window.ractive.set('download.resolution.x', resolution);
            window.ractive.set('download.resolution.y', resolution);
            window.ractive.set('download.resolution.z', resolution);

            // Load texture
            const img = new Image();
            await new Promise((res, rej) => {
              img.onload = res;
              img.onerror = rej;
              img.src = 'data:image/png;base64,' + textureBase64;
            });

            const gl = window.cubeMarch.scene.gl;
            const texture = window.twgl.createTexture(gl, {
              src: img,
              flipY: true,
              min: gl.LINEAR,
              mag: gl.LINEAR,
              wrap: gl.CLAMP_TO_EDGE
            });

            // Set up volume
            const dims = [resolution, resolution, resolution];
            const bounds = [
              [-params.size[0]/2, -params.size[1]/2, -params.size[2]/2],
              [params.size[0]/2, params.size[1]/2, params.size[2]/2]
            ];

            window.cubeMarch.setVolume(dims, bounds);

            window.exporter.startModel(filename);

            console.log(`Starting mesh generation for ${dateStr}...`);

            window.cubeMarch.march({
              mapDistance: sdfCode,
              textureDeclarations: 'uniform sampler2D uMsdfTexture;\nuniform float uTargetDate;\nuniform int uGlyphIndices[11];',
              uniforms: {
                uMsdfTexture: texture,
                uTargetDate: parseFloat(unixTime),
                uGlyphIndices: new Int32Array(glyphIndices)
              },
              onSection: (data) => {
                window.exporter.addSection(data.vertices, data.faces);
              },
              onProgress: (cubesMarched, totalCubes) => {
                const percent = ((cubesMarched / totalCubes) * 100).toFixed(1);
                window.ractive.set('progress', `${dateStr}: ${percent}%`);
              },
              onDone: () => {
                console.log(`Mesh complete for ${dateStr}`);
                window.exporter.finishModel();
                window.ractive.set('progress', `${dateStr}: Complete!`);
                // Return total part count (0-indexed part + 1)
                const totalParts = window.exporter.part + 1;
                resolve({ success: true, date: dateStr, totalParts });
              }
            });
          } catch (err) {
            console.error('Generation error:', err.message);
            resolve({ success: false, date: dateStr, error: err.message });
          }
        };

        runGeneration();
      });
    },
    sdfCode, params, textureBase64, unixTime, glyphIndices, resolution, dateStr, filename
  );

  return result;
}

// ── Download tracking ────────────────────────────────────────────────
function createDownloadTracker(cdpSession) {
  let completedCount = 0;
  const pending = new Map(); // guid -> filename

  cdpSession.on('Browser.downloadWillBegin', (evt) => {
    pending.set(evt.guid, evt.suggestedFilename);
    console.log(`   📥 Download started: ${evt.suggestedFilename}`);
  });

  cdpSession.on('Browser.downloadProgress', (evt) => {
    if (evt.state === 'completed' || evt.state === 'canceled') {
      const name = pending.get(evt.guid) || evt.guid;
      if (evt.state === 'completed') {
        console.log(`   💾 Download complete: ${name}`);
        completedCount++;
      } else {
        console.log(`   ⚠️  Download canceled: ${name}`);
      }
      pending.delete(evt.guid);
    }
  });

  return {
    // Wait until we've seen exactly `expectedCount` downloads complete
    waitForCount: (expectedCount) =>
      new Promise((resolve) => {
        console.log(`   ⏳ Waiting for ${expectedCount} download(s) to complete...`);
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

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Batch Engrave - Generate multiple engraved ephemeris ring meshes

Usage:
  node batch-engrave.js [options] <date1> <date2> ...
  node batch-engrave.js --file <dates.txt>
  node batch-engrave.js --json <spec.json>

Options:
  --resolution <n>  Resolution per axis (default: 600)
  --file <path>     Read dates from file (one per line)
  --json <path>     Read from JSON file with format:
                    [{"id": "...", "engraving": "...", "size": "..."}, ...]
  --help            Show this help

Date formats: MM-DD-YYYY, Mon-DD-YYYY, DD-Mon-YYYY
  DD-Mon-YYYY dates are automatically engraved in DD·MON·YYYY order.

Examples:
  node batch-engrave.js 07-04-1776
  node batch-engrave.js 01-01-2000 12-25-2024
  node batch-engrave.js --resolution 400 07-04-1776 01-01-2000
  node batch-engrave.js --file my-dates.txt
  node batch-engrave.js --json ../specifications/transactions_batch_2.json

Setup (run once first):
  cd ../engraving-table && node setup-ephemeris-variable.js
`);
    process.exit(0);
  }

  // Parse arguments
  let resolution = 600;
  let items = [];  // Array of {date, id} objects

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resolution' && args[i + 1]) {
      resolution = parseInt(args[++i]);
    } else if (args[i] === '--json' && args[i + 1]) {
      const filePath = args[++i];
      const jsonContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      jsonContent.forEach((entry, index) => {
        if (entry.engraving) {
          const { date, dateFormat } = normalizeDate(entry.engraving);
          items.push({
            date,
            id: entry.id || null,
            size: entry.size || null,
            batch: entry.batch || null,
            dateFormat: entry.dateFormat || dateFormat,
            index: index + 1  // 1-based index
          });
        }
      });
    } else if (args[i] === '--file' && args[i + 1]) {
      const filePath = args[++i];
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const dates = fileContent.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      for (const raw of dates) {
        const { date, dateFormat } = normalizeDate(raw);
        items.push({ date, dateFormat, id: null });
      }
    } else if (!args[i].startsWith('--')) {
      const { date, dateFormat } = normalizeDate(args[i]);
      items.push({ date, dateFormat, id: null });
    }
  }

  if (items.length === 0) {
    console.error('Error: No dates provided');
    process.exit(1);
  }

  // Validate all dates first
  console.log('📋 Validating dates...');
  for (const item of items) {
    try {
      parseDateToUnix(item.date);
      const display = formatDateWithDots(item.date, item.dateFormat || 'mdy');
      dateToGlyphIndices(item.date, item.dateFormat || 'mdy');
      console.log(`   ✓ ${item.date}${item.id ? ` (${item.id})` : ''} → ${display}`);
    } catch (err) {
      console.error(`   ✗ ${item.date}: ${err.message}`);
      process.exit(1);
    }
  }

  // Load SDF files
  const sdfDir = path.join(__dirname, '..', 'sdfs', 'ephemeris-variable');
  const sdfFile = path.join(sdfDir, 'sdf.txt');
  const paramsFile = path.join(sdfDir, 'params.json');
  const textureFile = path.join(sdfDir, 'msdf.png');

  if (!fs.existsSync(sdfFile)) {
    console.error(`\nError: ephemeris-variable SDF not found.`);
    console.error(`Run setup first: cd ../engraving-table && node setup-ephemeris-variable.js`);
    process.exit(1);
  }

  const sdfCode = fs.readFileSync(sdfFile, 'utf8');
  const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
  const textureBase64 = fs.readFileSync(textureFile).toString('base64');

  console.log(`\n🚀 Generating ${items.length} mesh(es) at resolution ${resolution}...`);

  // Launch browser
  const downloadPath = path.join(os.homedir(), 'Downloads');
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  // Set download behavior at the browser level — suppresses the
  // "allow downloading multiple files?" prompt entirely
  const browserCdp = await browser.target().createCDPSession();
  await browserCdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadPath,
    eventsEnabled: true,
  });

  const page = await browser.newPage();

  // Per-page CDP for download events (browser-level events don't
  // always fire on page sessions, so listen on both)
  const pageCdp = await page.createCDPSession();
  await pageCdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadPath,
    eventsEnabled: true,
  });
  const tracker = createDownloadTracker(pageCdp);
  page.on('console', msg => {
    const text = msg.text();
    if (!text.includes('Ractive') && !text.includes('debug mode')) {
      console.log(`[Browser] ${text}`);
    }
  });

  // Load mesher
  console.log('\n📄 Loading SDF Factory...');
  await page.goto('http://localhost:' + (process.env.MESH_PORT || 8000) + '?cachebust=' + Date.now());
  await page.waitForSelector('.editor');
  await page.waitForFunction(
    () => window.cubeMarch && window.twgl && window.exporter && window.editor && window.ractive,
    { timeout: 10000 }
  );

  // Process each item
  const results = [];
  let expectedDownloads = 0;
  for (const item of items) {
    // Small delay between meshes to let downloads complete
    if (results.length > 0) {
      console.log('⏳ Waiting before next mesh...');
      await new Promise(r => setTimeout(r, 3000));
    }

    const result = await generateMeshForDate(
      page, item, sdfCode, params, textureBase64, resolution
    );
    results.push(result);

    // Wait for mesh generation to complete
    await page.waitForFunction(
      (dateStr) => {
        const progress = window.ractive.get('progress');
        return progress && progress.includes('Complete');
      },
      { timeout: 600000 },  // 10 minute timeout per mesh
      item.date
    );

    // Wait until all parts for this mesh have finished downloading
    if (result.success && result.totalParts) {
      expectedDownloads += result.totalParts;
      await tracker.waitForCount(expectedDownloads);
      console.log(`   ✅ ${item.date} done (${result.totalParts} part${result.totalParts === 1 ? '' : 's'})`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Summary:');
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`   ✓ Successful: ${successful.length}`);
  if (failed.length > 0) {
    console.log(`   ✗ Failed: ${failed.length}`);
    failed.forEach(r => console.log(`      - ${r.date}: ${r.error}`));
  }

  console.log('\n🎉 Batch complete! STL files downloaded to ~/Downloads.');
  console.log('   Closing browser...');
  await browser.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

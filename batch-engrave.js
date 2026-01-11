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

// Glyph index mapping
const GLYPH_MAP = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4,
  '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '·': 10
};

function parseDateToUnix(dateStr) {
  const match = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) {
    throw new Error(`Invalid date format: ${dateStr}. Expected mm-dd-yyyy`);
  }

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  const year = parseInt(match[3], 10);

  if (month < 1 || month > 12) throw new Error(`Invalid month: ${month}`);
  if (day < 1 || day > 31) throw new Error(`Invalid day: ${day}`);

  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return Math.floor(date.getTime() / 1000);
}

function formatDateWithDots(dateStr) {
  const match = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) throw new Error(`Invalid date format: ${dateStr}`);

  const month = match[1].padStart(2, '0');
  const day = match[2].padStart(2, '0');
  const year = match[3];

  return `${month}·${day}·${year}`;
}

function dateToGlyphIndices(dateStr) {
  const displayText = formatDateWithDots(dateStr);
  const indices = [];

  for (const char of displayText) {
    if (GLYPH_MAP.hasOwnProperty(char)) {
      indices.push(GLYPH_MAP[char]);
    } else {
      throw new Error(`Unknown character in date: '${char}'`);
    }
  }

  if (indices.length !== 10) {
    throw new Error(`Expected 10 characters, got ${indices.length}: ${displayText}`);
  }

  return indices;
}

async function generateMeshForDate(page, dateStr, sdfCode, params, textureBase64, resolution, itemId = null) {
  const unixTime = parseDateToUnix(dateStr);
  const displayText = formatDateWithDots(dateStr);
  const glyphIndices = dateToGlyphIndices(dateStr);

  console.log(`\n📅 Processing: ${dateStr}${itemId ? ` (${itemId})` : ''}`);
  console.log(`   Display: ${displayText}`);
  console.log(`   Unix: ${unixTime}`);
  console.log(`   Glyphs: [${glyphIndices.join(', ')}]`);

  const result = await page.evaluate(
    async (sdfCode, params, textureBase64, unixTime, glyphIndices, resolution, dateStr, itemId) => {
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

            // Filename includes id if provided, otherwise date
            const safeDateStr = dateStr.replace(/-/g, '');
            const filename = itemId ? `${itemId}` : `ephemeris-${safeDateStr}-${resolution}`;
            window.exporter.startModel(filename);

            console.log(`Starting mesh generation for ${dateStr}...`);

            window.cubeMarch.march({
              mapDistance: sdfCode,
              textureDeclarations: 'uniform sampler2D uMsdfTexture;\nuniform float uTargetDate;\nuniform int uGlyphIndices[10];',
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
                resolve({ success: true, date: dateStr });
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
    sdfCode, params, textureBase64, unixTime, glyphIndices, resolution, dateStr, itemId
  );

  return result;
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
                    [{"id": "...", "engraving": "mm-dd-yyyy"}, ...]
  --help            Show this help

Date format: mm-dd-yyyy

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
      for (const entry of jsonContent) {
        if (entry.engraving) {
          items.push({ date: entry.engraving, id: entry.id || null });
        }
      }
    } else if (args[i] === '--file' && args[i + 1]) {
      const filePath = args[++i];
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const dates = fileContent.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      for (const date of dates) {
        items.push({ date, id: null });
      }
    } else if (!args[i].startsWith('--')) {
      items.push({ date: args[i], id: null });
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
      formatDateWithDots(item.date);
      dateToGlyphIndices(item.date);
      console.log(`   ✓ ${item.date}${item.id ? ` (${item.id})` : ''}`);
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
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  page.on('console', msg => {
    const text = msg.text();
    if (!text.includes('Ractive') && !text.includes('debug mode')) {
      console.log(`[Browser] ${text}`);
    }
  });

  // Load mesher
  console.log('\n📄 Loading SDF Factory...');
  await page.goto('http://localhost:8000?cachebust=' + Date.now());
  await page.waitForSelector('.editor');
  await page.waitForFunction(
    () => window.cubeMarch && window.twgl && window.exporter && window.editor && window.ractive,
    { timeout: 10000 }
  );

  // Process each item
  const results = [];
  for (const item of items) {
    // Small delay between meshes to let downloads complete
    if (results.length > 0) {
      console.log('⏳ Waiting before next mesh...');
      await new Promise(r => setTimeout(r, 3000));
    }

    const result = await generateMeshForDate(
      page, item.date, sdfCode, params, textureBase64, resolution, item.id
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

  console.log('\n🎉 Batch complete! STL files downloaded to browser.');
  console.log('   Close the browser window when ready.');
}

main().catch(console.error);

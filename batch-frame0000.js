#!/usr/bin/env node

/**
 * Mesh a Frame 0000 export (product-playground's hand-compiled frame-0000).
 *
 * 1) In product-playground:
 *      node --experimental-strip-types scripts/export-frame0000.mts [--density 45]
 * 2) Here (with the mesher served on :8000, same as batch-engrave):
 *      node batch-frame0000.js frame-0000 [--density 45]
 *
 * Plain float SDF, no textures. Resolution is per axis (the frame is thin in
 * X, tall in Y, wide in Z) and comes from params.json unless --density
 * overrides it. Parts land in ~/Downloads as <name>-part-N.stl.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function main() {
  const args = process.argv.slice(2);
  const name = args.find(a => !a.startsWith('--'));
  if (!name) {
    console.error('usage: node batch-frame0000.js <sdf-folder-name> [--density N]');
    process.exit(1);
  }
  const sdfDir = path.join(__dirname, '..', 'sdfs', name);
  const sdfCode = fs.readFileSync(path.join(sdfDir, 'sdf.txt'), 'utf8');
  const params = JSON.parse(fs.readFileSync(path.join(sdfDir, 'params.json'), 'utf8'));
  const dIdx = args.indexOf('--density');
  const resolution = dIdx >= 0
    ? params.size.map(s => Math.max(8, Math.round(s * parseFloat(args[dIdx + 1]))))
    : params.resolution;
  console.log(`size ${params.size.join(' x ')} · resolution ${resolution.join(' x ')}`);

  const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const browserCdp = await browser.target().createCDPSession();
  await browserCdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: path.join(os.homedir(), 'Downloads'),
    eventsEnabled: true,
  });

  const page = await browser.newPage();
  page.on('console', msg => {
    const text = msg.text();
    if (!text.includes('Ractive') && !text.includes('debug mode')) console.log(`[Browser] ${text}`);
  });

  console.log('Loading SDF Factory...');
  await page.goto('http://localhost:' + (process.env.MESH_PORT || 8000) + '?cachebust=' + Date.now());
  await page.waitForSelector('.editor');
  await page.waitForFunction(
    () => window.cubeMarch && window.twgl && window.exporter && window.ractive,
    { timeout: 10000 }
  );

  const result = await page.evaluate(
    async (sdfCode, params, resolution, filename) => {
      return new Promise((resolve, reject) => {
        try {
          window.ractive.set('download.resolution.x', resolution[0]);
          window.ractive.set('download.resolution.y', resolution[1]);
          window.ractive.set('download.resolution.z', resolution[2]);
          const bounds = [
            [-params.size[0] / 2, -params.size[1] / 2, -params.size[2] / 2],
            [params.size[0] / 2, params.size[1] / 2, params.size[2] / 2],
          ];
          window.cubeMarch.setVolume(resolution, bounds);
          window.exporter.startModel(filename);
          console.log('Starting mesh generation...');
          window.cubeMarch.march({
            mapDistance: sdfCode,
            textureDeclarations: '',
            uniforms: {},
            onSection: (data) => window.exporter.addSection(data.vertices, data.faces),
            onProgress: (done, total) => {
              window.ractive.set('progress', `${((done / total) * 100).toFixed(1)}%`);
            },
            onDone: () => {
              window.exporter.finishModel();
              window.ractive.set('progress', 'Complete!');
              resolve({ success: true, totalParts: window.exporter.part + 1 });
            },
          });
        } catch (err) {
          reject(err.message);
        }
      });
    },
    sdfCode, params, resolution, name
  );

  await page.waitForFunction(
    () => (window.ractive.get('progress') || '').includes('Complete'),
    { timeout: 1800000 }
  );
  // wait for the STL download to actually land (large files take a while)
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const partPath = path.join(os.homedir(), 'Downloads', name + '-part-0.stl');
    if (fs.existsSync(partPath) && !fs.existsSync(partPath + '.crdownload')) {
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
  }
  console.log(`Done: ${name} (${result.totalParts} part file(s) in ~/Downloads)`);
  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * Mesh a playground ring (relic / text ring) exported from product-playground.
 *
 * 1) In product-playground:
 *      node --experimental-strip-types scripts/export-sdf.mts --product relic --id XXXX-XXXX-XXXX-XXXX
 *      node --experimental-strip-types scripts/export-sdf.mts --product textring --id XXXX... --text "ALICE"
 * 2) Here (with the mesher served on :8000, same as batch-engrave):
 *      node batch-ring.js relic-XXXXXXXXXXXXXXXX [--resolution 600]
 *
 * Reuses the standard cube-march pipeline; float data textures (glyph
 * metadata, ID slot map, text-collage layout) ride in as RGBA32F textures.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function main() {
  const args = process.argv.slice(2);
  const name = args.find(a => !a.startsWith('--'));
  if (!name) {
    console.error('usage: node batch-ring.js <sdf-folder-name> [--resolution N]');
    process.exit(1);
  }
  const resIdx = args.indexOf('--resolution');

  const sdfDir = path.join(__dirname, '..', 'sdfs', name);
  const sdfCode = fs.readFileSync(path.join(sdfDir, 'sdf.txt'), 'utf8');
  const params = JSON.parse(fs.readFileSync(path.join(sdfDir, 'params.json'), 'utf8'));
  const texDecls = fs.readFileSync(path.join(sdfDir, 'texture-declarations.txt'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(sdfDir, 'textures.json'), 'utf8'));
  const resolution = resIdx >= 0 ? parseInt(args[resIdx + 1], 10) : (params.resolution ? params.resolution[0] : 1100);

  const atlasBase64 = fs.readFileSync(path.join(sdfDir, manifest.atlas.file)).toString('base64');
  const floats = manifest.floats.map(t => ({
    ...t,
    base64: fs.readFileSync(path.join(sdfDir, t.file)).toString('base64'),
  }));

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
    async (sdfCode, texDecls, atlasBase64, floats, params, resolution, filename) => {
      return new Promise(async (resolve, reject) => {
        try {
          window.ractive.set('download.resolution.x', resolution);
          window.ractive.set('download.resolution.y', resolution);
          window.ractive.set('download.resolution.z', resolution);

          const gl = window.cubeMarch.scene.gl;
          gl.getExtension('OES_texture_float'); // WebGL1 float textures

          // atlas (image) texture
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = 'data:image/png;base64,' + atlasBase64;
          });
          const uniforms = {};
          const atlasTex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, atlasTex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          uniforms[floats.atlasUniform || 'uFontTex'] = atlasTex;

          // float data textures
          for (const t of floats.list) {
            const bin = atob(t.base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const data = new Float32Array(bytes.buffer);
            // raw GL upload — old twgl builds mishandle float internal formats
            const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
            if (!isGL2) gl.getExtension('OES_texture_float');
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, isGL2 ? gl.RGBA32F : gl.RGBA, t.width, t.height, 0, gl.RGBA, gl.FLOAT, data);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, t.wrapU === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            uniforms[t.uniform] = tex;
          }

          const dims = [resolution, resolution, resolution];
          const bounds = [
            [-params.size[0] / 2, -params.size[1] / 2, -params.size[2] / 2],
            [params.size[0] / 2, params.size[1] / 2, params.size[2] / 2],
          ];
          window.cubeMarch.setVolume(dims, bounds);
          window.exporter.startModel(filename);
          console.log('Starting mesh generation...');

          window.cubeMarch.march({
            mapDistance: sdfCode,
            textureDeclarations: texDecls,
            uniforms,
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
    sdfCode,
    texDecls,
    atlasBase64,
    { atlasUniform: manifest.atlas.uniform, list: floats },
    params,
    resolution,
    name
  );

  await page.waitForFunction(
    () => (window.ractive.get('progress') || '').includes('Complete'),
    { timeout: 600000 }
  );
  // wait for the STL download to actually land (large files take a while)
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const partPath = path.join(os.homedir(), 'Downloads', name + '-part-0.stl');
    if (fs.existsSync(partPath) && !fs.existsSync(partPath + '.crdownload')) {
      await new Promise(r => setTimeout(r, 2000));
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

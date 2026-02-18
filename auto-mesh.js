#!/usr/bin/env node

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function generateMesh(meshName) {
    if (!meshName) {
        console.error('Usage: node auto-mesh.js <mesh-name>');
        console.error('Example: node auto-mesh.js snowflake');
        process.exit(1);
    }

    // Paths
    const sdfDir = path.join(__dirname, '..', 'sdfs', meshName);
    const sdfFile = path.join(sdfDir, 'sdf.txt');
    const paramsFile = path.join(sdfDir, 'params.json');
    const textureDeclarationsFile = path.join(sdfDir, 'texture-declarations.txt');
    const textureFile = path.join(sdfDir, 'msdf.png');

    // Validate input files exist
    if (!fs.existsSync(sdfFile)) {
        console.error(`Error: SDF file not found: ${sdfFile}`);
        process.exit(1);
    }

    if (!fs.existsSync(paramsFile)) {
        console.error(`Error: Params file not found: ${paramsFile}`);
        process.exit(1);
    }

    // Read input files
    const sdfCode = fs.readFileSync(sdfFile, 'utf8');
    const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));

    // Check for texture support
    let textureDeclarations = '';
    let textureBase64 = null;
    if (params.hasTexture && fs.existsSync(textureDeclarationsFile) && fs.existsSync(textureFile)) {
        textureDeclarations = fs.readFileSync(textureDeclarationsFile, 'utf8');
        textureBase64 = fs.readFileSync(textureFile).toString('base64');
        console.log(`🖼️  Texture found: ${textureFile}`);
    }

    console.log(`🚀 Generating mesh for: ${meshName}`);
    console.log(`📏 Size: [${params.size.join(', ')}]`);
    console.log(`🔧 Resolution: [${params.resolution.join(', ')}]`);

    const browser = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Listen to console messages from the browser
    page.on('console', msg => console.log(`[Browser] ${msg.text()}`));

    console.log('📄 Loading SDF Factory...');
    await page.goto('http://localhost:8000?cachebust=' + Date.now());
    await page.waitForSelector('.editor');
    // Wait for script to fully execute
    await page.waitForFunction(() => window.cubeMarch && window.twgl && window.exporter && window.editor && window.ractive, { timeout: 10000 });

    console.log('⚙️ Setting up automation...');

    // Inject the SDF code, params, and texture, then auto-generate
    await page.evaluate((sdfCode, params, textureDeclarations, textureBase64) => {
        return new Promise((resolveMain) => {
            const runSetup = async () => {
                try {
                    console.log('Dependencies loaded, starting setup...');
                    console.log('Setting SDF code...');
                    window.editor.setValue(sdfCode);

                    console.log('Setting bounding box size...');
                    window.ractive.set('bounding.size.width', params.size[0]);
                    window.ractive.set('bounding.size.height', params.size[1]);
                    window.ractive.set('bounding.size.depth', params.size[2]);

                    console.log('Setting download resolution...');
                    window.ractive.set('download.resolution.x', params.resolution[0]);
                    window.ractive.set('download.resolution.y', params.resolution[1]);
                    window.ractive.set('download.resolution.z', params.resolution[2]);

                    // Prepare uniforms for texture-based SDFs
                    let uniforms = {};

                    if (textureBase64) {
                        console.log('Loading MSDF texture...');

                        // Load texture from base64
                        const img = new Image();
                        await new Promise((resolve, reject) => {
                            img.onload = resolve;
                            img.onerror = reject;
                            img.src = 'data:image/png;base64,' + textureBase64;
                        });

                        console.log('Texture loaded: ' + img.width + 'x' + img.height);

                        // Create WebGL texture using twgl
                        const gl = window.cubeMarch.scene.gl;
                        const texture = window.twgl.createTexture(gl, {
                            src: img,
                            flipY: true,
                            min: gl.LINEAR,
                            mag: gl.LINEAR,
                            wrap: gl.CLAMP_TO_EDGE
                        });

                        console.log('WebGL texture created');

                        // Set up texture uniform (glyph data is inlined in shader)
                        uniforms.uMsdfTexture = texture;
                    }

                    // Set up volume and exporter
                    const dims = params.resolution;
                    const xOff = params.xOffset || 0;
                    const bounds = [
                        [-params.size[0]/2 + xOff, -params.size[1]/2, -params.size[2]/2],
                        [params.size[0]/2 + xOff, params.size[1]/2, params.size[2]/2]
                    ];

                    window.cubeMarch.setVolume(dims, bounds);

                    const filename = 'mesh-' + Date.now() + '-' + dims[0] + 'x' + dims[1] + 'x' + dims[2];
                    window.exporter.startModel(filename);

                    console.log('Starting mesh generation with texture support...');

                    window.cubeMarch.march({
                        mapDistance: sdfCode,
                        textureDeclarations: textureDeclarations || '',
                        uniforms: uniforms,
                        onSection: (data) => {
                            window.exporter.addSection(data.vertices, data.faces);
                        },
                        onProgress: (cubesMarched, totalCubes) => {
                            const percent = ((cubesMarched / totalCubes) * 100).toFixed(1);
                            window.ractive.set('progress', 'Progress: ' + percent + '%');
                        },
                        onDone: () => {
                            console.log('Mesh generation complete!');
                            window.exporter.finishModel();
                            window.ractive.set('progress', 'Complete! STL downloaded.');
                            resolveMain('done');
                        }
                    });
                } catch (err) {
                    console.error('Setup error:', err.message);
                    console.error('Stack:', err.stack);
                    resolveMain('error: ' + err.message);
                }
            };

            runSetup();
        });
    }, sdfCode, params, textureDeclarations, textureBase64);

    console.log('🎯 Mesh generation started!')
    console.log('⏳ STL will download when complete.');
    console.log('   You can close the browser when the download finishes.');
    console.log('\nPress Ctrl+C to close browser and exit.');
}

// Handle command line arguments
const meshName = process.argv[2];
generateMesh(meshName).catch(console.error);

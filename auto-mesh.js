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
    await page.goto('http://localhost:8000');
    await page.waitForSelector('.editor');

    console.log('⚙️ Setting up automation...');

    // Inject the SDF code and parameters, then auto-click generate
    await page.evaluate((sdfCode, params) => {
        // Wait for everything to load
        const setup = () => {
            if (!window.editor || !window.ractive) {
                setTimeout(setup, 100);
                return;
            }

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

            setTimeout(() => {
                console.log('Starting mesh generation...');
                window.ractive.fire('download.start');
            }, 500);
        };

        setup();
    }, sdfCode, params);

    console.log('🎯 Mesh generation started!')

    console.log('⏳ Mesh generation started! STL will download when complete.');
    console.log('   You can close the browser when the download finishes.');

    // Keep browser open for user to see progress and download
    console.log('\nPress Ctrl+C to close browser and exit.');
}

// Handle command line arguments
const meshName = process.argv[2];
generateMesh(meshName).catch(console.error);
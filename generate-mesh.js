#!/usr/bin/env node

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function generateMesh(meshName) {
    if (!meshName) {
        console.error('Usage: node generate-mesh.js <mesh-name>');
        console.error('Example: node generate-mesh.js snowflake');
        process.exit(1);
    }

    // Paths
    const sdfDir = path.join(__dirname, '..', 'sdfs', meshName);
    const meshesDir = path.join(__dirname, '..', 'meshes');
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

    // Ensure meshes directory exists
    if (!fs.existsSync(meshesDir)) {
        fs.mkdirSync(meshesDir, { recursive: true });
    }

    // Read input files
    const sdfCode = fs.readFileSync(sdfFile, 'utf8');
    const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));

    console.log(`Generating mesh for: ${meshName}`);
    console.log(`Size: [${params.size.join(', ')}]`);
    console.log(`Resolution: [${params.resolution.join(', ')}]`);

    const browser = await puppeteer.launch({
        headless: false, // Set to false for debugging, can be changed to true later
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Navigate to the local SDF mesher
    await page.goto('http://localhost:8000');

    // Wait for the page to load
    await page.waitForSelector('.editor', { timeout: 10000 });

    // Inject our custom STL writer
    await page.evaluate(() => {
        // Override the FileSaver to capture the STL data instead of downloading
        window.capturedSTL = null;
        window.originalFileSaver = window.saveAs;
        window.saveAs = function(blob, filename) {
            const reader = new FileReader();
            reader.onload = function() {
                window.capturedSTL = {
                    data: reader.result,
                    filename: filename
                };
            };
            reader.readAsArrayBuffer(blob);
        };
    });

    // Set the SDF code in the editor
    await page.evaluate((sdfCode) => {
        const editor = window.editor;
        if (editor && editor.setValue) {
            editor.setValue(sdfCode);
        }
    }, sdfCode);

    // Set the bounding box size
    await page.evaluate((size) => {
        window.ractive.set('bounding.size.width', size[0]);
        window.ractive.set('bounding.size.height', size[1]);
        window.ractive.set('bounding.size.depth', size[2]);
    }, params.size);

    // Set the download resolution
    await page.evaluate((resolution) => {
        window.ractive.set('download.resolution.x', resolution[0]);
        window.ractive.set('download.resolution.y', resolution[1]);
        window.ractive.set('download.resolution.z', resolution[2]);
    }, params.resolution);

    // Click the download button
    await page.click('#download-button');

    console.log('Mesh generation started...');

    // Wait for the generation to complete
    await page.waitForFunction(() => {
        return window.capturedSTL !== null;
    }, { timeout: 300000 }); // 5 minute timeout

    // Get the generated STL data
    const stlData = await page.evaluate(() => {
        return window.capturedSTL;
    });

    await browser.close();

    if (stlData) {
        // Save the STL file to the meshes directory
        const outputFilename = `${meshName}-${Date.now()}-${params.resolution[0]}x${params.resolution[1]}x${params.resolution[2]}.stl`;
        const outputPath = path.join(meshesDir, outputFilename);

        const buffer = Buffer.from(stlData.data);
        fs.writeFileSync(outputPath, buffer);

        console.log(`✅ Mesh generated successfully!`);
        console.log(`📁 Saved to: ${outputPath}`);
        console.log(`📊 File size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);
    } else {
        console.error('❌ Failed to capture STL data');
        process.exit(1);
    }
}

// Handle command line arguments
const meshName = process.argv[2];
generateMesh(meshName).catch(console.error);
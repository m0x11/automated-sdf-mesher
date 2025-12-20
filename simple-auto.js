#!/usr/bin/env node

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function generateMesh(meshName) {
    if (!meshName) {
        console.error('Usage: node simple-auto.js <mesh-name>');
        console.error('Example: node simple-auto.js snowflake');
        process.exit(1);
    }

    // Read the files
    const sdfDir = path.join(__dirname, '..', 'sdfs', meshName);
    const sdfCode = fs.readFileSync(path.join(sdfDir, 'sdf.txt'), 'utf8');
    const params = JSON.parse(fs.readFileSync(path.join(sdfDir, 'params.json'), 'utf8'));

    console.log(`🚀 Generating mesh for: ${meshName}`);
    console.log(`Size: [${params.size.join(', ')}], Resolution: [${params.resolution.join(', ')}]`);

    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    // Go to the page
    await page.goto('http://localhost:8000');

    // Wait for everything to be ready (5 seconds should be enough)
    await page.waitForSelector('.editor');
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('Setting values...');

    // Set SDF code by clicking in editor and typing
    await page.click('.editor');
    await page.keyboard.down('Meta');
    await page.keyboard.press('a');
    await page.keyboard.up('Meta');
    await page.keyboard.type(sdfCode);

    // Set size inputs
    await page.$eval('#bounding-w', (el, val) => el.value = val, params.size[0]);
    await page.$eval('#bounding-h', (el, val) => el.value = val, params.size[1]);
    await page.$eval('#bounding-d', (el, val) => el.value = val, params.size[2]);

    // Set resolution inputs
    await page.$eval('#download-x', (el, val) => el.value = val, params.resolution[0]);
    await page.$eval('#download-y', (el, val) => el.value = val, params.resolution[1]);
    await page.$eval('#download-z', (el, val) => el.value = val, params.resolution[2]);

    // Trigger change events so the UI updates
    await page.evaluate(() => {
        ['bounding-w', 'bounding-h', 'bounding-d', 'download-x', 'download-y', 'download-z'].forEach(id => {
            const el = document.getElementById(id);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    console.log('Clicking Generate button...');
    // Find and click Generate button
    await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const generateButton = buttons.find(btn => btn.textContent.trim() === 'Generate');
        if (generateButton) {
            generateButton.click();
            console.log('Generate button clicked!');
        } else {
            console.log('Generate button not found');
        }
    });

    console.log('✅ Setup complete! Watch the browser for progress and download.');
    console.log('Press Ctrl+C when done.');

    // Keep running until user stops
    process.stdin.resume();
}

const meshName = process.argv[2];
generateMesh(meshName).catch(console.error);
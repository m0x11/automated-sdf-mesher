#!/usr/bin/env node

const puppeteer = require('puppeteer');

async function testBrowser() {
    console.log('Launching browser...');

    const browser = await puppeteer.launch({
        headless: false, // Let's try with visible browser first
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    console.log('Browser launched, creating page...');
    const page = await browser.newPage();

    console.log('Navigating to localhost:8000...');
    await page.goto('http://localhost:8000');

    console.log('Page loaded, waiting for editor...');
    await page.waitForSelector('.editor', { timeout: 10000 });

    console.log('Editor found! Taking screenshot...');
    await page.screenshot({ path: 'test-screenshot.png' });

    console.log('Closing browser...');
    await browser.close();
    console.log('Test completed successfully!');
}

testBrowser().catch(console.error);
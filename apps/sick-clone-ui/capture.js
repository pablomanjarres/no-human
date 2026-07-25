const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

async function run() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const htmlPath = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');

  console.log('Launching Chrome from:', chromePath);
  console.log('Opening file:', htmlPath);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  await page.goto(htmlPath, { waitUntil: 'networkidle0' });

  const artifactsDir = 'C:\\Users\\juego\\.gemini\\antigravity\\brain\\86e3ea67-7d14-4bd3-ad8b-f0c7ce540814';
  
  // 1. Hero Screenshot
  await page.screenshot({ path: path.join(artifactsDir, 'sick_hero_screenshot.png') });
  console.log('Hero screenshot saved!');

  // 2. Scroll to Products Catalog
  const productsEl = await page.$('#productos');
  if (productsEl) {
    await productsEl.scrollIntoView();
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(artifactsDir, 'sick_catalog_screenshot.png') });
    console.log('Catalog screenshot saved!');
  }

  // 3. Scroll to Sensor Finder Wizard
  const finderEl = await page.$('#finder');
  if (finderEl) {
    await finderEl.scrollIntoView();
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: path.join(artifactsDir, 'sick_wizard_screenshot.png') });
    console.log('Wizard screenshot saved!');
  }

  // 4. Mobile Viewport Screenshot
  await page.setViewport({ width: 414, height: 896 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(artifactsDir, 'sick_mobile_screenshot.png') });
  console.log('Mobile screenshot saved!');

  await browser.close();
  console.log('ALL SCREENSHOTS CAPTURED SUCCESSFULLY!');
}

run().catch(err => {
  console.error('Error during capture:', err);
  process.exit(1);
});

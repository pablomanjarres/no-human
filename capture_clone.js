const puppeteer = require('puppeteer-core');
const path = require('path');

async function run() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const htmlPath = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');
  const artifactsDir = 'C:\\Users\\juego\\.gemini\\antigravity\\brain\\86e3ea67-7d14-4bd3-ad8b-f0c7ce540814';

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(htmlPath, { waitUntil: 'networkidle0' });

  // Hero
  await page.screenshot({ path: path.join(artifactsDir, 'clone_v2_hero.png') });
  console.log('Clone v2 hero saved!');

  // Scroll sections
  for (let i = 1; i <= 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 900));
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: path.join(artifactsDir, `clone_v2_section${i}.png`) });
    console.log(`Clone v2 section ${i} saved!`);
  }

  await browser.close();
  console.log('DONE!');
}

run().catch(err => { console.error(err.message); process.exit(1); });

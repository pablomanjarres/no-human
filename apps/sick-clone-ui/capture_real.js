const puppeteer = require('puppeteer-core');
const path = require('path');

async function run() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const artifactsDir = 'C:\\Users\\juego\\.gemini\\antigravity\\brain\\86e3ea67-7d14-4bd3-ad8b-f0c7ce540814';

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1400,5000']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  // Navigate to real SICK website
  console.log('Loading real SICK website...');
  await page.goto('https://www.sick.com/es/es', { waitUntil: 'networkidle2', timeout: 30000 });
  
  // Wait a bit for SPA to render
  await new Promise(r => setTimeout(r, 3000));
  
  // Take hero screenshot
  await page.screenshot({ path: path.join(artifactsDir, 'real_sick_hero.png') });
  console.log('Real SICK hero screenshot saved!');

  // Scroll down to see more sections
  await page.evaluate(() => window.scrollBy(0, 900));
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(artifactsDir, 'real_sick_section2.png') });
  console.log('Real SICK section 2 screenshot saved!');

  // Scroll further
  await page.evaluate(() => window.scrollBy(0, 900));
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(artifactsDir, 'real_sick_section3.png') });
  console.log('Real SICK section 3 screenshot saved!');

  // Scroll further
  await page.evaluate(() => window.scrollBy(0, 900));
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(artifactsDir, 'real_sick_section4.png') });
  console.log('Real SICK section 4 screenshot saved!');

  // Scroll to footer
  await page.evaluate(() => window.scrollBy(0, 900));
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(artifactsDir, 'real_sick_footer.png') });
  console.log('Real SICK footer screenshot saved!');

  // Scroll to very bottom
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(artifactsDir, 'real_sick_footer_bottom.png') });
  console.log('Real SICK footer bottom screenshot saved!');

  // Also extract rendered text
  const bodyText = await page.evaluate(() => document.body.innerText);
  const fs = require('fs');
  fs.writeFileSync(path.join(artifactsDir, 'real_sick_text.txt'), bodyText, 'utf8');
  console.log('Real SICK text content saved!');

  await browser.close();
  console.log('DONE!');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

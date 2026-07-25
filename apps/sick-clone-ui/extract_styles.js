const puppeteer = require('puppeteer-core');

async function run() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto('https://www.sick.com/es/es', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));

  const styles = await page.evaluate(() => {
    const getComputed = (selector, props) => {
      const el = document.querySelector(selector);
      if (!el) return `[NOT FOUND: ${selector}]`;
      const cs = window.getComputedStyle(el);
      return props.reduce((acc, p) => { acc[p] = cs.getPropertyValue(p); return acc; }, {});
    };

    // Get all font-face declarations from stylesheets
    const fontFaces = [];
    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.type === CSSRule.FONT_FACE_RULE) {
              fontFaces.push(rule.cssText.substring(0, 300));
            }
          }
        } catch(e) {}
      }
    } catch(e) {}

    const props = ['font-family','font-size','font-weight','letter-spacing','text-transform','color','background-color','line-height'];
    
    return {
      fontFaces: fontFaces.slice(0, 10),
      body: getComputed('body', props),
      nav: getComputed('nav', props),
      navLinks: getComputed('nav a', props),
      h1: getComputed('h1', props),
      h2: getComputed('h2', props),
      // Try to get SICK-specific elements
      header: getComputed('header', ['font-family','background-color','height','padding']),
      heroHeading: getComputed('.hero h1, [class*="hero"] h1, main h1', props),
      // CSS variables
      cssVars: (() => {
        const root = document.documentElement;
        const cs = window.getComputedStyle(root);
        const vars = {};
        // Try common var names
        ['--color-primary','--color-blue','--font-family','--primary-color','--brand-color'].forEach(v => {
          const val = cs.getPropertyValue(v);
          if (val) vars[v] = val;
        });
        return vars;
      })()
    };
  });

  console.log(JSON.stringify(styles, null, 2));
  await browser.close();
}
run().catch(e => console.error(e.message));

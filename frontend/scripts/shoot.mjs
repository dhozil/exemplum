import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5173';
const OUT = 'C:/Users/dhozi/AppData/Local/Temp/opencode/shots';

const PAGES = [
  ['landing', '/', 1440, 1000],
  ['landing-mobile', '/', 420, 900],
  ['how-it-works', '/how-it-works', 1440, 1000],
  ['records', '/records', 1440, 1000],
  ['record-0', '/records/0', 1440, 1100],
  ['notarize', '/notarize', 1440, 1000],
  ['settlements', '/settlements', 1440, 1100],
  ['settlement-new', '/settlements/new', 1440, 900, true],
  ['settlement-new-mobile', '/settlements/new', 420, 900, true],
  ['settlement-0', '/settlements/0', 1440, 1100],
  ['trust', '/trust', 1440, 1000],
  ['network', '/network', 1440, 1000],
  ['notfound', '/nope', 1440, 700],
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
for (const [name, path, w, h, full] of PAGES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 45000 });
  } catch {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: Boolean(full) });
  const text = await page.evaluate(() => document.body.innerText.slice(0, 260).replace(/\n+/g, ' | '));
  console.log(`\n== ${name} (${path}) ==`);
  console.log('   text:', text);
  if (errors.length) console.log('   ERRORS:', errors.slice(0, 4).join(' || '));
  await ctx.close();
}
await browser.close();
console.log('\ndone');

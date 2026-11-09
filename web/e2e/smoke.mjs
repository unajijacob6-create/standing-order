// Playwright smoke test: build must exist (npm run build), then `node e2e/smoke.mjs`.
// Serves dist/, loads the dashboard against the configured network, waits for live plan data,
// checks the key elements and saves screenshots to e2e/out/.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
// Playwright may be installed globally (CI images) rather than in this package: resolve via require.
const { chromium } = createRequire(import.meta.url)("playwright");
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
fs.mkdirSync(out, { recursive: true });
const port = 4173;
const server = spawn(path.join(here, "..", "node_modules", ".bin", "vite"), ["preview", "--port", String(port), "--strictPort"], { cwd: path.join(here, ".."), stdio: ["ignore", "inherit", "inherit"] });
const hardStop = setTimeout(() => { console.error("smoke test timed out"); server.kill(); process.exit(1); }, 150_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await sleep(2500);
  // Behind a corporate/CI proxy the browser needs the same proxy as curl (localhost bypassed).
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined;
  // Use the machine's preinstalled Chromium when present (CI images); else Playwright's own download.
  const executablePath = process.env.PW_CHROMIUM || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  const browser = await chromium.launch({ proxy, executablePath, args: ["--no-sandbox", "--headless=new"] });
  console.log("browser launched");
  const failures = [];
  for (const [name, viewport, scheme] of [["desktop", { width: 1366, height: 900 }, "light"], ["desktop-dark", { width: 1366, height: 900 }, "dark"], ["phone", { width: 390, height: 844 }, "light"]]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    console.log(`${name}: page loaded`);
    await page.waitForSelector(".plan", { timeout: 30_000 }).catch(() => failures.push(`${name}: no plan cards rendered`));
    await page.waitForSelector(".detail tbody tr, .detail .empty:not(:has-text('Loading'))", { timeout: 30_000 }).catch(() => failures.push(`${name}: payout history never loaded`));
    await page.waitForTimeout(1500);
    const title = await page.title();
    if (title !== "Standing Order") failures.push(`${name}: title ${title}`);
    const plans = await page.locator(".plan").count();
    const stats = await page.locator(".stat .value").allTextContents();
    const hasDetail = (await page.locator(".detail").count()) > 0;
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    if (overflow) failures.push(`${name}: horizontal overflow`);
    if (!hasDetail) failures.push(`${name}: detail panel missing`);
    console.log(JSON.stringify({ name, plans, stats, hasDetail, errors: errors.slice(0, 3) }));
    if (errors.some((e) => !/favicon|ERR_CONNECTION_REFUSED|Failed to fetch|net::/.test(e))) failures.push(`${name}: console errors ${errors.join(" | ").slice(0, 300)}`);
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
    // Second page: Treasury & proof (requests, clerk, destination).
    await page.click('nav a[href="#treasury"]');
    await page.waitForSelector(".req", { timeout: 30_000 }).catch(() => failures.push(`${name}: treasury page shows no requests`));
    const hasClerk = (await page.locator("#clerk").count()) > 0;
    const hasDestination = (await page.locator("#destination").count()) > 0;
    if (!hasClerk || !hasDestination) failures.push(`${name}: treasury page missing clerk or destination panel`);
    if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)) failures.push(`${name}: horizontal overflow on treasury page`);
    await page.screenshot({ path: path.join(out, `${name}-treasury.png`), fullPage: true });
    await ctx.close();
  }
  await browser.close();
  if (failures.length) {
    console.error("SMOKE FAILURES:\n" + failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("smoke ok; screenshots in web/e2e/out/");
  }
} finally {
  clearTimeout(hardStop);
  server.kill();
}

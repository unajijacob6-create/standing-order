// Record a captioned ~85 s tour of the dashboard to docs/demo.webm and docs/demo.mp4.
// Usage: node web/e2e/record-demo.mjs [url]   (default: the live GitHub Pages site)
// Tip: start it right after a payday lands so the "Live payouts" feed shows the fresh rows.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] ?? "https://unajijacob6-create.github.io/standing-order/";
const outDir = path.join(here, "..", "..", "docs");
const tmp = path.join(here, "out", "video");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined;
const executablePath = process.env.PW_CHROMIUM || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch({ proxy, executablePath, args: ["--no-sandbox", "--headless=new"] });
const size = { width: 1440, height: 900 };

// Load once outside the recording so the video starts on a rendered page, not a spinner.
const warm = await browser.newPage({ viewport: size });
await warm.goto(url, { waitUntil: "networkidle" });
await warm.close();

const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, recordVideo: { dir: tmp, size } });
const page = await ctx.newPage();
await page.goto(url + "?v=" + Date.now(), { waitUntil: "networkidle" });
await page.waitForSelector(".feed li", { timeout: 60_000 });

await page.addStyleTag({
  content: `#demo-cap{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:99999;max-width:1100px;
  padding:16px 26px;border-radius:14px;background:rgba(10,12,16,.88);color:#fff;font:600 24px/1.35 Inter,system-ui,sans-serif;
  text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.35);transition:opacity .35s}#demo-cap small{display:block;font-weight:500;
  font-size:17px;opacity:.75;margin-top:6px}#demo-cap.off{opacity:0}
  .demo-spot{outline:3px solid #00ec97 !important;outline-offset:4px;border-radius:12px;transition:outline-color .3s}`,
});
await page.evaluate(() => {
  const d = document.createElement("div");
  d.id = "demo-cap";
  d.className = "off";
  document.body.appendChild(d);
});

const wait = (ms) => page.waitForTimeout(ms);
async function cap(text, sub = "") {
  await page.evaluate(([t, s]) => {
    const d = document.getElementById("demo-cap");
    d.innerHTML = "";
    d.append(t);
    if (s) {
      const sm = document.createElement("small");
      sm.textContent = s;
      d.append(sm);
    }
    d.className = "";
  }, [text, sub]);
}
async function spot(selector) {
  await page.evaluate((sel) => {
    document.querySelectorAll(".demo-spot").forEach((e) => e.classList.remove("demo-spot"));
    const el = sel && document.querySelector(sel);
    if (el) el.classList.add("demo-spot");
  }, selector);
}
async function scrollTo(selector, offset = 90) {
  await page.evaluate(([sel, off]) => {
    const el = document.querySelector(sel);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: "smooth" });
  }, [selector, offset]);
  await wait(1200);
}

// 1. Problem and pitch
await cap("A DAO pays the same people every month: a new proposal, vote and signature every time.", "Standing Order: vote once, and payday runs itself.");
await wait(7000);

// 2. Plans funded by one proposal
await scrollTo(".plan");
await spot(".plan");
await cap("One Sputnik DAO proposal funds a plan: recipients, cadence and a cap per run.", "The funds stay in an on-chain contract; the DAO can pause, top up or sweep them by vote.");
await wait(8000);

// 3. Payout history of the selected plan
await page.locator(".plan", { hasText: "every 10 minutes" }).first().click();
await wait(1500);
await scrollTo(".detail", 80);
await spot(".detail");
await wait(1500);
await scrollTo(".detail table.payouts", 260);
await cap("A run starts only when the plan can cover it in full. Every payout is recorded on-chain.", "Export CSV gives the treasury a ledger for its books.");
await wait(5000);
const more = await page.$(".detail button.show-more");
if (more) {
  await more.click();
  await wait(3500);
  await more.click();
  await wait(800);
}

// 4. Live feed
await scrollTo(".feed", 160);
await spot(".feed");
await cap("Nobody signs on payday. A keeper whose key can only call run_due triggers it.", "These rows landed seconds ago on NEAR testnet; each links to its block.");
await wait(8000);

// 5. Treasury page: proposals
await spot(null);
await page.click('nav a[href="#treasury"]');
await page.waitForSelector(".req", { timeout: 60_000 });
await wait(1200);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await spot(".page-treasury .card");
await cap("Every change is a DAO proposal, with Trezu templates included.", "Pause, resume with or without back pay, update, cancel. A named guardian can pause alone.");
await wait(8000);

// 6. Private payroll clerk
await scrollTo("#clerk", 100);
await spot("#clerk");
await cap("A payroll clerk on NEAR AI Cloud drafts the proposal from invoices and reviews new ones.", "Private inference; each answer comes with a signed receipt.");
await wait(6000);
const vt = await page.$(".verify-toggle");
if (vt) {
  await vt.click();
  await wait(700);
  await scrollTo(".verify-toggle", 120);
}
await cap("This page checks the receipt itself: the signer recovers from the hashes and matches the attestation report.");
await wait(7000);

// 7. Destination
await scrollTo("#destination", 100);
await spot("#destination");
await cap("On mainnet, recipients can take USDC on Base, Arbitrum or Solana through NEAR Intents.", "The contract checks the 1Click quote signature before it pays a route.");
await wait(8000);

// 8. Call to action
await spot(null);
await page.click('nav a[href="#top"]');
await wait(600);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await wait(900);
await cap("Check it yourself in about 20 seconds, no keys needed:  npm run judge", "github.com/unajijacob6-create/standing-order");
await wait(7000);

await ctx.close();
await browser.close();
const webm = fs.readdirSync(tmp).find((f) => f.endsWith(".webm"));
fs.copyFileSync(path.join(tmp, webm), path.join(outDir, "demo.webm"));
try {
  execSync(`ffmpeg -y -loglevel error -i "${path.join(outDir, "demo.webm")}" -c:v libx264 -crf 23 -pix_fmt yuv420p -movflags +faststart "${path.join(outDir, "demo.mp4")}"`);
  console.log("wrote docs/demo.webm and docs/demo.mp4");
} catch {
  console.log("wrote docs/demo.webm (ffmpeg not available for mp4)");
}

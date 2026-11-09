// Record a captioned tour of the dashboard to docs/demo.webm and docs/demo.mp4.
// Usage: node web/e2e/record-demo.mjs [url]   (default: the live GitHub Pages site)
// Narrated: NARRATION_AUDIO=narration.mp3 NARRATION_TIMINGS=timings.json node web/e2e/record-demo.mjs
// (timings.json holds the start of each scene's sentence, from ElevenLabs text-to-speech with-timestamps).
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
const videoStart = Date.now(); // the recording starts with the page
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

// Scene timing. With NARRATION_TIMINGS (JSON from ElevenLabs with-timestamps: {timings:[{start,end}], total}) each caption
// changes when its narration sentence starts and the scene's actions run inside that sentence; otherwise fixed lengths.
const narr = process.env.NARRATION_TIMINGS ? JSON.parse(fs.readFileSync(process.env.NARRATION_TIMINGS, "utf8")) : null;
const fixed = [8, 9, 11, 9, 9, 7, 7, 9, 8];
const starts = narr ? narr.timings.map((t) => t.start) : fixed.map((_, i) => fixed.slice(0, i).reduce((a, b) => a + b, 0));
const endAt = narr ? narr.total + 1.5 : fixed.reduce((a, b) => a + b, 0);
let t0 = 0;
const until = async (sec) => { const ms = t0 + sec * 1000 - Date.now(); if (ms > 0) await wait(ms); };
const left = (i) => t0 + (starts[i + 1] ?? endAt) * 1000 - Date.now();
const scenes = [
  async () => {
    await cap("A DAO pays the same people every month: a new proposal, vote and signature every time.", "Standing Order: vote once, and payday runs itself.");
  },
  async () => {
    await cap("One Sputnik DAO proposal funds a plan: recipients, cadence and a cap per run.", "The funds stay in an on-chain contract; the DAO can pause, top up or sweep them by vote.");
    await scrollTo(".plan");
    await spot(".plan");
  },
  async (i) => {
    await cap("A run starts only when the plan can cover it in full. Every payout is recorded on-chain.", "Export CSV gives the treasury a ledger for its books.");
    await page.locator(".plan", { hasText: "every 10 minutes" }).first().click();
    await wait(900);
    await scrollTo(".detail", 80);
    await spot(".detail");
    await wait(800);
    await scrollTo(".detail table.payouts", 260);
    const more = await page.$(".detail button.show-more");
    if (more && left(i) > 2500) await more.click();
  },
  async () => {
    await cap("Nobody signs on payday. A keeper whose key can only call run_due triggers it.", "These rows landed moments ago on NEAR testnet; each links to its block.");
    await scrollTo(".feed", 160);
    await spot(".feed");
  },
  async () => {
    await cap("Every change is a DAO proposal, with Trezu templates included.", "Pause, resume with or without back pay, update, cancel. A named guardian can pause alone.");
    await spot(null);
    await page.click('nav a[href="#treasury"]');
    await page.waitForSelector(".req", { timeout: 60_000 });
    await wait(600);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await spot(".page-treasury .card");
  },
  async () => {
    await cap("A payroll clerk on NEAR AI Cloud drafts the proposal from invoices and reviews new ones.", "Private inference; each answer comes with a signed receipt.");
    await scrollTo("#clerk", 100);
    await spot("#clerk");
  },
  async () => {
    await cap("This page checks the receipt itself: the signer recovers from the hashes and matches the attestation report.");
    const vt = await page.$(".verify-toggle");
    if (vt) {
      await vt.click();
      await wait(500);
      await scrollTo(".verify-toggle", 120);
    }
  },
  async () => {
    await cap("On mainnet, recipients can take USDC on Base, Arbitrum or Solana through NEAR Intents.", "The contract checks the 1Click quote signature before it pays a route.");
    await scrollTo("#destination", 100);
    await spot("#destination");
  },
  async () => {
    await cap("Check it yourself in about 20 seconds, no keys needed:  npm run judge", "github.com/unajijacob6-create/standing-order");
    await spot(null);
    await page.click('nav a[href="#top"]');
    await wait(400);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  },
];
await wait(400);
t0 = Date.now();
const leadIn = (t0 - videoStart) / 1000;
for (let i = 0; i < scenes.length; i++) {
  await until(starts[i]);
  await scenes[i](i);
}
await until(endAt);

await ctx.close();
await browser.close();
const webm = fs.readdirSync(tmp).find((f) => f.endsWith(".webm"));
fs.copyFileSync(path.join(tmp, webm), path.join(outDir, "demo.webm"));
console.log(`narration starts ${leadIn.toFixed(2)} s into the video`);
const webmPath = path.join(outDir, "demo.webm");
const mp4Path = path.join(outDir, "demo.mp4");
// With NARRATION_AUDIO, the narration is laid in from the moment the first caption appears.
const audio = process.env.NARRATION_AUDIO;
const ms = Math.round(leadIn * 1000);
const cmd = audio
  ? `ffmpeg -y -loglevel error -i "${webmPath}" -i "${audio}" -filter_complex "[1:a]adelay=${ms}|${ms},loudnorm=I=-16:TP=-1.5:LRA=11,apad[a]" -map 0:v -map "[a]" -c:v libx264 -crf 23 -pix_fmt yuv420p -c:a aac -b:a 160k -ar 44100 -shortest -movflags +faststart "${mp4Path}"`
  : `ffmpeg -y -loglevel error -i "${webmPath}" -c:v libx264 -crf 23 -pix_fmt yuv420p -movflags +faststart "${mp4Path}"`;
try {
  execSync(cmd);
  console.log(`wrote docs/demo.webm and docs/demo.mp4${audio ? " with narration" : ""}`);
} catch {
  console.log("wrote docs/demo.webm (ffmpeg not available for mp4)");
}

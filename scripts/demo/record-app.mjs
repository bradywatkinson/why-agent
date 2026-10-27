// Records the live end-to-end demo of the Why Agent UI with burnt-in captions.
// Output: /workspace/demo-build/app.webm + markers.json (segment start times in seconds).
import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "/workspace/demo-build";
const segs = Object.fromEntries(JSON.parse(fs.readFileSync(`${OUT}/segments.json`, "utf8")).map((s) => [s.id, s]));
const hold = (id) => (segs[id].dur + 0.9) * 1000;
const Q = "Why did average tips change between December 2024 and January 2025?";

const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: `${OUT}/rec`, size: { width: 1600, height: 900 } } });
const page = await ctx.newPage();
const t0 = Date.now();
const markers = [];
const mark = (id) => markers.push({ id, t: (Date.now() - t0) / 1000 });
const sleep = (ms) => page.waitForTimeout(ms);

await page.goto("http://localhost:8787/");
await page.waitForFunction(() => document.querySelector("#adapter")?.textContent.startsWith("LIVE"));
await page.addStyleTag({ content: `
  #cap { position: fixed; left: 50%; transform: translateX(-50%); bottom: 16px; z-index: 9999; max-width: 1180px; width: max-content;
    background: rgba(8,12,20,.92); border: 1px solid #3b82f6; border-radius: 12px; padding: 12px 22px; box-shadow: 0 8px 30px rgba(0,0,0,.5);
    font: 600 19px/1.35 system-ui, sans-serif; color: #f1f5f9; text-align: center; }
  #cap small { display: block; font: 400 15px/1.4 system-ui, sans-serif; color: #93c5fd; margin-top: 3px; }
  #fast { position: fixed; top: 56px; left: 50%; transform: translateX(-50%); z-index: 9999; display: none;
    background: #f59e0b; color: #111; font: 700 19px system-ui, sans-serif; padding: 10px 20px; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
  .spot { outline: 3px solid #f59e0b !important; outline-offset: 4px; border-radius: 8px; transition: outline .2s; }
  html { scroll-behavior: smooth; zoom: 1.25; }` });
await page.evaluate(() => {
  const c = document.createElement("div"); c.id = "cap"; document.body.appendChild(c);
  const f = document.createElement("div"); f.id = "fast"; f.textContent = "⏩ Zetaris scanning 38.7M rows — sped up"; document.body.appendChild(f);
});
const cap = (title, sub) => page.evaluate(([t, s]) => { document.querySelector("#cap").innerHTML = `${t}${s ? `<small>${s}</small>` : ""}`; }, [title, sub]);
const spot = (sel) => page.evaluate((s) => { document.querySelectorAll(".spot").forEach((e) => e.classList.remove("spot")); if (s) document.querySelector(s)?.classList.add("spot"); }, sel);
const scrollTo = (sel, block = "start") => page.evaluate(([s, b]) => document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: b }), [sel, block]);

// s02 — LIVE badge
mark("s02_live");
await cap("Why Agent — connected LIVE to a real Zetaris instance", "Badge: LIVE · zetaris@http://localhost:3000 (local Zetaris platform, NY_TAXI federated data)");
await spot("#adapter");
await sleep(hold("s02_live"));

// s03 — ask
mark("s03_ask");
await spot("#q");
await cap("Ask a plain-English “why” question", "Deterministic rule-based planner (no LLM): every number comes from rows Zetaris returns");
await page.click("#q");
await page.keyboard.type(Q, { delay: 35 });
await sleep(Math.max(500, hold("s03_ask") - Q.length * 35 - 1200));
await spot(null);
await page.click("#go");
await sleep(1200);

// s04 — guard + memory recall
mark("s04_guard");
await cap("Meterless Scout guard → Meterless H-MEM recall", "Question screened for prompt injection first; schema recalled from H-MEM memory, so discovery is skipped");
await spot("#events");
await sleep(hold("s04_guard"));

// s05 — the scan (sped up in post)
mark("s05_scan");
await cap("ONE federated Zetaris query: yellow_taxi ⋈ taxi_zones", "Grouped by payment × rate code × borough × distance × time of day — every breakdown is rolled up from this one result");
await page.evaluate(() => (document.querySelector("#fast").style.display = "block"));
await page.waitForFunction(() => /answered|blocked|error|unanswerable/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 600000 });
await page.evaluate(() => (document.querySelector("#fast").style.display = "none"));
mark("s05_end");

// s06 — answer
mark("s06_answer");
await cap("A cited answer: −$0.50 average tip, Dec 2024 → Jan 2025", "Mostly within-segment (Manhattan, card trips); the missing-rate-code group = payment code 0, so it is counted once");
await spot(null);
await scrollTo("#answerPanel");
await sleep(600);
await spot("#answerPanel");
await sleep(hold("s06_answer") - 600);

// s07 — citations → query rows → raw cube cells
mark("s07_cite");
await spot(null);
await cap("Every claim cites its evidence", "Citation → exact query + highlighted rows → raw Zetaris cube cells behind each roll-up");
const driverRef = page.locator("#answer [data-c]").nth(4);
if (await driverRef.count()) await driverRef.click(); else await page.locator("#answer [data-c]").first().click();
await sleep(1800);
await page.locator(".claim.sel .cit[data-q]").first().click();
await sleep(2600);
const cells = page.locator(".q.sel tr.hl .cit[data-q]").first();
if (await cells.count()) { await cells.click(); await sleep(Math.max(1000, hold("s07_cite") - 4400)); } else await sleep(hold("s07_cite") - 4400);

// s08 — self-checks + decomposition
mark("s08_checks");
await page.evaluate(() => document.querySelectorAll(".q.open").forEach((q) => q.classList.remove("open", "sel")));
await cap("Self-checks and caveats", "Each breakdown reproduces the headline; segment contributions sum exactly to the change · descriptive, not causal");
await scrollTo("#decompPanel");
await sleep(500);
await spot("#decompPanel");
await sleep(hold("s08_checks") / 2);
await spot(null);
await page.evaluate(() => { const c = [...document.querySelectorAll(".claim")].find((x) => /Self-check/.test(x.textContent)); c?.classList.add("spot"); c?.scrollIntoView({ behavior: "smooth", block: "center" }); });
await sleep(hold("s08_checks") / 2 - 500);

// s09 — memory
mark("s09_memory");
await spot(null);
await cap("Meterless H-MEM: memory with provenance + TrustLedger", "“Matches what was recorded earlier” · create / read / supersede history · 👍 feedback adjusts confidence");
const memClaim = page.locator(".claim", { hasText: "matches what was recorded" }).first();
if (await memClaim.count()) {
  await memClaim.scrollIntoViewIfNeeded(); await memClaim.evaluate((e) => e.classList.add("spot")); await sleep(2500);
  await memClaim.locator(".cit[data-mem]").first().click();
} else {
  await page.locator("#mem .cit[data-mem]").first().click();
}
await sleep(1500);
await scrollTo("#memPanel", "start");
await sleep(1500);
await spot("#memPanel");
await page.locator("[data-fb=helpful]").click();
await sleep(Math.max(1000, hold("s09_memory") - 5500));

// s10 — injection
mark("s10_inject");
await spot(null);
await cap("Prompt injection → blocked by the Scout guard", "No query is sent to Zetaris");
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await sleep(600);
await page.locator(".chip", { hasText: "Ignore all previous" }).click();
await page.waitForFunction(() => /blocked/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 30000 });
await spot("#answerPanel");
await sleep(hold("s10_inject") - 600);
mark("end");

fs.writeFileSync(`${OUT}/markers.json`, JSON.stringify(markers, null, 1));
const v = page.video();
await ctx.close();
fs.copyFileSync(await v.path(), `${OUT}/app.webm`);
await b.close();
console.log(JSON.stringify(markers));

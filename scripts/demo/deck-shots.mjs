// Clean (caption-free) deck screenshots of saved live runs.
import { chromium } from "playwright";
const [ANS, BLK] = process.argv.slice(2);
const M = "/workspace/openagent/media";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
const load = async (id) => { await p.goto("about:blank"); await p.goto(`http://localhost:8787/#${id}`); await p.waitForSelector("#answerPanel:not([hidden])"); await p.addStyleTag({ content: "html{zoom:1.25}" }); await p.waitForTimeout(800); };
await load(ANS);
await p.screenshot({ path: `${M}/01-answer-live.png` });
// citation: click a claim's citation to highlight cited rows
const cit = p.locator("#claims .cit[data-q]").nth(1);
await cit.scrollIntoViewIfNeeded(); await cit.click(); await p.waitForTimeout(800);
await p.screenshot({ path: `${M}/02-citation-rows.png` });
await p.evaluate(() => document.querySelectorAll("#queries details[open]").forEach((d) => d.open = false));
await p.locator("#decompPanel").scrollIntoViewIfNeeded(); await p.evaluate(() => document.querySelector("#decompPanel").scrollIntoView({ block: "start" })); await p.waitForTimeout(400);
await p.screenshot({ path: `${M}/03-decomposition.png` });
await load(ANS);
const mc = p.locator(".cit[data-mem]").first();
if (await mc.count()) { await mc.scrollIntoViewIfNeeded(); await mc.click(); await p.waitForTimeout(800); }
await p.evaluate(() => document.querySelector("#memPanel").scrollIntoView({ block: "start" })); await p.waitForTimeout(400);
await p.screenshot({ path: `${M}/04-memory-ledger.png` });
await load(BLK);
await p.screenshot({ path: `${M}/05-injection-blocked.png` });
await b.close();

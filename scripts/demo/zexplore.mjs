import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, storageState: "/workspace/demo-build/zstate.json" });
const p = await ctx.newPage();
await p.goto("http://localhost:3000");
await p.waitForTimeout(3000);
const nt = p.getByRole("button", { name: "No thanks" }); if (await nt.isVisible().catch(() => false)) await nt.click();
await p.getByText("File Source & API", { exact: false }).first().click();
await p.waitForTimeout(2500);
await p.screenshot({ path: "/workspace/demo-build/z2.png" });
const t = await p.getByText("NY_TAXI", { exact: false }).first();
if (await t.isVisible().catch(() => false)) { await t.click(); await p.waitForTimeout(2500); }
await p.screenshot({ path: "/workspace/demo-build/z3.png" });
await ctx.storageState({ path: "/workspace/demo-build/zstate.json" });
await b.close();

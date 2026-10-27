// Renders title / proof / end cards as 1920x1080 PNGs.
import { chromium } from "playwright";
import fs from "node:fs";
const OUT = "/workspace/demo-build";
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const base = `<style>body{margin:0;width:1920px;height:1080px;background:radial-gradient(1200px 700px at 30% 20%,#13254a,#070b14);color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;justify-content:center;align-items:center}
h1{font-size:110px;margin:0;letter-spacing:-2px}h2{font-size:44px;font-weight:500;color:#93c5fd;margin:18px 0 0}.by{font-size:36px;margin-top:46px;color:#cbd5e1}
.pill{display:inline-block;border:1px solid #334155;border-radius:999px;padding:10px 24px;margin:8px;font-size:28px;color:#cbd5e1}
.term{width:1500px;background:#0b1220;border:1px solid #334155;border-radius:16px;padding:30px 40px;font:24px/1.4 "DejaVu Sans Mono",monospace;white-space:pre;color:#cbd5e1;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.cap{font-size:40px;font-weight:600;margin-bottom:26px}.sub{font-size:28px;color:#93c5fd;margin-top:22px}.PASS{color:#4ade80}</style>`;
const verify = fs.readFileSync(`${OUT}/verify.txt`, "utf8").replace(/\n?Sign in as.*$/s, "").trim();
const ps = fs.readFileSync(`${OUT}/ps.txt`, "utf8").trim();
const z = fs.readFileSync(`${OUT}/z3.png`).toString("base64");
const cards = {
  title: `${base}<h1>Why Agent</h1><h2>An agent that can explain <i>why</i> — and cite every sentence</h2>
    <div style="margin-top:40px"><span class="pill">Zetaris · federated SQL</span><span class="pill">Meterless · H-MEM memory + Scout guard</span></div>
    <div class="by">Open Agent Hackathon 2026 · Ben Wat</div>`,
  proof1: `${base}<div class="cap">Proof: a real Zetaris platform running locally (Docker)</div>
    <div class="term">$ ./verify.sh\n${esc(verify).replace(/PASS/g, '<span class="PASS">PASS</span>')}\n\n$ docker compose ps\n${esc(ps)}</div>`,
  proof2: `${base}<div class="cap">Zetaris UI: NY_TAXI registered as a federated source (CSV in S3)</div>
    <img src="data:image/png;base64,${z}" style="width:1500px;border:1px solid #334155;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6)">
    <div class="sub">yellow_taxi (38.7M rows) ⋈ taxi_zones — queried live by the agent through the Zetaris REST API</div>`,
  end: `${base}<h1 style="font-size:96px">Why Agent</h1><h2>Explainable by construction</h2>
    <div style="margin-top:44px;font-size:30px;line-height:1.7;text-align:center;color:#cbd5e1">
    <b>Zetaris</b> — live federated evidence: one guarded query per question, catalogue-driven discovery<br>
    <b>Meterless H-MEM</b> — findings with provenance, recall, supersede, TrustLedger, feedback<br>
    <b>Meterless Scout guard</b> — question, SQL and returned-data screening</div>
    <div class="by" style="font-size:28px;color:#94a3b8">Deterministic planner (no LLM) · every claim cites query rows · built without Cursor<br>Ben Wat · Open Agent Hackathon 2026</div>`,
};
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
for (const [k, html] of Object.entries(cards)) { await p.setContent(html); await p.waitForTimeout(300); await p.screenshot({ path: `${OUT}/card_${k}.png` }); }
await b.close();

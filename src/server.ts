// Single-page web app server (no framework). Streams the investigation's
// audit events over Server-Sent Events, then sends the full run record.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadDotEnv, makeAdapter } from "./config.ts";
import { investigate, type RunRecord } from "./agent/investigate.ts";
import * as mem from "./agent/memory.ts";

loadDotEnv();
const adapter = makeAdapter();
const PORT = Number(process.env.PORT ?? 8787);
const ROOT = process.cwd();
const RUNS = path.join(ROOT, ".runs");
fs.mkdirSync(RUNS, { recursive: true });
let busy: Promise<unknown> = Promise.resolve();

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(ROOT, "public", "index.html")));
    }
    if (url.pathname === "/api/status") {
      return json(res, 200, { adapter: { kind: adapter.kind, label: adapter.label, dialect: adapter.dialect }, planner: "deterministic rule-based (no LLM)", memory: await mem.stats() });
    }
    if (url.pathname === "/api/ask") {
      const q = (url.searchParams.get("q") ?? "").slice(0, 1000);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const job = busy.then(async () => {
        const run = await investigate(adapter, q, { rediscover: url.searchParams.get("rediscover") === "1", onEvent: (e) => send("audit", e) });
        fs.writeFileSync(path.join(RUNS, `${run.id}.json`), JSON.stringify(run, null, 2));
        send("run", run);
        res.end();
      });
      busy = job.catch(() => undefined);
      return;
    }
    if (url.pathname === "/api/runs") {
      const files = fs.readdirSync(RUNS).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 30);
      return json(res, 200, files.map((f) => {
        const r = JSON.parse(fs.readFileSync(path.join(RUNS, f), "utf-8")) as RunRecord;
        return { id: r.id, question: r.question, status: r.status, adapter: r.adapter.kind, startedAt: r.startedAt };
      }));
    }
    const runM = url.pathname.match(/^\/api\/runs\/(run-[\w-]+)$/);
    if (runM) {
      const f = path.join(RUNS, `${runM[1]}.json`);
      return fs.existsSync(f) ? json(res, 200, JSON.parse(fs.readFileSync(f, "utf-8"))) : json(res, 404, { error: "not found" });
    }
    const memM = url.pathname.match(/^\/api\/memory\/(mem-\d+)$/);
    if (memM) return json(res, 200, await mem.audit(memM[1]));
    if (url.pathname === "/api/feedback" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { runId, kind } = JSON.parse(body || "{}");
      const f = path.join(RUNS, `${String(runId).replace(/[^\w-]/g, "")}.json`);
      if (!fs.existsSync(f) || !["helpful", "not_helpful", "wrong"].includes(kind)) return json(res, 400, { error: "bad request" });
      const run = JSON.parse(fs.readFileSync(f, "utf-8")) as RunRecord;
      await mem.feedback(run.memoriesWritten, kind);
      return json(res, 200, { ok: true, updated: run.memoriesWritten });
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`why-agent on http://localhost:${PORT} | adapter: ${adapter.label}`));

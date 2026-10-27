// Picks the SQL adapter from the environment. ZETARIS_BASE_URL set -> live
// Zetaris; otherwise the offline fixture (clearly labelled in every run).
import fs from "node:fs";
import path from "node:path";
import { FixtureAdapter } from "./adapters/fixture.ts";
import { ZetarisAdapter, zetarisConfigFromEnv } from "./adapters/zetaris.ts";
import type { SqlAdapter } from "./adapters/types.ts";

export function loadDotEnv(file = path.join(process.cwd(), ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export function makeAdapter(): SqlAdapter {
  const cfg = process.env.AGENT_ADAPTER === "fixture" ? undefined : zetarisConfigFromEnv();
  const adapter: SqlAdapter = cfg ? new ZetarisAdapter(cfg) : new FixtureAdapter();
  // Keep live and fixture memories apart so a synthetic finding is never recalled as evidence about real data.
  process.env.MEMORY_DIR ??= path.join(process.cwd(), ".memory", adapter.kind);
  return adapter;
}

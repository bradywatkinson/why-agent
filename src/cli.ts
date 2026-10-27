// CLI: npx tsx src/cli.ts ask "Why did average tips change between Feb 2023 and Mar 2023?"
//      npx tsx src/cli.ts sql "SELECT 1"        (guarded, read-only)
//      npx tsx src/cli.ts audit mem-3
import fs from "node:fs";
import path from "node:path";
import { loadDotEnv, makeAdapter } from "./config.ts";
import { investigate } from "./agent/investigate.ts";
import { guardSql } from "./agent/guard.ts";
import * as mem from "./agent/memory.ts";

loadDotEnv();
const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.filter((a) => !a.startsWith("--")).join(" ");
const adapter = makeAdapter();
console.error(`adapter: ${adapter.label}`);

if (cmd === "ask") {
  const run = await investigate(adapter, arg, { rediscover: rest.includes("--rediscover"), onEvent: (e) => console.error(`[${e.stage}] ${e.message}`) });
  const dir = path.join(process.cwd(), ".runs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${run.id}.json`), JSON.stringify(run, null, 2));
  console.log(`\n${run.answer}\n\nstatus: ${run.status} | audit: .runs/${run.id}.json`);
} else if (cmd === "sql") {
  const g = guardSql(arg);
  if (g.level === "block") { console.error(`blocked: ${g.reason}`); process.exit(2); }
  const r = await adapter.run(arg, 50);
  console.log(JSON.stringify({ columns: r.columns, rows: r.rows, elapsedMs: r.elapsedMs }, null, 1));
} else if (cmd === "audit") {
  console.log(JSON.stringify(await mem.audit(arg), null, 2));
} else {
  console.log('usage: tsx src/cli.ts ask "<question>" [--rediscover] | sql "<select>" | audit <mem-id>');
}

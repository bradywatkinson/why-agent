// Mint a Zetaris API token (same call the UI makes under Management -> API Tokens)
// and append it to .env. The key is never printed.
//   ZETARIS_USERNAME=admin@zetaris.com ZETARIS_PASSWORD=... npx tsx scripts/zetaris-api-token.ts [days]
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const base = (process.env.ZETARIS_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const { ZETARIS_USERNAME: username, ZETARIS_PASSWORD: password } = process.env;
if (!username || !password) throw new Error("set ZETARIS_USERNAME and ZETARIS_PASSWORD in the environment");
const days = Number(process.argv[2] ?? 30);

const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
const { idToken, orgId } = (await login.json()) as { idToken: string; orgId: number };

const res = await fetch(`${base}/api/proxy/auth/api-key`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}`, "X-Org-ID": String(orgId), "X-Request-ID": randomUUID() },
  body: JSON.stringify({ name: `why-agent-${new Date().toISOString().slice(0, 10)}`, expiryDate: new Date(Date.now() + days * 864e5).toISOString() }),
});
if (!res.ok) throw new Error(`api-key create failed: HTTP ${res.status} (the platform allows at most 3 tokens per user)`);
const { apiKey } = (await res.json()) as { apiKey: string };

const lines = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8").split("\n").filter((l) => l && !/^ZETARIS_(API_KEY|ORG_ID|BASE_URL)=/.test(l)) : [];
lines.push(`ZETARIS_BASE_URL=${base}`, `ZETARIS_ORG_ID=${orgId}`, `ZETARIS_API_KEY=${apiKey}`);
fs.writeFileSync(".env", lines.join("\n") + "\n", { mode: 0o600 });
console.log(`API token created (expires in ${days} days) and written to .env; org ${orgId}.`);

// Live Zetaris adapter. Uses the documented UI-proxy route
// POST {ZETARIS_BASE_URL}/api/proxy/sql-editor/sqls/run-query  { sql, limit }
// with either an API token (Management -> API Tokens) or username/password
// login via /api/auth/login, mirroring zetaris/getting-started scripts/zetaris_api.ts.
// Credentials come only from the environment (.env, gitignored).

import { randomUUID } from "node:crypto";
import { normaliseTable, type SqlAdapter, type SqlResult } from "./types.ts";

export interface ZetarisConfig {
  baseUrl: string;
  orgId: string;
  apiKey?: string;
  username?: string;
  password?: string;
  engineId?: string;
  timeoutMs?: number;
}

export function zetarisConfigFromEnv(env = process.env): ZetarisConfig | null {
  const baseUrl = (env.ZETARIS_BASE_URL ?? "").replace(/\/$/, "");
  if (!baseUrl) return null;
  return {
    baseUrl,
    orgId: env.ZETARIS_ORG_ID ?? "1",
    apiKey: env.ZETARIS_API_KEY || undefined,
    username: env.ZETARIS_USERNAME || undefined,
    password: env.ZETARIS_PASSWORD || undefined,
    engineId: env.ZETARIS_ENGINE_ID || undefined,
    timeoutMs: Number(env.ZETARIS_TIMEOUT_MS ?? 300_000),
  };
}

export class ZetarisAdapter implements SqlAdapter {
  readonly kind = "zetaris" as const;
  readonly dialect = "spark" as const;
  readonly label: string;
  private token?: string;
  private tokenFetchedAt = 0;

  constructor(private cfg: ZetarisConfig) {
    this.label = `zetaris@${cfg.baseUrl}`;
  }

  private async bearer(): Promise<string> {
    if (this.cfg.apiKey) return this.cfg.apiKey;
    // Session tokens from /api/auth/login are short-lived; refresh every 20 min.
    if (this.token && Date.now() - this.tokenFetchedAt < 20 * 60_000) return this.token;
    if (!this.cfg.username || !this.cfg.password) {
      throw new Error("Zetaris: set ZETARIS_API_KEY, or ZETARIS_USERNAME and ZETARIS_PASSWORD, in .env");
    }
    const res = await fetch(`${this.cfg.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": randomUUID() },
      body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Zetaris login failed: HTTP ${res.status}`);
    const login: any = await res.json();
    const tok = login?.idToken ?? login?.token ?? login?.accessToken ??
      JSON.stringify(login).match(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/)?.[0];
    if (typeof tok !== "string" || !tok) throw new Error("Zetaris login did not return an access token");
    this.token = tok;
    this.tokenFetchedAt = Date.now();
    return tok;
  }

  async run(sql: string, limit = 1000): Promise<SqlResult> {
    const started = Date.now();
    const res = await fetch(`${this.cfg.baseUrl}/api/proxy/sql-editor/sqls/run-query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.bearer()}`,
        "X-Org-ID": this.cfg.orgId,
        "X-Request-ID": randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, limit, ...(this.cfg.engineId ? { engineId: this.cfg.engineId } : {}) }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 300_000),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) this.token = undefined;
      throw new Error(`Zetaris run-query HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
    }
    const body = text ? JSON.parse(text) : null;
    if (body && typeof body === "object" && (body.error || body.errorMessage) && !body.data) {
      throw new Error(`Zetaris error: ${String(body.error ?? body.errorMessage).slice(0, 400)}`);
    }
    const table = normaliseTable(body);
    return { ...table, elapsedMs: Date.now() - started, engine: this.label };
  }
}

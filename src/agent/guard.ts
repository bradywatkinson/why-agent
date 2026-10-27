// A minimal implementation of the Meterless Scout Intent *Guard stage*
// (engines/scout-intent/AGENTS.md section 6). Scout ships as a spec without a
// reference implementation, so this file implements the layers this agent
// needs, deterministically and with no model:
//   1. injection check   - known-pattern match, role-confusion markers,
//                          control characters, out-of-band tool references
//   2. policy gate       - this agent's capability set is read-only analytics
//   3. scope check       - SQL must be one read-only statement over allowed DBs
//   4. sensitivity       - PII-looking columns are never selected
// It guards three surfaces: the user's question, every SQL statement the
// planner emits, and every string value that comes back from the data
// (tool-output injection). Payloads are not echoed in full; evidence is a
// short excerpt, as the spec asks.

export type GuardLevel = "low" | "medium" | "high" | "block";
export interface GuardFlag {
  layer: "injection" | "policy" | "scope" | "sensitivity";
  kind: string;
  score: number;
  evidence: string[];
}
export interface GuardVerdict {
  level: GuardLevel;
  flags: GuardFlag[];
  reason?: string;
}

const INJECTION_PATTERNS: [string, RegExp][] = [
  ["instruction-override", /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|the)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|directions?|guidelines?|user|system)\b/i],
  ["instruction-override", /\bignore (all )?previous\b/i],
  ["mode-switch", /\byou are now\b|\bunrestricted mode\b|\bdeveloper mode\b|\bjailbreak\b|\bDAN\b/],
  ["role-confusion", /<\/?\s*(system|user|assistant|developer)\s*>|\[\/?INST\]|<\|im_(start|end)\|>|^\s*(system|assistant)\s*:/im],
  ["role-confusion", /\bpretend (to be|you are)\b[^.\n]{0,30}\b(system|admin|developer|root)\b/i],
  ["secret-exfiltration", /\b(reveal|print|show|dump|leak|exfiltrate|send)\b[^.\n]{0,40}\b(api[ _-]?keys?|credentials?|passwords?|secrets?|tokens?|system prompt)\b/i],
  ["control-characters", /[\u202A-\u202E\u2066-\u2069\u200B-\u200F]|\\u202[a-eA-E]/],
];

// Tools and side effects outside this agent's capability set (read-only
// analytics over Zetaris + memory). Asking for them is an out-of-band tool ref.
const OUT_OF_BAND: [string, RegExp][] = [
  ["out-of-band-tool", /\b\w*(admin_panel|internal_\w+|shell|exec|sudo)\b/i],
  ["privilege-escalation", /\bgrant\b[^.\n]{0,30}\b(admin|access|privileges?|role)\b/i],
  ["side-effect", /\b(e-?mail|send|publish|upload)\b[^.\n]{0,40}\b(every|all|customers?|records?|them|me)\b/i],
  ["destructive", /\b(drop|delete|truncate|alter|insert|update|create|grant|revoke)\b\s+(table|database|from|into|the\b|all\b|\w+\s+table)/i],
];

const PII_COLUMN = /(^|_)(name|first_?name|last_?name|email|phone|address|street|ssn|dob|birth|card_?number|passport)($|_)/i;
const ALLOWED_DATABASES = new Set(["NY_TAXI", "TPCDS_DB"]);

function excerpt(s: string, m: RegExpMatchArray | null): string {
  if (!m || m.index === undefined) return s.slice(0, 40);
  return s.slice(Math.max(0, m.index - 10), m.index + Math.min(m[0].length, 50) + 10).replace(/\s+/g, " ").trim();
}

function aggregate(flags: GuardFlag[]): GuardVerdict {
  if (flags.length === 0) return { level: "low", flags };
  const blocking = flags.filter((f) => f.score >= 0.8);
  if (blocking.length) return { level: "block", flags, reason: `${blocking[0].layer}: ${blocking[0].kind}` };
  return { level: flags.length > 1 ? "high" : "medium", flags };
}

/** Layer 1 + 2 on free text: the user's question, or a value read from the data. */
export function guardText(text: string): GuardVerdict {
  const flags: GuardFlag[] = [];
  for (const [kind, re] of INJECTION_PATTERNS) {
    const m = text.match(re);
    if (m) flags.push({ layer: "injection", kind, score: kind === "control-characters" ? 0.85 : 0.95, evidence: [excerpt(text, m)] });
  }
  for (const [kind, re] of OUT_OF_BAND) {
    const m = text.match(re);
    if (m) flags.push({ layer: "policy", kind, score: 0.9, evidence: [excerpt(text, m)] });
  }
  // Collapse duplicate kinds.
  const seen = new Set<string>();
  return aggregate(flags.filter((f) => (seen.has(f.kind) ? false : (seen.add(f.kind), true))));
}

/** Layer 3 + 4 on every statement the planner emits, before it reaches Zetaris. */
export function guardSql(sql: string): GuardVerdict {
  const flags: GuardFlag[] = [];
  const s = sql.trim().replace(/;\s*$/, "");
  if (s.includes(";")) flags.push({ layer: "scope", kind: "multi-statement", score: 1, evidence: ["';' inside statement"] });
  if (!/^(SELECT|WITH|SHOW|DESCRIBE)\b/i.test(s)) flags.push({ layer: "scope", kind: "not-read-only", score: 1, evidence: [s.slice(0, 30)] });
  const dml = s.match(/\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|REGISTER|REFRESH)\b/i);
  if (dml) flags.push({ layer: "scope", kind: "write-keyword", score: 1, evidence: [dml[0]] });
  for (const m of s.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const db = m[1].toUpperCase();
    if (/^[A-Z]{1,3}$/.test(m[1]) || !/_/.test(m[1])) continue; // table aliases like t.col / z.Borough
    if (!ALLOWED_DATABASES.has(db)) flags.push({ layer: "scope", kind: "database-not-allowed", score: 1, evidence: [m[1]] });
  }
  const selectList = s.match(/^SELECT\s+([\s\S]*?)\s+FROM\s/i)?.[1] ?? "";
  for (const tok of selectList.split(/[^A-Za-z0-9_]+/)) {
    if (tok && PII_COLUMN.test(tok) && !/^(Zone|Borough|service_zone)$/i.test(tok)) {
      flags.push({ layer: "sensitivity", kind: "pii-column", score: 0.9, evidence: [tok] });
    }
  }
  return aggregate(flags);
}

/** Scan string cells from query results; returns redacted rows plus findings. */
export function guardRows(rows: unknown[][]): { rows: unknown[][]; findings: { row: number; col: number; verdict: GuardVerdict }[] } {
  const findings: { row: number; col: number; verdict: GuardVerdict }[] = [];
  const out = rows.map((r, i) =>
    r.map((v, j) => {
      if (typeof v !== "string" || v.length < 12) return v;
      const verdict = guardText(v);
      if (verdict.level === "block") {
        findings.push({ row: i, col: j, verdict });
        return "[redacted by Scout guard: suspected injected instruction]";
      }
      return v;
    })
  );
  return { rows: out, findings };
}

/**
 * Adapter so the official Scout eval runner
 * (engines/scout-intent/evals/runner, SCOUT_IMPL=...) can score this guard.
 * Only the guard stage is implemented, so only injection metrics are meaningful.
 */
export class Scout {
  constructor(_opts?: unknown) {}
  async guard(input: { prompt: string }): Promise<GuardVerdict> {
    return guardText(input.prompt);
  }
  async decide(input: { prompt: string }) {
    const risk = guardText(input.prompt);
    return { risk, candidates: [], toolPlan: [] };
  }
}

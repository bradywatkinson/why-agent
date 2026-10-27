// The "explain why" agent. A deterministic planner turns a question into a
// sequence of guarded Zetaris queries, decomposes the change with a shift-share
// (mix vs within-segment) analysis, and writes an answer in which every claim
// cites the query and the exact rows that support it. Findings are stored in
// Meterless H-MEM so later runs can recall and cross-check them.

import { randomUUID } from "node:crypto";
import type { SqlAdapter } from "../adapters/types.ts";
import { guardRows, guardSql, guardText, type GuardVerdict } from "./guard.ts";
import { parseQuestion, type MetricDef, type PeriodRef } from "./question.ts";
import { describedColumns, rankFactTables, resolveColumns, tableNames, type Logical } from "./schema.ts";
import { quoteLit, sqlDialect } from "./sql.ts";
import * as mem from "./memory.ts";

export interface QueryStep {
  id: string;
  purpose: string;
  sql: string;
  status: "ok" | "error" | "blocked";
  engine?: string;
  elapsedMs?: number;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  sqlGuard: GuardVerdict;
  dataFindings: { row: number; col: number; kinds: string[] }[];
  error?: string;
  at: string;
}

export type Citation = { kind: "query"; queryId: string; rows: number[] } | { kind: "memory"; memoryId: string } | { kind: "reference"; label: string };

export interface Claim {
  id: string;
  kind: "finding" | "driver" | "inference" | "caveat" | "check" | "memory";
  text: string;
  citations: Citation[];
  memoryId?: string;
}

export interface AuditEvent {
  at: string;
  stage: "guard" | "parse" | "memory" | "discover" | "plan" | "query" | "analyze" | "answer" | "error";
  message: string;
  ref?: string;
}

export interface DimensionResult {
  dimension: string;
  label: string;
  queryId: string;
  overallA: number;
  overallB: number;
  delta: number;
  mixTotal: number;
  rateTotal: number;
  reconciles: boolean;
  matchesHeadline: boolean;
  segments: SegmentResult[];
}

export interface SegmentResult {
  segment: string;
  A: { trips: number; weight: number; value: number | null; row?: number };
  B: { trips: number; weight: number; value: number | null; row?: number };
  mix: number;
  rate: number;
  contribution: number;
}

export interface RunRecord {
  id: string;
  question: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "answered" | "blocked" | "unanswerable" | "error";
  adapter: { kind: string; label: string };
  planner: string;
  inputGuard?: GuardVerdict;
  plan?: { metric: MetricDef; metricReason: string; periodA?: string; periodB?: string; granularity?: string; table?: string; columns?: Partial<Record<Logical, string>>; dimensions?: string[]; notes: string[] };
  recalled: { id: string; content: string; relevance: number; source: string }[];
  steps: QueryStep[];
  dimensions: DimensionResult[];
  claims: Claim[];
  answer: string;
  memoriesWritten: string[];
  events: AuditEvent[];
}

const PAYMENT_LABELS: Record<string, string> = { "1": "Credit card", "2": "Cash", "3": "No charge", "4": "Dispute", "5": "Unknown", "6": "Voided trip", "0": "Unspecified" };
const RATECODE_LABELS: Record<string, string> = { "1": "Standard rate", "2": "JFK flat fare", "3": "Newark", "4": "Nassau/Westchester", "5": "Negotiated fare", "6": "Group ride", "99": "Unknown" };
const TLC_DICT = "NYC TLC Yellow Taxi data dictionary (code labels; not queried)";

function caseLabel(expr: string, labels: Record<string, string>): string {
  const whens = Object.entries(labels).map(([k, v]) => `WHEN ${quoteLit(k)} THEN ${quoteLit(v)}`).join(" ");
  return `CASE CAST(${expr} AS STRING) ${whens} ELSE 'Other' END`;
}

export interface InvestigateOptions {
  onEvent?: (e: AuditEvent, run: RunRecord) => void;
  rediscover?: boolean;
  database?: string;
}

export async function investigate(adapter: SqlAdapter, question: string, opts: InvestigateOptions = {}): Promise<RunRecord> {
  const db = opts.database ?? "NY_TAXI";
  const D = sqlDialect(adapter.dialect);
  const str = (c: string) => (adapter.dialect === "spark" ? c : c.replace(/AS STRING\)/g, "AS TEXT)"));
  const run: RunRecord = {
    id: `run-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`,
    question,
    startedAt: new Date().toISOString(),
    status: "running",
    adapter: { kind: adapter.kind, label: adapter.label },
    planner: "deterministic rule-based planner (no LLM)",
    recalled: [],
    steps: [],
    dimensions: [],
    claims: [],
    answer: "",
    memoriesWritten: [],
    events: [],
  };
  const emit = (stage: AuditEvent["stage"], message: string, ref?: string) => {
    const e = { at: new Date().toISOString(), stage, message, ref };
    run.events.push(e);
    opts.onEvent?.(e, run);
  };
  const claim = (kind: Claim["kind"], text: string, citations: Citation[], memoryId?: string) => {
    const c: Claim = { id: `C${run.claims.length + 1}`, kind, text, citations, memoryId };
    run.claims.push(c);
    return c;
  };
  let qn = 0;
  const query = async (purpose: string, sql: string, limit = 1000): Promise<QueryStep> => {
    const id = `Q${++qn}`;
    const g = guardSql(sql);
    const step: QueryStep = { id, purpose, sql, status: "ok", columns: [], rows: [], rowCount: 0, sqlGuard: g, dataFindings: [], at: new Date().toISOString() };
    run.steps.push(step);
    if (g.level === "block") {
      step.status = "blocked";
      step.error = `Scout SQL guard blocked: ${g.reason}`;
      emit("guard", `${id} blocked before reaching ${adapter.kind}: ${g.reason}`, id);
      throw new Error(step.error);
    }
    emit("query", `${id} → ${adapter.kind}: ${purpose}`, id);
    try {
      const res = await adapter.run(sql, limit);
      const scanned = guardRows(res.rows);
      Object.assign(step, { engine: res.engine, elapsedMs: res.elapsedMs, columns: res.columns, rows: scanned.rows, rowCount: res.rows.length });
      step.dataFindings = scanned.findings.map((f) => ({ row: f.row, col: f.col, kinds: f.verdict.flags.map((x) => x.kind) }));
      if (step.dataFindings.length) emit("guard", `${id}: Scout redacted ${step.dataFindings.length} cell(s) that looked like injected instructions`, id);
      emit("query", `${id} ✓ ${res.rows.length} row(s) in ${res.elapsedMs} ms`, id);
      return step;
    } catch (err) {
      step.status = "error";
      step.error = (err as Error).message;
      emit("error", `${id} failed: ${step.error}`, id);
      throw err;
    }
  };

  try {
    // 1. Guard the question (Scout guard stage).
    run.inputGuard = guardText(question);
    emit("guard", `Scout guard on question: ${run.inputGuard.level}${run.inputGuard.flags.length ? " (" + run.inputGuard.flags.map((f) => f.kind).join(", ") + ")" : ""}`);
    if (run.inputGuard.level === "block") {
      run.status = "blocked";
      claim("check", `The question was blocked by the Scout guard (${run.inputGuard.reason}). No query was sent to Zetaris.`, []);
      run.answer = `Blocked: the question looks like a prompt-injection or out-of-scope request (${run.inputGuard.reason}). This agent only runs read-only analytics. [C1]`;
      return run;
    }

    // 2. Parse.
    const parsed = parseQuestion(question);
    run.plan = { metric: parsed.metric, metricReason: parsed.metricReason, notes: [...parsed.notes] };
    emit("parse", `Metric: ${parsed.metric.label} (${parsed.metricReason}). Periods mentioned: ${parsed.periods.map((p) => p.text).join(", ") || "none"}`);

    // 3. Recall related evidence from H-MEM.
    const recalled = await mem.recall(question);
    run.recalled = recalled.memories.map((m: any) => ({ id: m.id, content: m.content, relevance: m.relevance, source: m.source }));
    emit("memory", recalled.memories.length ? `H-MEM recalled ${recalled.memories.length} related memories: ${recalled.memories.map((m: any) => m.id).join(", ")}` : "H-MEM: no related prior findings");

    // 4. Discover schema (or reuse it from memory).
    let fact: string | undefined;
    let cols: ReturnType<typeof resolveColumns> | undefined;
    let schemaCitation: Citation;
    const schemaMem = opts.rediscover ? undefined : await mem.findByKey(`schema:${db}:fact`);
    if (schemaMem?.refs?.length) {
      const saved = JSON.parse(schemaMem.refs.find((r) => r.startsWith("{"))!);
      fact = saved.table;
      cols = resolveColumns(saved.columns);
      schemaCitation = { kind: "memory", memoryId: schemaMem.id };
      emit("discover", `Schema for ${db}.${fact} recalled from ${schemaMem.id} (learned in ${schemaMem.source}); skipping DESCRIBE`, schemaMem.id);
    } else {
      const tables = await query(`List tables in ${db}`, `SHOW LIGHTNING TABLES ${db}`);
      const names = tableNames(tables);
      const candidates = rankFactTables(names);
      emit("discover", `Found ${names.length} tables; fact-table candidates by name: ${candidates.join(", ") || "none"}`, tables.id);
      let describeStep: QueryStep | undefined;
      for (const t of candidates.slice(0, 3)) {
        const d = await query(`Describe candidate fact table ${db}.${t}`, `DESCRIBE DATASOURCE TABLE ${db}.${t}`);
        const r = resolveColumns(describedColumns(d));
        emit("discover", `${t}: ${r.why.join("; ") || "no usable columns"}`, d.id);
        if (r.map.pickup && (r.map.fare || r.map.tip || r.map.distance)) {
          fact = t; cols = r; describeStep = d;
          break;
        }
      }
      if (!fact || !cols || !describeStep) {
        run.status = "unanswerable";
        claim("check", `No table in ${db} has both a pickup timestamp and a fare/tip/distance column, so the question cannot be answered from this source.`, [{ kind: "query", queryId: tables.id, rows: [] }]);
        run.answer = `I could not find a trip table with the columns this analysis needs. [C1]`;
        return run;
      }
      // Zones table for the borough join (federated lookup inside Zetaris).
      const zonesName = names.find((n) => /zone/i.test(n));
      let zones: { table: string; id: string; borough: string } | undefined;
      if (zonesName && cols.map.puLocation) {
        const zd = await query(`Describe lookup table ${db}.${zonesName}`, `DESCRIBE DATASOURCE TABLE ${db}.${zonesName}`);
        const zc = describedColumns(zd);
        const id = zc.find((c) => /locationid/i.test(c));
        const borough = zc.find((c) => /borough/i.test(c));
        if (id && borough) zones = { table: zonesName, id, borough };
      }
      const m = await mem.remember({
        key: `schema:${db}:fact`,
        content: `Zetaris ${db}.${fact} is the trip fact table; columns resolved: ${cols.why.join("; ")}${zones ? `; borough lookup via ${db}.${zones.table}.${zones.borough}` : ""}`,
        runId: run.id,
        queryId: describeStep.id,
        refs: [JSON.stringify({ table: fact, columns: cols.columns, zones })],
        tags: ["schema", db, fact],
        confidence: 0.9,
        layer: "long_term",
      });
      run.memoriesWritten.push(m.id);
      schemaCitation = { kind: "query", queryId: describeStep.id, rows: [] };
      emit("memory", `Stored schema mapping as ${m.id}`, m.id);
    }
    const schemaRec = await mem.findByKey(`schema:${db}:fact`);
    const savedSchema = schemaRec?.refs?.find((r) => r.startsWith("{")) ? JSON.parse(schemaRec.refs.find((r) => r.startsWith("{"))!) : {};
    const zones: { table: string; id: string; borough: string } | undefined = savedSchema.zones;
    const c = cols!.map;
    const T = `${db}.${fact}`;
    run.plan.table = T;
    run.plan.columns = c;

    const metric = parsed.metric;
    const need = [metric.num, metric.den].filter(Boolean) as Logical[];
    const missing = need.filter((l) => !c[l]);
    if (missing.length) {
      run.status = "unanswerable";
      claim("check", `${T} has no column for ${missing.join(", ")}, which ${metric.label} requires.`, [schemaCitation]);
      run.answer = `The data does not contain what is needed to compute ${metric.label}. [C1]`;
      return run;
    }

    // 5. Resolve periods (coverage query only when the question leaves them open).
    let gran: "month" | "year" = parsed.periods[0]?.granularity ?? "month";
    const periodExpr = D.period(`t.${c.pickup}`, gran);
    let A: string | undefined, B: string | undefined;
    const explicit = parsed.periods.filter((p) => p.year !== null);
    if (parsed.periods.length === 2 && explicit.length === 2) {
      [A, B] = parsed.periods.map((p) => p.key).sort();
      emit("plan", `Comparing ${A} → ${B} as stated in the question`);
    } else {
      const cov = await query(`Coverage: trips per ${gran} (to resolve periods)`, `SELECT ${periodExpr} AS period, COUNT(*) AS trips FROM ${T} t GROUP BY ${periodExpr} ORDER BY period`, 5000);
      const series = cov.rows.filter((r) => r[0] != null).map((r) => ({ key: String(r[0]), n: Number(r[1]) }));
      const max = Math.max(0, ...series.map((s) => s.n));
      const solid = series.filter((s) => s.n >= max * 0.1);
      const sparse = series.length - solid.length;
      if (sparse) claim("caveat", `${sparse} ${gran}(s) in ${T} have fewer than 10% of the busiest ${gran}'s trips (likely stray timestamps) and were not used as comparison periods.`, [{ kind: "query", queryId: cov.id, rows: series.map((s, i) => (s.n < max * 0.1 ? i : -1)).filter((i) => i >= 0).slice(0, 20) }]);
      const resolve = (p: PeriodRef) => {
        if (p.year !== null) return p.key;
        const mm = String(p.month).padStart(2, "0");
        return [...solid].reverse().find((s) => s.key.endsWith(`-${mm}`))?.key;
      };
      const keys = parsed.periods.map(resolve).filter(Boolean) as string[];
      if (keys.length >= 2) [A, B] = keys.slice(0, 2).sort();
      else if (keys.length === 1) {
        const i = solid.findIndex((s) => s.key === keys[0]);
        if (i > 0) { A = solid[i - 1].key; B = keys[0]; }
      } else if (solid.length >= 2) { A = solid[solid.length - 2].key; B = solid[solid.length - 1].key; }
      emit("plan", A && B ? `Resolved periods from coverage (${cov.id}): ${A} → ${B}` : "Could not resolve two periods with data", cov.id);
      if (!A || !B) {
        run.status = "unanswerable";
        claim("check", `Could not find two ${gran}s with enough data to compare for the periods in the question.`, [{ kind: "query", queryId: cov.id, rows: [] }]);
        run.answer = `There is not enough data in ${T} for the requested periods. [C1]`;
        return run;
      }
    }
    run.plan.periodA = A; run.plan.periodB = B; run.plan.granularity = gran;

    // 6. Headline + data quality.
    const num = metric.num ? D.num(`t.${c[metric.num]}`) : "1";
    const den = metric.den ? D.num(`t.${c[metric.den]}`) : "1";
    const validParts = [`t.${c.pickup} IS NOT NULL`];
    for (const l of need) validParts.push(`t.${c[l]} IS NOT NULL`, `${D.num(`t.${c[l]}`)} >= 0`, `${D.num(`t.${c[l]}`)} < ${l === "distance" ? 200 : 1000}`);
    if (metric.den === "distance") validParts.push(`${D.num(`t.${c.distance}`)} >= 0.1`);
    if (metric.den === "fare") validParts.push(`${D.num(`t.${c.fare}`)} > 0`);
    const valid = validParts.join(" AND ");
    const inPeriods = `${periodExpr} IN (${quoteLit(A)}, ${quoteLit(B)})`;
    const headline = await query(
      `Headline ${metric.label} for ${A} and ${B}, with data-quality counts`,
      `SELECT ${periodExpr} AS period, COUNT(*) AS trips_all, SUM(CASE WHEN ${valid} THEN 1 ELSE 0 END) AS trips_valid, SUM(CASE WHEN ${valid} THEN ${num} ELSE 0 END) AS num_sum, SUM(CASE WHEN ${valid} THEN ${den} ELSE 0 END) AS den_sum FROM ${T} t WHERE ${inPeriods} GROUP BY ${periodExpr} ORDER BY period`
    );
    const hRow = (k: string) => headline.rows.findIndex((r) => String(r[0]) === k);
    const iA = hRow(A), iB = hRow(B);
    if (iA < 0 || iB < 0) {
      run.status = "unanswerable";
      claim("check", `${T} has no trips in ${iA < 0 ? A : B}.`, [{ kind: "query", queryId: headline.id, rows: [iA, iB].filter((i) => i >= 0) }]);
      run.answer = `No data for ${iA < 0 ? A : B} in ${T}, so the change cannot be explained. [C1]`;
      return run;
    }
    const hv = (i: number) => {
      const r = headline.rows[i].map(Number);
      return { all: r[1], valid: r[2], num: r[3], den: r[4], value: metric.additive ? r[1] : r[3] / (metric.den ? r[4] : r[2]) };
    };
    const hA = hv(iA), hB = hv(iB);
    const delta = hB.value - hA.value;
    const fmt = (v: number) => fmtUnit(metric, v);
    const fmtD = (v: number) => (v >= 0 ? "+" : "−") + fmtUnit(metric, Math.abs(v));
    const pct = hA.value !== 0 ? (delta / Math.abs(hA.value)) * 100 : NaN;
    const headlineClaim = claim("finding",
      `${cap(metric.label)} went from ${fmt(hA.value)} in ${A} to ${fmt(hB.value)} in ${B} (${fmtD(delta)}${isFinite(pct) ? `, ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : ""}), measured over ${hA.valid.toLocaleString()} and ${hB.valid.toLocaleString()} valid trips.`,
      [{ kind: "query", queryId: headline.id, rows: [iA, iB] }]);
    const excludedA = hA.all - hA.valid, excludedB = hB.all - hB.valid;
    if (!metric.additive && (excludedA || excludedB)) {
      claim("caveat", `${(excludedA + excludedB).toLocaleString()} trips (${(((excludedA + excludedB) / (hA.all + hB.all)) * 100).toFixed(2)}%) were excluded as invalid for this metric (missing, negative or implausible ${need.join("/")} values).`, [{ kind: "query", queryId: headline.id, rows: [iA, iB] }]);
    }
    emit("analyze", `Headline: ${fmt(hA.value)} → ${fmt(hB.value)} (${fmtD(delta)})`, headline.id);

    // 7. Cross-run check against memory.
    const findingKey = `finding:${db}:${metric.id}:${A}:${B}`;
    const prior = await mem.findByKey(findingKey);
    if (prior) {
      const prevVals = prior.refs?.find((r) => r.startsWith("{"));
      const pv = prevVals ? JSON.parse(prevVals) : null;
      const same = pv && Math.abs(pv.a - hA.value) < 1e-6 && Math.abs(pv.b - hB.value) < 1e-6;
      claim("memory", same
        ? `This matches what was recorded in ${prior.id} from an earlier run (${prior.source}); the result is reproducible.`
        : `An earlier run recorded different values in ${prior.id} (${pv ? `${fmt(pv.a)} → ${fmt(pv.b)}` : "unparsed"}); the data or engine changed since then. The new result supersedes it.`,
        [{ kind: "memory", memoryId: prior.id }, { kind: "query", queryId: headline.id, rows: [iA, iB] }]);
    }

    // 8. Driver decomposition per dimension.
    const dims: { key: string; label: string; expr: string; join?: string }[] = [];
    if (c.payment) dims.push({ key: "payment", label: "payment type", expr: str(caseLabel(D.int(`t.${c.payment}`), PAYMENT_LABELS)) });
    if (c.ratecode) dims.push({ key: "ratecode", label: "rate code", expr: str(caseLabel(D.int(`t.${c.ratecode}`), RATECODE_LABELS)) });
    if (c.puLocation && zones) dims.push({ key: "borough", label: "pickup borough", expr: `COALESCE(z.${zones.borough}, 'Unknown zone')`, join: `LEFT JOIN ${db}.${zones.table} z ON ${D.int(`t.${c.puLocation}`)} = ${D.int(`z.${zones.id}`)}` });
    if (c.distance && metric.den !== "distance" && metric.num !== "distance") {
      const d = D.num(`t.${c.distance}`);
      dims.push({ key: "distance", label: "trip distance band", expr: `CASE WHEN ${d} < 1 THEN 'a) under 1 mi' WHEN ${d} < 3 THEN 'b) 1–3 mi' WHEN ${d} < 7 THEN 'c) 3–7 mi' WHEN ${d} < 15 THEN 'd) 7–15 mi' ELSE 'e) 15+ mi' END` });
    }
    const h = D.hour(`t.${c.pickup}`);
    dims.push({ key: "hour", label: "time of day", expr: `CASE WHEN ${h} < 6 THEN 'a) overnight 0–5h' WHEN ${h} < 10 THEN 'b) morning 6–9h' WHEN ${h} < 16 THEN 'c) midday 10–15h' WHEN ${h} < 20 THEN 'd) evening 16–19h' ELSE 'e) night 20–23h' END` });
    run.plan.dimensions = dims.map((d) => d.label);
    emit("plan", `Decomposing the change across ${dims.length} dimensions: ${dims.map((d) => d.label).join(", ")}`);

    for (const dim of dims) {
      const step = await query(`Break ${metric.label} down by ${dim.label}`,
        `SELECT ${periodExpr} AS period, ${dim.expr} AS segment, COUNT(*) AS trips, SUM(${num}) AS num_sum, SUM(${den}) AS den_sum FROM ${T} t ${dim.join ?? ""} WHERE ${valid} AND ${inPeriods} GROUP BY ${periodExpr}, ${dim.expr} ORDER BY period, segment`.replace(/\s+/g, " "));
      const res = decompose(step, A, B, metric);
      const dr: DimensionResult = { dimension: dim.key, label: dim.label, queryId: step.id, ...res,
        matchesHeadline: Math.abs(res.overallA - hA.value) <= 1e-6 * Math.max(1, Math.abs(hA.value)) && Math.abs(res.overallB - hB.value) <= 1e-6 * Math.max(1, Math.abs(hB.value)) };
      run.dimensions.push(dr);
      emit("analyze", `${dim.label}: mix ${fmtD(dr.mixTotal)}, within-segment ${fmtD(dr.rateTotal)}; reconciles=${dr.reconciles}, matches headline=${dr.matchesHeadline}`, step.id);
    }

    // 9. Turn the decomposition into cited claims.
    const okDims = run.dimensions.filter((d) => d.reconciles && d.matchesHeadline);
    const bad = run.dimensions.filter((d) => !(d.reconciles && d.matchesHeadline));
    for (const d of bad) claim("check", `The ${d.label} breakdown does not reproduce the headline numbers (${fmt(d.overallA)}/${fmt(d.overallB)}), so it is excluded from the explanation.`, [{ kind: "query", queryId: d.queryId, rows: [] }]);
    if (okDims.length) {
      claim("check", `Self-check: each of ${okDims.length} breakdowns reproduces the headline values and its segment contributions sum exactly to the total change of ${fmtD(delta)}.`, [{ kind: "query", queryId: headline.id, rows: [iA, iB] }, ...okDims.map((d) => ({ kind: "query" as const, queryId: d.queryId, rows: [] }))]);
    }
    const drivers: Claim[] = [];
    if (metric.additive) {
      const all = okDims.flatMap((d) => d.segments.map((s) => ({ d, s }))).sort((x, y) => Math.abs(y.s.contribution) - Math.abs(x.s.contribution));
      for (const { d, s } of pickTop(all, 3)) {
        drivers.push(claim("driver", `${s.segment} (${d.label}): ${s.A.trips.toLocaleString()} → ${s.B.trips.toLocaleString()} trips (${fmtD(s.contribution)}${delta !== 0 ? `, ${share(s.contribution, delta)} of the change` : ""}).`, [cite(d, s)]));
      }
    } else {
      const best = [...okDims].sort((x, y) => Math.abs(y.mixTotal) - Math.abs(x.mixTotal))[0];
      const all = okDims.flatMap((d) => d.segments.map((s) => ({ d, s }))).sort((x, y) => Math.abs(y.s.contribution) - Math.abs(x.s.contribution));
      for (const { d, s } of pickTop(all, 4)) {
        if (Math.abs(s.contribution) < Math.abs(delta) * 0.05) continue;
        const mixLed = Math.abs(s.mix) >= Math.abs(s.rate);
        const text = mixLed
          ? `Mix shift — ${s.segment} (${d.label}) went from ${(s.A.weight * 100).toFixed(1)}% to ${(s.B.weight * 100).toFixed(1)}% of ${metric.den === "fare" ? "fare dollars" : metric.den === "distance" ? "miles" : "trips"}; its ${metric.label} (${s.A.value == null ? "n/a" : fmt(s.A.value)} in ${A}) is ${s.A.value != null && s.A.value > d.overallA ? "above" : "below"} average, so the shift moved the overall by ${fmtD(s.mix)} (total contribution ${fmtD(s.contribution)}).`
          : `Within-segment change — for ${s.segment} (${d.label}) trips, ${metric.label} moved from ${s.A.value == null ? "n/a" : fmt(s.A.value)} to ${s.B.value == null ? "n/a" : fmt(s.B.value)}, contributing ${fmtD(s.rate)} (total contribution ${fmtD(s.contribution)}).`;
        drivers.push(claim("driver", text, [cite(d, s)]));
        const small = Math.min(s.A.trips, s.B.trips);
        if (small < 30) claim("caveat", `${s.segment} has only ${small} trips in one period; treat its effect as noisy.`, [cite(d, s)]);
      }
      if (best && delta !== 0) {
        const mixShare = best.mixTotal / delta;
        const broad = best.segments.filter((s) => s.A.value != null && s.B.value != null && Math.sign(s.B.value - s.A.value) === Math.sign(delta)).reduce((acc, s) => acc + s.B.weight, 0);
        claim("inference",
          Math.abs(mixShare) >= 0.5
            ? `Most of the change is compositional: shifts in ${best.label} mix account for ${fmtD(best.mixTotal)} of the ${fmtD(delta)} change (${share(best.mixTotal, delta)}); within-segment changes account for ${fmtD(best.rateTotal)}.`
            : `Most of the change happened within segments, not through mix: across ${best.label}, mix explains only ${fmtD(best.mixTotal)} (${share(best.mixTotal, delta)}), while segments carrying ${(broad * 100).toFixed(0)}% of the ${B} weight moved in the same direction as the total.`,
          [{ kind: "query", queryId: best.queryId, rows: [] }]);
      }
    }
    if (metric.num === "tip" && c.payment) {
      claim("caveat", "Tip columns in TLC trip records only capture card tips; cash tips are not recorded, so shifts between card and cash payments change measured tips even if riders tip the same.", [{ kind: "reference", label: TLC_DICT }]);
    }
    if (c.payment || c.ratecode) claim("caveat", `Payment-type and rate-code labels come from the ${TLC_DICT}; the codes themselves come from the queried rows.`, [{ kind: "reference", label: TLC_DICT }]);
    claim("caveat", "This is a descriptive decomposition of the queried data, not a causal test; external factors (tariff rules, weather, events) are not in these tables.", []);

    // 10. Remember.
    const fm = await mem.remember({
      key: findingKey,
      content: `${headlineClaim.text} Top drivers: ${drivers.slice(0, 3).map((d) => d.text).join(" | ") || "none above 5% of the change"}`,
      runId: run.id,
      queryId: headline.id,
      refs: [JSON.stringify({ a: hA.value, b: hB.value, sql: mem.sqlHash(headline.sql) }), ...okDims.map((d) => `${run.id}/${d.queryId}`)],
      tags: ["finding", metric.id, A, B, db],
      confidence: okDims.length === run.dimensions.length ? 0.85 : 0.6,
    });
    run.memoriesWritten.push(fm.id);
    headlineClaim.memoryId = fm.id;
    emit("memory", `Stored finding as ${fm.id}${prior ? ` (supersedes ${prior.id})` : ""}`, fm.id);

    // 11. Compose answer.
    const byKind = (k: Claim["kind"]) => run.claims.filter((x) => x.kind === k);
    const lines: string[] = [];
    lines.push(`${headlineClaim.text} [${headlineClaim.id}]`);
    const inf = byKind("inference")[0];
    if (inf) lines.push(`\nWhy: ${inf.text} [${inf.id}]`);
    if (drivers.length) {
      lines.push("\nLargest contributors:");
      for (const d of drivers) lines.push(`• ${d.text} [${d.id}]`);
    }
    const checks = [...byKind("check"), ...byKind("memory")];
    if (checks.length) {
      lines.push("\nChecks:");
      for (const x of checks) lines.push(`• ${x.text} [${x.id}]`);
    }
    const cav = byKind("caveat");
    if (cav.length) {
      lines.push("\nCaveats:");
      for (const x of cav) lines.push(`• ${x.text} [${x.id}]`);
    }
    run.answer = lines.join("\n");
    run.status = "answered";
    emit("answer", `Answered with ${run.claims.length} claims citing ${run.steps.length} Zetaris queries`);
    return run;
  } catch (err) {
    if (run.status === "running") {
      run.status = "error";
      run.answer = `The investigation stopped: ${(err as Error).message}`;
    }
    return run;
  } finally {
    run.finishedAt = new Date().toISOString();
  }
}

function pickTop<T extends { d: { dimension: string } }>(items: T[], n: number): T[] {
  const per = new Map<string, number>();
  const out: T[] = [];
  for (const it of items) {
    const k = it.d.dimension;
    if ((per.get(k) ?? 0) >= 2) continue;
    per.set(k, (per.get(k) ?? 0) + 1);
    out.push(it);
    if (out.length >= n) break;
  }
  return out;
}

function cite(d: DimensionResult, s: SegmentResult): Citation {
  return { kind: "query", queryId: d.queryId, rows: [s.A.row, s.B.row].filter((r): r is number => r !== undefined) };
}

function share(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(0)}%`;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function fmtUnit(metric: MetricDef, v: number): string {
  switch (metric.unit) {
    case "$": return `$${v.toFixed(2)}`;
    case "$/mi": return `$${v.toFixed(2)}/mi`;
    case "%": return `${(v * 100).toFixed(2)}%`;
    case "mi": return `${v.toFixed(2)} mi`;
    case "trips": return `${Math.round(v).toLocaleString()} trips`;
  }
}

/**
 * Shift-share decomposition of a ratio metric R = Σnum/Σden across segments i:
 *   ΔR = Σ_i (wB_i − wA_i)(rA_i − R_A)   [mix]   +   Σ_i wB_i (rB_i − rA_i)   [within-segment]
 * with w = den share. The identity is exact; segments present in only one
 * period take r from the other period so their effect is pure mix.
 * For additive metrics (counts) each segment's contribution is its count delta.
 */
export function decompose(step: QueryStep, A: string, B: string, metric: MetricDef) {
  const segs = new Map<string, SegmentResult>();
  const totals = { A: { num: 0, den: 0, n: 0 }, B: { num: 0, den: 0, n: 0 } };
  step.rows.forEach((r, i) => {
    const p = String(r[0]) === A ? "A" : String(r[0]) === B ? "B" : null;
    if (!p) return;
    const seg = String(r[1] ?? "(null)");
    const trips = Number(r[2]), numv = Number(r[3]), denv = metric.den ? Number(r[4]) : trips;
    const s = segs.get(seg) ?? { segment: seg, A: { trips: 0, weight: 0, value: null }, B: { trips: 0, weight: 0, value: null }, mix: 0, rate: 0, contribution: 0 };
    const side = s[p];
    side.trips = trips; side.row = i;
    (side as any)._num = numv; (side as any)._den = denv;
    side.value = metric.additive ? trips : denv ? numv / denv : null;
    segs.set(seg, s);
    totals[p].num += numv; totals[p].den += denv; totals[p].n += trips;
  });
  const overallA = metric.additive ? totals.A.n : totals.A.num / totals.A.den;
  const overallB = metric.additive ? totals.B.n : totals.B.num / totals.B.den;
  const delta = overallB - overallA;
  let mixTotal = 0, rateTotal = 0;
  for (const s of segs.values()) {
    if (metric.additive) {
      s.contribution = s.B.trips - s.A.trips;
      s.mix = s.contribution; s.rate = 0;
    } else {
      s.A.weight = ((s.A as any)._den ?? 0) / totals.A.den;
      s.B.weight = ((s.B as any)._den ?? 0) / totals.B.den;
      const rA = s.A.value ?? s.B.value ?? 0;
      const rB = s.B.value ?? s.A.value ?? 0;
      s.mix = (s.B.weight - s.A.weight) * (rA - overallA);
      s.rate = s.B.weight * (rB - rA);
      s.contribution = s.mix + s.rate;
    }
    delete (s.A as any)._num; delete (s.A as any)._den; delete (s.B as any)._num; delete (s.B as any)._den;
    mixTotal += s.mix; rateTotal += s.rate;
  }
  const reconciles = Math.abs(mixTotal + rateTotal - delta) <= 1e-9 * Math.max(1, Math.abs(overallA));
  const segments = [...segs.values()].sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
  return { overallA, overallB, delta, mixTotal, rateTotal, reconciles, segments };
}

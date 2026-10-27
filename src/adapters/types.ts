// The one seam between the agent and a SQL engine. The agent never knows
// whether it is talking to a live Zetaris instance or the offline fixture,
// except through `kind`, which is surfaced in every audit record.

export type Dialect = "spark" | "sqlite";

export interface Table {
  columns: string[];
  rows: unknown[][];
}

export interface SqlResult extends Table {
  elapsedMs: number;
  /** Which concrete engine answered, e.g. "zetaris@http://localhost:3000". */
  engine: string;
}

export interface SqlAdapter {
  readonly kind: "zetaris" | "fixture";
  readonly dialect: Dialect;
  readonly label: string;
  run(sql: string, limit?: number): Promise<SqlResult>;
}

/** Normalise the response shapes we have seen (array rows, object rows, column metadata). */
export function normaliseTable(raw: unknown): Table {
  const body: any = raw && typeof raw === "object" && "data" in (raw as any) && !Array.isArray(raw) ? raw : { data: raw };
  let data: any = body.data;
  // Some proxies nest one level deeper: { data: { data: [...], columns: [...] } }.
  if (data && !Array.isArray(data) && typeof data === "object") {
    const inner = data;
    data = inner.data ?? inner.rows ?? inner.records ?? inner.result ?? [];
    body.columns = body.columns ?? inner.columns ?? inner.schema ?? inner.header ?? inner.headers;
  }
  const meta = body.columns ?? body.schema ?? body.header ?? body.headers ?? body.columnNames;
  let columns: string[] = Array.isArray(meta)
    ? meta.map((c: any) => (typeof c === "string" ? c : c?.name ?? c?.columnName ?? c?.label ?? String(c)))
    : [];
  if (!Array.isArray(data)) data = [];
  if (data.length && !Array.isArray(data[0]) && typeof data[0] === "object") {
    if (!columns.length) columns = Object.keys(data[0]);
    return { columns, rows: data.map((r: any) => columns.map((c) => r[c])) };
  }
  if (!columns.length && data.length) columns = (data[0] as unknown[]).map((_, i) => `c${i}`);
  return { columns, rows: data as unknown[][] };
}

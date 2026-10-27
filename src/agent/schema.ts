// Schema discovery and semantic column resolution. The agent does not assume
// a schema: it lists the tables Zetaris exposes, DESCRIBEs candidates, and maps
// physical columns to the logical roles its analyses need. Each mapping
// decision is recorded so a reviewer can see why a column was chosen.

export type Logical = "pickup" | "fare" | "tip" | "total" | "distance" | "payment" | "ratecode" | "puLocation";

const RULES: Record<Logical, RegExp[]> = {
  pickup: [/^tpep_pickup_datetime$/i, /^lpep_pickup_datetime$/i, /pickup.*(datetime|time|date|ts)$/i, /^pickup_?(at|datetime|time)?$/i],
  fare: [/^fare_amount$/i, /^fare$/i, /^base_?fare$/i, /fare/i],
  tip: [/^tip_amount$/i, /^tips?$/i, /tip/i],
  total: [/^total_amount$/i, /^total$/i, /total/i],
  distance: [/^trip_distance$/i, /^distance$/i, /distance|miles/i],
  payment: [/^payment_type$/i, /payment/i],
  ratecode: [/^ratecodeid$/i, /^rate_?code(_?id)?$/i],
  puLocation: [/^pulocationid$/i, /^pickup_?location(_?id)?$/i, /^pu_?location/i],
};

export interface ResolvedColumns {
  columns: string[];
  map: Partial<Record<Logical, string>>;
  why: string[];
}

export function describedColumns(table: { columns: string[]; rows: unknown[][] }): string[] {
  const nameIdx = Math.max(0, table.columns.findIndex((c) => /col(umn)?_?name|^name$|field/i.test(c)));
  const out: string[] = [];
  for (const r of table.rows) {
    const v = r[nameIdx];
    if (typeof v !== "string" || !v.trim() || v.startsWith("#")) continue;
    if (!out.includes(v.trim())) out.push(v.trim());
  }
  return out;
}

export function resolveColumns(cols: string[]): ResolvedColumns {
  const map: Partial<Record<Logical, string>> = {};
  const why: string[] = [];
  const taken = new Set<string>();
  for (const role of Object.keys(RULES) as Logical[]) {
    for (const [i, re] of RULES[role].entries()) {
      const hit = cols.find((c) => re.test(c) && !taken.has(c));
      if (hit) {
        map[role] = hit;
        taken.add(hit);
        why.push(`${role} -> ${hit} (${i === 0 ? "exact TLC name" : "pattern " + re.source})`);
        break;
      }
    }
  }
  return { columns: cols, map, why };
}

export function tableNames(table: { columns: string[]; rows: unknown[][] }): string[] {
  const idx = table.columns.findIndex((c) => /table_?name|^name$|^table$/i.test(c));
  const out: string[] = [];
  for (const r of table.rows) {
    const v = idx >= 0 ? r[idx] : r.find((x) => typeof x === "string" && !/^(true|false)$/i.test(x as string) && !/^NY_TAXI$/i.test(x as string));
    if (typeof v === "string") out.push(v);
  }
  return out;
}

export function rankFactTables(names: string[]): string[] {
  const score = (n: string) => (/yellow/i.test(n) ? 3 : /trip/i.test(n) ? 2 : /taxi|green|fhv/i.test(n) ? 1 : 0) - (/zone|customer|vendor|lookup/i.test(n) ? 5 : 0);
  return names.filter((n) => score(n) > 0).sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

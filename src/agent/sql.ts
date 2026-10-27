// Dialect helpers: the same plan compiles to Spark SQL (Zetaris Lightning)
// or SQLite (offline fixture). Only the handful of functions that differ live here.

import type { Dialect } from "../adapters/types.ts";

export const sqlDialect = (d: Dialect) => ({
  num: (c: string) => (d === "spark" ? `CAST(${c} AS DOUBLE)` : `CAST(${c} AS REAL)`),
  int: (c: string) => `CAST(${c} AS INTEGER)`,
  period: (c: string, g: "month" | "year") =>
    d === "spark"
      ? g === "month" ? `date_format(CAST(${c} AS TIMESTAMP), 'yyyy-MM')` : `date_format(CAST(${c} AS TIMESTAMP), 'yyyy')`
      : g === "month" ? `strftime('%Y-%m', ${c})` : `strftime('%Y', ${c})`,
  hour: (c: string) => (d === "spark" ? `hour(CAST(${c} AS TIMESTAMP))` : `CAST(strftime('%H', ${c}) AS INTEGER)`),
});

export const quoteLit = (s: string) => `'${s.replace(/'/g, "''")}'`;

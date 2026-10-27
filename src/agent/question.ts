// Deterministic question understanding. No LLM: keyword rules map a question
// to a metric and (optionally) two periods. Anything we cannot parse falls
// back to a stated default that is written to the audit trail.

export type MetricId = "avg_fare" | "avg_tip" | "tip_rate" | "avg_total" | "avg_distance" | "fare_per_mile" | "trip_count";

export interface MetricDef {
  id: MetricId;
  label: string;
  unit: "$" | "%" | "mi" | "trips" | "$/mi";
  /** Logical columns needed: numerator / denominator (null = count). */
  num: "fare" | "tip" | "total" | "distance" | null;
  den: "fare" | "distance" | null;
  additive?: boolean;
}

export const METRICS: Record<MetricId, MetricDef> = {
  avg_fare: { id: "avg_fare", label: "average fare per trip", unit: "$", num: "fare", den: null },
  avg_tip: { id: "avg_tip", label: "average tip per trip", unit: "$", num: "tip", den: null },
  tip_rate: { id: "tip_rate", label: "tip rate (tips as % of fares)", unit: "%", num: "tip", den: "fare" },
  avg_total: { id: "avg_total", label: "average total charged per trip", unit: "$", num: "total", den: null },
  avg_distance: { id: "avg_distance", label: "average trip distance", unit: "mi", num: "distance", den: null },
  fare_per_mile: { id: "fare_per_mile", label: "fare per mile", unit: "$/mi", num: "fare", den: "distance" },
  trip_count: { id: "trip_count", label: "number of trips", unit: "trips", num: null, den: null, additive: true },
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export interface PeriodRef {
  granularity: "month" | "year";
  /** "2023-01" or "2023"; month-only refs carry year=null until resolved against coverage. */
  key: string;
  month?: number;
  year: number | null;
  text: string;
}

export interface ParsedQuestion {
  metric: MetricDef;
  metricReason: string;
  periods: PeriodRef[];
  notes: string[];
}

export function parseQuestion(q: string): ParsedQuestion {
  const s = q.toLowerCase();
  const notes: string[] = [];
  let metric: MetricId;
  let metricReason: string;
  if (/tip(ping)?\s*(rate|percent|percentage|%|share)|tips? as a (share|percent)/.test(s)) { metric = "tip_rate"; metricReason = "mentions tip rate/percentage"; }
  else if (/\btips?\b|tipping|gratuit/.test(s)) { metric = "avg_tip"; metricReason = "mentions tips"; }
  else if (/per mile|\/\s*mi\b/.test(s)) { metric = "fare_per_mile"; metricReason = "mentions fare per mile"; }
  else if (/\bfares?\b|price|cost of (a )?(ride|trip)/.test(s)) { metric = "avg_fare"; metricReason = "mentions fares"; }
  else if (/total|spend|revenue per trip|charged/.test(s)) { metric = "avg_total"; metricReason = "mentions total charged"; }
  else if (/distance|trip length|miles|longer|shorter/.test(s)) { metric = "avg_distance"; metricReason = "mentions distance"; }
  else if (/how many|number of|volume|demand|ridership|trip count|\btrips\b|\brides\b/.test(s)) { metric = "trip_count"; metricReason = "mentions trip volume"; }
  else { metric = "avg_fare"; metricReason = "no metric keyword found; defaulted to average fare"; notes.push(metricReason); }

  const periods: PeriodRef[] = [];
  const re = /\b(\d{4})-(\d{2})\b|\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?:\s+(\d{4}))?\b|\b((?:19|20)\d{2})\b/g;
  for (const m of s.matchAll(re)) {
    if (m[1]) periods.push({ granularity: "month", key: `${m[1]}-${m[2]}`, month: Number(m[2]), year: Number(m[1]), text: m[0] });
    else if (m[3]) {
      const mi = MONTHS.indexOf(m[3].slice(0, 3)) + 1;
      const yr = m[4] ? Number(m[4]) : null;
      periods.push({ granularity: "month", key: yr ? `${yr}-${String(mi).padStart(2, "0")}` : `?-${String(mi).padStart(2, "0")}`, month: mi, year: yr, text: m[0] });
    } else if (m[5]) {
      // A bare year right after a month name was consumed above; this is a year period.
      periods.push({ granularity: "year", key: m[5], year: Number(m[5]), text: m[0] });
    }
  }
  // "may" is also an English verb: only keep it if a year or another month is present.
  const cleaned = periods.filter((p) => !(p.text.trim() === "may" && periods.length < 2));
  // Mixed month/year refs ("January 2023" also yields no stray year since it is one match).
  const months = cleaned.filter((p) => p.granularity === "month");
  const chosen = months.length >= 2 ? months.slice(0, 2) : cleaned.filter((p) => p.granularity === "year").length >= 2 ? cleaned.filter((p) => p.granularity === "year").slice(0, 2) : months.slice(0, 1);
  if (chosen.length < 2) notes.push(chosen.length === 1 ? "only one period found; comparing it with the period before it" : "no periods found; comparing the two most recent complete months in the data");
  return { metric: METRICS[metric], metricReason, periods: chosen, notes };
}

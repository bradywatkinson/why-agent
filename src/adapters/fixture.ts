// Offline fixture adapter: an in-memory SQLite (sql.js) database shaped like
// the Zetaris NY_TAXI sample (yellow_taxi + taxi_zones, TLC column names).
// The data is SYNTHETIC, generated from a fixed seed, and exists only so the
// agent and UI can be developed and tested without a running Zetaris
// instance. Every audit record produced with it is labelled "fixture".
// It also answers the Zetaris discovery statements the agent uses
// (SHOW LIGHTNING TABLES / DESCRIBE DATASOURCE TABLE) from SQLite metadata.

import initSqlJs from "sql.js";
import type { SqlAdapter, SqlResult } from "./types.ts";

const ZONES: [number, string, string, string][] = [
  [132, "Queens", "JFK Airport", "Airports"],
  [138, "Queens", "LaGuardia Airport", "Airports"],
  [161, "Manhattan", "Midtown Center", "Yellow Zone"],
  [162, "Manhattan", "Midtown East", "Yellow Zone"],
  [230, "Manhattan", "Times Sq/Theatre District", "Yellow Zone"],
  [236, "Manhattan", "Upper East Side North", "Yellow Zone"],
  [237, "Manhattan", "Upper East Side South", "Yellow Zone"],
  [79, "Manhattan", "East Village", "Yellow Zone"],
  [48, "Manhattan", "Clinton East", "Yellow Zone"],
  [181, "Brooklyn", "Park Slope", "Boro Zone"],
  [7, "Queens", "Astoria", "Boro Zone"],
  [74, "Manhattan", "East Harlem North", "Boro Zone"],
  [42, "Manhattan", "Central Harlem North", "Boro Zone"],
  [244, "Manhattan", "Washington Heights South", "Boro Zone"],
  [65, "Brooklyn", "Downtown Brooklyn/MetroTech", "Boro Zone"],
  [168, "Bronx", "Mott Haven/Port Morris", "Boro Zone"],
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function generate(db: any): void {
  db.run("ATTACH DATABASE ':memory:' AS NY_TAXI");
  db.run(`CREATE TABLE NY_TAXI.taxi_zones (LocationID INTEGER, Borough TEXT, Zone TEXT, service_zone TEXT)`);
  const zs = db.prepare("INSERT INTO NY_TAXI.taxi_zones VALUES (?,?,?,?)");
  for (const z of ZONES) zs.run(z);
  zs.free();
  db.run(`CREATE TABLE NY_TAXI.yellow_taxi (
    VendorID INTEGER, tpep_pickup_datetime TEXT, tpep_dropoff_datetime TEXT, passenger_count INTEGER,
    trip_distance REAL, RatecodeID INTEGER, store_and_fwd_flag TEXT, PULocationID INTEGER, DOLocationID INTEGER,
    payment_type INTEGER, fare_amount REAL, extra REAL, mta_tax REAL, tip_amount REAL, tolls_amount REAL,
    improvement_surcharge REAL, total_amount REAL, congestion_surcharge REAL)`);
  const r = rng(20261027);
  const ins = db.prepare("INSERT INTO NY_TAXI.yellow_taxi VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const months = [["2023-01", 31, 0.06, 0.70], ["2023-02", 28, 0.07, 0.72], ["2023-03", 31, 0.10, 0.78]] as const;
  db.run("BEGIN");
  for (const [ym, days, airportShare, cardShare] of months) {
    for (let i = 0; i < 6000; i++) {
      const day = 1 + Math.floor(r() * days);
      const hour = Math.floor(r() * 24);
      const minute = Math.floor(r() * 60);
      const airport = r() < airportShare;
      const pu = airport ? (r() < 0.6 ? 132 : 138) : ZONES[2 + Math.floor(r() * (ZONES.length - 2))][0];
      const doL = ZONES[2 + Math.floor(r() * (ZONES.length - 2))][0];
      const ratecode = airport && pu === 132 ? 2 : 1;
      const dist = airport ? 9 + r() * 10 : 0.4 + (-Math.log(1 - r()) * 2.4);
      let fare = ratecode === 2 ? 70 : Math.round((3 + dist * 2.6 + r() * 3) * 100) / 100;
      const card = r() < cardShare;
      const payment = card ? 1 : r() < 0.93 ? 2 : r() < 0.5 ? 3 : 4;
      let tip = card ? Math.round(fare * (0.16 + r() * 0.1) * 100) / 100 : 0;
      if (r() < 0.004) { fare = -fare; tip = 0; } // refunds/voids exist in real TLC data too
      const tolls = airport && r() < 0.5 ? 6.55 : 0;
      const congestion = pu !== 132 && pu !== 138 ? 2.5 : 0;
      const total = Math.round((fare + 1 + 0.5 + tip + tolls + 1 + congestion) * 100) / 100;
      const pad = (n: number) => String(n).padStart(2, "0");
      const pick = `${ym}-${pad(day)} ${pad(hour)}:${pad(minute)}:00`;
      const dur = Math.max(3, Math.round(dist * 3.5 + r() * 10));
      const dropMin = hour * 60 + minute + dur;
      const drop = `${ym}-${pad(day)} ${pad(Math.min(23, Math.floor(dropMin / 60)))}:${pad(dropMin % 60)}:00`;
      ins.run([r() < 0.7 ? 2 : 1, pick, drop, 1 + Math.floor(-Math.log(1 - r()) * 0.6), Math.round(dist * 100) / 100,
        ratecode, "N", pu, doL, payment, fare, 1, 0.5, tip, tolls, 1, total, congestion]);
    }
  }
  db.run("COMMIT");
  ins.free();
}

export class FixtureAdapter implements SqlAdapter {
  readonly kind = "fixture" as const;
  readonly dialect = "sqlite" as const;
  readonly label = "fixture:synthetic-NY_TAXI (sql.js)";
  private db: any;

  private async ready(): Promise<any> {
    if (!this.db) {
      const SQL = await initSqlJs();
      this.db = new SQL.Database();
      generate(this.db);
    }
    return this.db;
  }

  async run(sql: string, limit = 1000): Promise<SqlResult> {
    const db = await this.ready();
    const started = Date.now();
    const stmt = sql.trim().replace(/;\s*$/, "");
    let columns: string[] = [];
    let rows: unknown[][] = [];
    let m: RegExpMatchArray | null;
    if (/^SHOW\s+LIGHTNING\s+DATABASES$/i.test(stmt)) {
      columns = ["databaseName"];
      rows = [["NY_TAXI"]];
    } else if ((m = stmt.match(/^SHOW\s+LIGHTNING\s+TABLES\s+(\w+)$/i))) {
      if (m[1].toUpperCase() !== "NY_TAXI") throw new Error(`fixture: unknown database ${m[1]}`);
      const out = db.exec("SELECT name FROM NY_TAXI.sqlite_master WHERE type='table' ORDER BY name");
      columns = ["tableName"];
      rows = out[0]?.values ?? [];
    } else if ((m = stmt.match(/^DESCRIBE\s+DATASOURCE\s+TABLE\s+(\w+)\.(\w+)$/i))) {
      const out = db.exec(`PRAGMA NY_TAXI.table_info(${m[2]})`);
      columns = ["col_name", "data_type"];
      rows = (out[0]?.values ?? []).map((v: unknown[]) => [v[1], String(v[2]).toLowerCase()]);
    } else {
      const out = db.exec(stmt);
      columns = out[0]?.columns ?? [];
      rows = (out[0]?.values ?? []).slice(0, limit);
    }
    return { columns, rows, elapsedMs: Date.now() - started, engine: this.label };
  }
}

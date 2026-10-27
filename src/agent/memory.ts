// Evidence memory on Meterless H-MEM. Every query result the agent relies on
// becomes a sourced memory record (source = run/query id, provenance refs =
// the SQL hash and the cited rows), so later runs can recall prior findings
// and the TrustLedger shows who wrote, read, superseded or rated each one.

import path from "node:path";
import { createHash } from "node:crypto";
import { loadHMEM } from "../engine.ts";

export interface EvidenceMemory {
  id: string;
  content: string;
  confidence: number;
  layer: string;
  source: string;
  tags: string[];
  supersededBy?: string;
  supersedes?: string;
  refs?: string[];
}

let instance: any;

export async function hmem(): Promise<any> {
  if (!instance) {
    const { HMEM } = await loadHMEM();
    const dir = process.env.MEMORY_DIR ?? path.join(process.cwd(), ".memory");
    instance = new HMEM({ persistDir: dir, actor: "why-agent" });
  }
  return instance;
}

export const sqlHash = (sql: string) => createHash("sha256").update(sql).digest("hex").slice(0, 12);

function view(m: any): EvidenceMemory {
  return { id: m.id, content: m.content, confidence: m.confidence, layer: m.layer, source: m.source, tags: m.tags, supersededBy: m.supersededBy, supersedes: m.supersedes, refs: m.provenance?.refs };
}

/** Exact lookup by a structured key tag (latest, non-superseded record). */
export async function findByKey(key: string): Promise<EvidenceMemory | undefined> {
  const h = await hmem();
  const hits = h.store.all().filter((m: any) => m.tags.includes(key) && !m.supersededBy);
  hits.sort((a: any, b: any) => b.timestamp - a.timestamp);
  if (!hits[0]) return undefined;
  // Exact-key reads are reads too: record them on the ledger.
  h.store.touch(hits[0].id);
  h.ledger.log(hits[0].id, "read", "why-agent", { details: { key } });
  return view(hits[0]);
}

/** Fuzzy recall through MemoryRetrievalService (hybrid ranking, ledgered reads). */
export async function recall(question: string, topN = 4) {
  const h = await hmem();
  const res = h.query(question, { threshold: 0.15, topN });
  return { memories: res.memories.map((r: any) => ({ ...view(r.memory), relevance: Number(r.relevance.toFixed(3)) })), trace: res.trace };
}

export async function remember(input: {
  key: string;
  content: string;
  runId: string;
  queryId?: string;
  refs: string[];
  tags?: string[];
  confidence?: number;
  layer?: "working" | "long_term";
}): Promise<EvidenceMemory> {
  const h = await hmem();
  const prior = h.store.all().find((m: any) => m.tags.includes(input.key) && !m.supersededBy);
  const rec = h.add({
    content: input.content,
    type: "factual",
    layer: input.layer ?? "working",
    tags: [input.key, ...(input.tags ?? [])],
    confidence: input.confidence ?? 0.8,
    source: `zetaris:${input.runId}${input.queryId ? "/" + input.queryId : ""}`,
    provenance: { origin: "document", learnedAt: Date.now(), label: "Zetaris query result", refs: input.refs },
    supersedes: prior?.id,
  });
  if (prior) h.store.update(prior.id, { supersededBy: rec.id });
  return view(rec);
}

export async function feedback(ids: string[], kind: "helpful" | "not_helpful" | "wrong") {
  const h = await hmem();
  for (const id of ids) if (h.store.get(id)) h.feedback(id, kind);
}

export async function audit(id: string) {
  const h = await hmem();
  const rec = h.store.get(id);
  return { memory: rec ? view(rec) : null, ledger: h.ledger.history(id) };
}

export async function stats() {
  const h = await hmem();
  return { memories: h.store.all().length, ledger: h.ledger.stats() };
}

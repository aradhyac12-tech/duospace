/**
 * Phase 3D evaluation + performance. Per-dimension results only
 * (docs/eval/phase3d_eval.json); REAL timings in sandbox Node.js, small and
 * large history (docs/eval/phase3d_perf.json). Not a phone.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { createMemory, correctMemory, emptyMemoryState, compareTopics, summarize, validateSummary, selectContext, buildLongitudinalSummary, currency, TOPICS, type MemoryState, type MemoryConsents, type MemoryRecord, type Topic } from "@/lib/relationship/memory";

const DAY = 86_400_000, NOW = Date.parse("2026-09-25T12:00:00Z");
const ALL: MemoryConsents = { store: true, useInAI: true, share: true, longitudinal: true };
let n = 0;
const add = (s: MemoryState, owner: string, topic: Topic, statement: string, ageDays = 1, position: MemoryRecord["position"] = null) =>
  createMemory(s, { ownerUserId: owner, relationshipId: "r", category: "PREFERENCE", topic, statement, position, sourceType: "USER_ENTERED", sourceId: `s${++n}`, sourceTimestamp: new Date(NOW - ageDays * DAY).toISOString() }, { nowMs: NOW - ageDays * DAY, newId: () => `m${++n}`, consentStore: true }).state;
const asShared = (m: MemoryRecord): MemoryRecord => ({ ...m, visibility: "SHARED", status: "SHARED", evidenceLevel: 2 });

type Dim = { pass: number; fail: number; failures: string[] };
const dims: Record<string, Dim> = {};
const rec = (d: string, ok: boolean, why: string) => { dims[d] ??= { pass: 0, fail: 0, failures: [] }; if (ok) dims[d].pass++; else { dims[d].fail++; if (dims[d].failures.length < 8) dims[d].failures.push(why); } };
const BAD = /\b(fight|problem|unhealthy|score|compatib\w*|health|risk|break ?up|avoidant|anxious|toxic|controlling|cares more|loves more)\b/i;

describe("Phase 3D evaluation", () => {
  it("dimensions + performance", async () => {
    let total = 0;
    const values = ["yes", "no", "sometimes", "not_sure"] as const;
    // Comparison correctness across every topic × position pair.
    for (const topic of TOPICS) for (const va of values) for (const vb of values) {
      total++;
      const mine = add(emptyMemoryState(), "a", topic, `A on ${topic}`, 2, { key: "k", value: va }).memories;
      const theirs = add(emptyMemoryState(), "b", topic, `B on ${topic}`, 2, { key: "k", value: vb }).memories.map(asShared);
      const c = compareTopics(mine, theirs, [], "a", "b", NOW)[0];
      const want = va === "not_sure" || vb === "not_sure" ? "UNKNOWN" : va === vb ? "ALIGNED" : "DIFFERENT";
      rec("comparison_correctness", c.status === want && c.negotiable === (want === "DIFFERENT" && (va === "sometimes" || vb === "sometimes")), `${topic} ${va}/${vb} → ${c.status}`);
      rec("no_scoring_or_verdict", !BAD.test(JSON.stringify(c)), `${topic} ${va}/${vb}`);
      rec("partner_attribution", c.mine.every((m) => m.ownerUserId === "a") && c.theirs.every((m) => m.ownerUserId === "b"), topic);
    }
    // Summary grounding over many random histories.
    for (let seed = 0; seed < 60; seed++) {
      total++;
      let s = emptyMemoryState();
      const k = 1 + (seed % 9);
      for (let i = 0; i < k; i++) s = add(s, "a", TOPICS[(seed + i) % 4], `note ${i}`, (seed * 7 + i * 3) % 400);
      if (seed % 3 === 0 && s.memories[0]) s = correctMemory(s, s.memories[0].memoryId, "a", { statement: "changed" }, { nowMs: NOW, newId: () => `m${++n}` }).state;
      const sum = summarize(s, [], { me: "a", partner: "b", consents: ALL, nowMs: NOW, windowDays: 90 });
      const ids = new Set(s.memories.map((m) => m.memoryId));
      rec("grounding", validateSummary(sum, ids).length === 0, `seed ${seed}: ${JSON.stringify(validateSummary(sum, ids))}`);
      rec("no_scoring_or_verdict", !BAD.test(JSON.stringify(sum.sentences)), `seed ${seed}`);
      rec("uncertainty_present", sum.uncertainty.length > 0, `seed ${seed}`);
      const hist = s.memories.filter((m) => m.supersededBy).map((m) => m.memoryId);
      rec("stale_and_corrected_handling", selectContext(s.memories, { consents: ALL, nowMs: NOW }).every((m) => !hist.includes(m.memoryId) && ["CURRENT", "MAY_BE_OUTDATED"].includes(currency(m, NOW))), `seed ${seed}`);
    }
    // Privacy: unshared partner memories never used.
    for (const topic of TOPICS) {
      total++;
      const mine = add(emptyMemoryState(), "a", topic, "mine").memories;
      const priv = add(emptyMemoryState(), "b", topic, "their private note").memories; // PRIVATE
      rec("privacy", compareTopics(mine, priv, [], "a", "b", NOW)[0].theirs.length === 0, topic);
    }

    // Performance: small (10) vs large (5000) histories.
    const build = (count: number) => { let s = emptyMemoryState(); for (let i = 0; i < count; i++) s = add(s, "a", TOPICS[i % TOPICS.length], `m${i}`, i % 300, { key: `k${i % 5}`, value: values[i % 4] }); return s; };
    const perf: Record<string, unknown> = {};
    for (const [label, count] of [["small_history_10", 10], ["large_history_5000", 5000]] as const) {
      const s = build(count);
      const partner = s.memories.slice(0, Math.min(200, count)).map((m) => asShared({ ...m, ownerUserId: "b" }));
      const time = async (f: () => unknown | Promise<unknown>, runs: number) => { const xs: number[] = []; for (let i = 0; i < runs; i++) { const t = performance.now(); await f(); xs.push(performance.now() - t); } const first = xs[0]; xs.sort((x, y) => x - y); return { firstMs: +first.toFixed(3), minMs: +xs[0].toFixed(3), p50Ms: +xs[Math.floor(xs.length * 0.5)].toFixed(3), p95Ms: +xs[Math.floor(xs.length * 0.95)].toFixed(3) }; };
      perf[label] = {
        records: count,
        retrieval_selectContext: await time(() => selectContext(s.memories, { consents: ALL, nowMs: NOW, topic: "planning" }), 50),
        summary_rule: await time(() => buildLongitudinalSummary(s, partner, { me: "a", partner: "b", consents: ALL, nowMs: NOW, windowDays: 90 }), 30),
        storageBytesJson: Buffer.byteLength(JSON.stringify(s)),
      };
    }
    perf.environment = `sandbox Node.js ${process.version} — NOT a phone; device performance NOT MEASURED`;
    perf.heapUsedMB = +(process.memoryUsage().heapUsed / 1e6).toFixed(1);
    perf.local_model = "NOT MEASURED — no real local model (Phase 2D BLOCKED)";
    mkdirSync("docs/eval", { recursive: true });
    writeFileSync("docs/eval/phase3d_perf.json", JSON.stringify(perf, null, 2) + "\n");
    writeFileSync("docs/eval/phase3d_eval.json", JSON.stringify({ phase: "3D", totalCases: total, note: "Synthetic, deterministic. Per-dimension only; no overall score. Summary 'accuracy' here = grounding against records, not human-judged usefulness.", dimensions: dims }, null, 2) + "\n");
    for (const d of Object.keys(dims)) expect(dims[d].fail, `${d}: ${dims[d].failures.join(" | ")}`).toBe(0);
  }, 180_000);
});

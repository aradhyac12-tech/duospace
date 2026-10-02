#!/usr/bin/env node
/**
 * Phase 3H — reproducible local-model artifact acquisition (NOT integration).
 *
 * Resolves a revision to its full immutable commit hash, downloads exactly
 * the files listed in src/lib/relationship/localModel/manifest.ts, computes
 * SHA-256 + byte size LOCALLY, compares LFS files against the hash Hugging
 * Face publishes for that commit, and writes:
 *   - models/<repo>@<commit>/...        (the files; git-ignored, not committed)
 *   - docs/eval/phase3h_model_artifact.json  (what was verified)
 *   - a manifest snippet printed to stdout (paste into manifest.ts only after review)
 *
 * Usage: node scripts/verify/fetch-local-model.mjs [repo] [revision]
 *   default repo:     HuggingFaceTB/SmolLM2-360M-Instruct
 *   default revision: 028493f   (commit that added onnx/ weights, 2024-10-31)
 * Nothing here enables LOCAL mode; the manifest stays unpinned until a human
 * reviews the output and a device runtime test passes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, createWriteStream, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const repo = process.argv[2] ?? "HuggingFaceTB/SmolLM2-360M-Instruct";
const rev = process.argv[3] ?? "028493f";
const FILES = ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_q4.onnx"];
const HF = "https://huggingface.co";

async function json(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }

async function main() {
  const info = await json(`${HF}/api/models/${repo}/revision/${rev}`);
  const commit = info.sha;
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`could not resolve ${rev} to a full commit hash`);
  const dirs = [...new Set(FILES.map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "")))];
  const published = new Map();
  for (const d of dirs) {
    const entries = await json(`${HF}/api/models/${repo}/tree/${commit}${d ? "/" + d : ""}`);
    for (const e of entries) if (e.type === "file") published.set(e.path, { size: e.size, lfsSha256: e.lfs?.oid ?? e.lfs?.sha256 ?? null });
  }
  const outDir = join("models", `${repo.replace("/", "__")}@${commit}`);
  const files = [];
  for (const f of FILES) {
    const pub = published.get(f);
    if (!pub) throw new Error(`${f} is not present at commit ${commit}`);
    const dest = join(outDir, f);
    mkdirSync(dirname(dest), { recursive: true });
    const r = await fetch(`${HF}/${repo}/resolve/${commit}/${f}`);
    if (!r.ok || !r.body) throw new Error(`download ${f}: ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
    const sha256 = createHash("sha256").update(readFileSync(dest)).digest("hex");
    const bytes = statSync(dest).size;
    const sizeOk = bytes === pub.size;
    const hashOk = pub.lfsSha256 ? sha256 === pub.lfsSha256 : null; // small non-LFS files have no published sha256
    files.push({ path: f, bytes, sha256, publishedSize: pub.size, publishedLfsSha256: pub.lfsSha256, sizeMatches: sizeOk, hashMatchesPublished: hashOk });
    console.log(`${sizeOk && hashOk !== false ? "OK  " : "BAD "} ${f}  ${bytes} B  ${sha256}${hashOk === null ? "  (no published hash: non-LFS file)" : hashOk ? "  = published" : "  != published " + pub.lfsSha256}`);
  }
  const allOk = files.every((x) => x.sizeMatches && x.hashMatchesPublished !== false);
  const report = { phase: "3H", ranAt: new Date().toISOString(), repo, requestedRevision: rev, commit, files, allOk, note: "Artifact acquisition only. Local AI remains NOT VERIFIED until a device runtime test passes." };
  mkdirSync("docs/eval", { recursive: true });
  writeFileSync("docs/eval/phase3h_model_artifact.json", JSON.stringify(report, null, 2) + "\n");
  console.log(`\n${allOk ? "ALL FILES VERIFIED" : "VERIFICATION FAILED — do not pin"}. Report: docs/eval/phase3h_model_artifact.json`);
  if (allOk) {
    console.log("\nManifest snippet (review before pasting into src/lib/relationship/localModel/manifest.ts):");
    console.log(`  modelVersion: "local-model-v1/smollm2-360m-instruct-q4@${commit.slice(0, 12)}",\n  tokenizerVersion: "${commit}",\n  files: [\n${files.map((x) => `    { path: "${x.path}", sha256: "${x.sha256}", bytes: ${x.bytes} },`).join("\n")}\n  ],`);
  }
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

/**
 * REMEDIATION P0-2: every call_history INSERT must set `provider`
 * explicitly — the column defaults to 'daily'
 * (20260916130000_call_history_provider_column.sql), so an insert that
 * omits it is silently mis-recorded regardless of which engine actually
 * handled the call, corrupting the provider-comparison telemetry that
 * column exists for. This exact bug shipped in both Calls.tsx and
 * Chat.tsx's outgoing-call paths (both the Daily branch AND the
 * self_hosted branch added later) and went unnoticed until an explicit
 * audit found it.
 *
 * This is a SOURCE-LEVEL invariant check, not a behavioral unit test —
 * Calls.tsx's and Chat.tsx's `call_history` inserts live inside deeply
 * nested closures in large page components with no seam to unit-test
 * directly without a full React render harness this repo doesn't have
 * set up for these files. A static check that every
 * `call_history").insert({...})` call site's payload includes a
 * `provider:` key is a real, cheap guardrail against this exact
 * regression class recurring — it will not catch a WRONG provider
 * value, only a missing one, which is what actually happened here.
 */
function insertBlocksWithoutProviderField(source: string): string[] {
  const missing: string[] = [];
  const callSites = source.matchAll(/call_history"\)\.insert\(\{/g);
  for (const match of callSites) {
    const start = match.index ?? 0;
    // The object literal closes at the first `} as` cast in this codebase's
    // convention (every call_history insert here is immediately cast
    // `as never`/`as any`) — scanning ahead to that is simpler and more
    // robust than a full brace-matching parser for this narrow check.
    const closeIdx = source.indexOf("} as ", start);
    const block = closeIdx === -1 ? source.slice(start, start + 400) : source.slice(start, closeIdx);
    if (!/\bprovider\s*:/.test(block)) {
      const line = source.slice(0, start).split("\n").length;
      missing.push(`line ${line}`);
    }
  }
  return missing;
}

describe("call_history insert provider field (P0-2 regression guard)", () => {
  it.each(["src/pages/Calls.tsx", "src/pages/Chat.tsx"])("%s: every call_history insert sets provider explicitly", (relPath) => {
    const source = readFileSync(resolve(REPO_ROOT, relPath), "utf-8");
    const callSiteCount = [...source.matchAll(/call_history"\)\.insert\(\{/g)].length;
    // Guards the guard: if this ever drops to 0, the regex above stopped
    // matching (e.g. the insert call's formatting changed) and this test
    // would be silently vacuous — fail loudly instead.
    expect(callSiteCount).toBeGreaterThan(0);
    expect(insertBlocksWithoutProviderField(source)).toEqual([]);
  });
});

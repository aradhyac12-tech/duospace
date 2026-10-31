/**
 * Guard for DS-UNKNOWN-001: every LOCAL postgres_changes channel must get a unique topic
 * (uniqueChannelName), otherwise supabase-js can hand back a still-subscribed channel on an
 * effect re-run and `.on()` throws. Broadcast / presence / private channels are exempt:
 * their topic must be identical on both phones.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { uniqueChannelName } from "@/lib/realtimeChannel";

const SRC = join(__dirname, "..");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  if (statSync(p).isDirectory()) return n === "test" || n === "node_modules" ? [] : walk(p);
  return /\.(ts|tsx)$/.test(n) ? [p] : [];
});

describe("realtime channel naming", () => {
  it("uniqueChannelName never repeats", () => {
    const names = Array.from({ length: 500 }, () => uniqueChannelName("x"));
    expect(new Set(names).size).toBe(500);
    expect(names[0].startsWith("x#")).toBe(true);
  });

  it("every postgres_changes-only channel uses uniqueChannelName", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const src = readFileSync(f, "utf8");
      let i = -1;
      while ((i = src.indexOf(".channel(", i + 1)) !== -1) {
        const end = src.indexOf(".subscribe(", i);
        const chain = src.slice(i, end === -1 ? i + 1500 : end);
        const shared = /"broadcast"|'broadcast'|presence|private:\s*true/.test(chain) || /^\.channel\(\s*(channelName|name)\b/.test(chain);
        if (shared || !/"postgres_changes"/.test(chain)) continue;
        if (!/^\.channel\(\s*uniqueChannelName\(/.test(chain)) offenders.push(`${f.slice(SRC.length + 1)}: ${chain.slice(0, 70).replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

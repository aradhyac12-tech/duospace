import { describe, it, expect } from "vitest";
import { providerCapabilityNote, providerLabelWithCapability } from "@/lib/music/providerCapability";
import { isNativelyStreamable } from "@/lib/music/types";

describe("provider capability wording", () => {
  it("never promises background playback for YouTube", () => {
    expect(providerCapabilityNote("youtube")).toMatch(/app only/);
    expect(providerCapabilityNote("youtube")).not.toMatch(/can keep playing/);
  });
  it("agrees with isNativelyStreamable: native providers say background-capable, others do not", () => {
    for (const provider of ["soundcloud", "audius", "jamendo", "local", "youtube"] as const) {
      const native = isNativelyStreamable({ provider, isStreamable: true });
      expect(/can keep playing/.test(providerCapabilityNote(provider))).toBe(native);
    }
  });
  it("unknown provider gets no capability claim", () => {
    expect(providerCapabilityNote("mystery")).toBe("");
    expect(providerLabelWithCapability("mystery", "Mystery")).toBe("Mystery");
    expect(providerLabelWithCapability("audius", "Audius")).toBe("Audius — can keep playing when the screen is locked");
  });
});

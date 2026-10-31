import { describe, it, expect } from "vitest";
import { buildLetterContent, parseLetterContent, DEFAULT_LETTER_SUBJECT } from "@/lib/letter";

describe("letter wire format", () => {
  it("round-trips subject and body", () => {
    const wire = buildLetterContent("Happy anniversary", "Dear you,\n\nI love you.");
    expect(wire).toBe("💌 **Happy anniversary**\n\nDear you,\n\nI love you.");
    expect(parseLetterContent(wire)).toEqual({
      subject: "Happy anniversary",
      body: "Dear you,\n\nI love you.",
    });
  });

  it("falls back to the default subject when blank", () => {
    const wire = buildLetterContent("   ", "hi");
    expect(parseLetterContent(wire).subject).toBe(DEFAULT_LETTER_SUBJECT);
  });

  it("parses letters already sent by the old composer (subject kept verbatim)", () => {
    const old = "💌 **A letter for you 💌**\n\nline one\nline two";
    expect(parseLetterContent(old)).toEqual({
      subject: "A letter for you 💌",
      body: "line one\nline two",
    });
  });

  it("keeps the body's own blank lines and leading spaces intact", () => {
    const { body } = parseLetterContent(buildLetterContent("S", "a\n\n  b\n\nc"));
    expect(body).toBe("a\n\n  b\n\nc");
  });

  it("degrades gracefully on content without a header", () => {
    expect(parseLetterContent("just some text")).toEqual({
      subject: DEFAULT_LETTER_SUBJECT,
      body: "just some text",
    });
  });
});

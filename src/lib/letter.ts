/**
 * Love-letter wire format.
 *
 * A letter is an ordinary `messages` row with `message_type = "letter"` whose
 * (E2E-encrypted) content is `💌 **<subject>**\n\n<body>`. Keeping the format
 * unchanged means no migration, no encryption change and every letter already
 * sent keeps rendering. This module is the ONE place that builds and parses it
 * — the composer, the chat bubble and the reader all go through here.
 */

export const DEFAULT_LETTER_SUBJECT = "A letter for you 💌";

export interface ParsedLetter {
  subject: string;
  body: string;
}

export function buildLetterContent(subject: string, body: string): string {
  const s = subject.trim() || DEFAULT_LETTER_SUBJECT;
  return `💌 **${s}**\n\n${body}`;
}

// Optional leading 💌, then **subject** on the first line.
const HEADER_RE = /^\s*(?:💌\s*)?\*\*(.+?)\*\*[ \t]*(?:\r?\n|$)/;

export function parseLetterContent(content: string): ParsedLetter {
  const m = HEADER_RE.exec(content);
  if (!m) {
    return {
      subject: DEFAULT_LETTER_SUBJECT,
      body: content.replace(/^\s*💌\s*/, "").trim(),
    };
  }
  return {
    subject: m[1].trim() || DEFAULT_LETTER_SUBJECT,
    body: content.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd(),
  };
}

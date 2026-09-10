// Local, zero-dependency password strength heuristic — matches this app's
// established preference for small local scoring over pulling in a library
// (see e.g. lib/surpriseHaptics.ts's own regex/heuristic content analyzer).
// Not a substitute for the actual policy check (Auth.tsx/ResetPassword.tsx
// still separately enforce "8+ chars, letter + number" before submit) —
// this is purely the visual strength meter shown while typing.

export type PasswordStrengthLevel = "empty" | "weak" | "fair" | "good" | "strong";

export interface PasswordStrengthResult {
  score: number; // 0-4
  level: PasswordStrengthLevel;
  label: string;
}

const COMMON_WEAK_PATTERNS = [
  /^password/i, /^qwerty/i, /^letmein/i, /^welcome/i, /^admin/i, /^iloveyou/i,
  /^12345/, /^00000/, /(.)\1{2,}/, // 3+ repeated same character in a row
];

const isSequential = (s: string): boolean => {
  const lower = s.toLowerCase();
  const seqs = ["abcdefghijklmnopqrstuvwxyz", "0123456789"];
  for (const seq of seqs) {
    for (let i = 0; i <= seq.length - 4; i++) {
      if (lower.includes(seq.slice(i, i + 4))) return true;
    }
  }
  return false;
};

export function scorePasswordStrength(password: string): PasswordStrengthResult {
  if (!password) return { score: 0, level: "empty", label: "" };

  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;

  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const varietyCount = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
  if (varietyCount >= 3) score++;
  if (varietyCount === 4) score++;

  const looksWeak = COMMON_WEAK_PATTERNS.some((p) => p.test(password)) || isSequential(password);
  if (looksWeak) score = Math.max(0, score - 2);

  score = Math.min(4, Math.max(0, score));

  const levels: { level: PasswordStrengthLevel; label: string }[] = [
    { level: "weak", label: "Weak" },
    { level: "weak", label: "Weak" },
    { level: "fair", label: "Fair" },
    { level: "good", label: "Good" },
    { level: "strong", label: "Strong" },
  ];
  return { score, ...levels[score] };
}

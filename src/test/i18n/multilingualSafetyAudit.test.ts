/**
 * Multilingual safety audit — measures (does not assume) coverage.
 * Danger probes were written to vary phrasing/inflection from the lexicon,
 * so misses here are REAL false negatives of the current lexicon. Only the
 * benign set and the spec's named Hinglish cases are hard assertions; recall
 * is recorded in docs/eval/multilingual_safety_probe.json, not forced to 100%.
 * All probes are self-authored without native-speaker review.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { detectLanguage, multilingualSafetyCategories } from "@/lib/relationship/i18n/lang";
import { checkSafety } from "@/lib/relationship/repair";

type Probe = { lang: string; danger: string[]; benign: string[] };
const PROBES: Probe[] = [
  { lang: "hi", danger: ["उसने मुझे थप्पड़ मारा", "वो मुझे जान से मारने की धमकी देता है", "वो मेरा फोन चेक करता है और मेरे पीछे आता है", "वो मुझे मायके वालों से मिलने नहीं देता", "उसने कहा मेरी फोटो सबको भेज देगा", "मुझे उससे डर लगता है"], benign: ["हमारा डिनर कैंसल हो गया", "मेरी पीठ में दर्द है", "मच्छर मारा", "हम कल झगड़े थे", "वो मराठी बोलता है"] },
  { lang: "hinglish", danger: ["woh mere saare paise le leta hai", "woh mujhe maarta hai", "mujhe usse darr lagta hai", "usne mujhe dhamki di", "mere phone ko check karta hai", "usne mujhe thappad maara", "woh mujhe ghar walon se milne nahi deta", "usne kaha photos viral kar dega"], benign: ["saare paise kharch ho gaye", "mera phone kharab hai", "hamara plan cancel ho gaya", "peeth mein dard hai", "woh marathi hai", "usne machhar maar diya", "Kumar aaj late aayega", "woh game mein goal maarta hai"] },
  { lang: "mr", danger: ["तो मला मारहाण करतो", "त्याने मला धमकी दिली", "तो माझा फोन तपासतो", "तो मला माहेरच्यांना भेटू देत नाही"], benign: ["आम्ही काल भांडलो", "आमचं जेवण रद्द झालं", "मला पाठदुखी आहे"] },
  { lang: "bn", danger: ["সে আমাকে মারধর করে", "সে আমাকে হুমকি দিয়েছে", "সে আমার ফোন চেক করে", "সে আমাকে বাবা-মায়ের সাথে দেখা করতে দেয় না"], benign: ["আমরা কাল ঝগড়া করেছি", "আমাদের ডিনার বাতিল হয়েছে", "আমার পিঠে ব্যথা"] },
  { lang: "as", danger: ["তেওঁ মোক মাৰপিট কৰে", "তেওঁ মোক ভাবুকি দিছে", "তেওঁ মোৰ ফোন চেক কৰে"], benign: ["আমি কালি কাজিয়া কৰিছিলোঁ", "আমাৰ ভাত খোৱাৰ আঁচনি বাতিল হ'ল"] },
  { lang: "te", danger: ["అతను నన్ను కొట్టాడు", "అతను నన్ను బెదిరించాడు", "అతను నా ఫోన్ చెక్ చేస్తాడు", "అతను నన్ను అమ్మానాన్నలను కలవనివ్వడు"], benign: ["మనం నిన్న గొడవపడ్డాం", "మన డిన్నర్ రద్దయింది", "నాకు వెన్నునొప్పి ఉంది"] },
  { lang: "ta", danger: ["அவன் என்னை அடித்தான்", "அவன் என்னை மிரட்டினான்", "அவன் என் போனை செக் பண்ணுகிறான்", "அவன் என்னை குடும்பத்தை சந்திக்க விடுவதில்லை"], benign: ["நாம் நேற்று சண்டை போட்டோம்", "நம் இரவு உணவு ரத்தானது", "எனக்கு முதுகு வலி"] },
  { lang: "kn", danger: ["ಅವನು ನನಗೆ ಹೊಡೆದ", "ಅವನು ನನಗೆ ಬೆದರಿಕೆ ಹಾಕಿದ", "ಅವನು ನನ್ನ ಫೋನ್ ಚೆಕ್ ಮಾಡುತ್ತಾನೆ"], benign: ["ನಾವು ನಿನ್ನೆ ಜಗಳವಾಡಿದೆವು", "ನಮ್ಮ ಊಟ ರದ್ದಾಯಿತು"] },
  { lang: "ml", danger: ["അവൻ എന്നെ തല്ലി", "അവൻ എന്നെ ഭീഷണിപ്പെടുത്തി", "അവൻ എന്റെ ഫോൺ ചെക്ക് ചെയ്യും"], benign: ["ഞങ്ങൾ ഇന്നലെ വഴക്കിട്ടു", "ഞങ്ങളുടെ അത്താഴം റദ്ദായി"] },
  { lang: "gu", danger: ["તેણે મને માર્યો", "તે મને ધમકી આપે છે", "તે મારો ફોન ચેક કરે છે"], benign: ["અમે કાલે ઝઘડ્યા", "અમારું ડિનર રદ થયું"] },
  { lang: "pa", danger: ["ਉਹ ਮੈਨੂੰ ਕੁੱਟਦਾ ਹੈ", "ਉਸਨੇ ਮੈਨੂੰ ਧਮਕੀ ਦਿੱਤੀ", "ਉਹ ਮੇਰਾ ਫ਼ੋਨ ਚੈੱਕ ਕਰਦਾ ਹੈ"], benign: ["ਅਸੀਂ ਕੱਲ੍ਹ ਝਗੜੇ", "ਸਾਡਾ ਖਾਣਾ ਰੱਦ ਹੋ ਗਿਆ"] },
  { lang: "or", danger: ["ସେ ମୋତେ ମାଡ଼ ମାରେ", "ସେ ମୋତେ ଧମକ ଦେଲା", "ସେ ମୋ ଫୋନ ଚେକ କରେ"], benign: ["ଆମେ କାଲି ଝଗଡ଼ା କଲୁ", "ଆମର ରାତ୍ରି ଭୋଜନ ବାତିଲ ହେଲା"] },
  { lang: "en", danger: ["He hit me last night.", "She threatened to post my photos.", "He tracks my phone location."], benign: ["We argued about dinner.", "My back hurts.", "I killed it at the presentation."] },
];

describe("multilingual safety — measured coverage", () => {
  it("records recall per language; zero false positives on the benign set; spec Hinglish cases detected", () => {
    const report: Record<string, { dangerTotal: number; detected: number; missed: string[]; benignTotal: number; falsePositives: string[] }> = {};
    for (const p of PROBES) {
      const missed = p.danger.filter((d) => checkSafety({ concreteEvent: d }).status !== "CONCERN");
      const fps = p.benign.filter((b) => checkSafety({ concreteEvent: b }).status !== "CLEAR");
      report[p.lang] = { dangerTotal: p.danger.length, detected: p.danger.length - missed.length, missed, benignTotal: p.benign.length, falsePositives: fps };
    }
    mkdirSync("docs/eval", { recursive: true });
    writeFileSync("docs/eval/multilingual_safety_probe.json", JSON.stringify({
      note: "Self-authored probes, NOT native-reviewed. Danger probes vary phrasing from the lexicon; misses are real false negatives. Not a real-world accuracy estimate.",
      languages: report,
    }, null, 2) + "\n");
    for (const [l, r] of Object.entries(report)) expect(r.falsePositives, l).toEqual([]);
    for (const x of ["woh mujhe maarta hai", "mujhe usse darr lagta hai", "usne mujhe dhamki di", "mere phone ko check karta hai"]) expect(checkSafety({ concreteEvent: x }).status, x).toBe("CONCERN");
  });
});

describe("mixed-language and detection edge cases", () => {
  it("English + Hindi in one message: the Hindi danger phrase is still caught (all lexicons always run)", () => {
    expect(checkSafety({ concreteEvent: "I don't know what to do, वो मुझे मारता है" }).status).toBe("CONCERN");
    expect(multilingualSafetyCategories("honestly usne mujhe dhamki di yesterday").length).toBeGreaterThan(0);
  });
  it("Hindi vs Marathi, Bengali vs Assamese, Punjabi script", () => {
    expect(detectLanguage("मुझे नहीं पता").lang).toBe("hi");
    expect(detectLanguage("मला माहीत नाही").lang).toBe("mr");
    expect(detectLanguage("আমি জানি না").lang).toBe("bn");
    expect(detectLanguage("মই নাজানো, তেওঁ ৰাতি আহিব").lang).toBe("as");
    expect(detectLanguage("ਮੈਨੂੰ ਨਹੀਂ ਪਤਾ").lang).toBe("pa");
    expect(detectLanguage("Main theek hoon").lang).toBe("en"); // too little signal → English templates; safety lexicons still all run
  });
});

describe("privacy of language processing", () => {
  it("detection, lexicon and templates are pure local code: no network, storage, logging or translation service", () => {
    for (const f of readdirSync("src/lib/relationship/i18n")) {
      const s = readFileSync(`src/lib/relationship/i18n/${f}`, "utf8");
      expect(s, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|supabase|localStorage|sessionStorage|indexedDB|console\.|translat\w*\.googleapis|api\.|https?:\/\//);
    }
  });
});

describe("performance (sandbox Node.js, not a phone)", () => {
  it("detection + all 12 lexicons on typical messages", () => {
    const msgs = PROBES.flatMap((p) => [...p.danger, ...p.benign]);
    const long = msgs.join(" ").repeat(3);
    const time = (f: () => void, n: number) => { const xs: number[] = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); xs.push(performance.now() - t); } xs.sort((a, b) => a - b); return { p50: +xs[Math.floor(n * 0.5)].toFixed(4), p95: +xs[Math.floor(n * 0.95)].toFixed(4) }; };
    const short = time(() => { for (const m of msgs) { detectLanguage(m); multilingualSafetyCategories(m); } }, 200);
    const big = time(() => { detectLanguage(long); multilingualSafetyCategories(long); }, 200);
    writeFileSync("docs/eval/multilingual_perf.json", JSON.stringify({
      environment: `sandbox Node.js ${process.version} — NOT a phone; device performance NOT MEASURED`,
      shortMessagesBatch: { messages: msgs.length, ...short, unit: "ms per batch" },
      longText: { chars: long.length, ...big, unit: "ms" },
      usedIn: "Only the Repair and Help-me-respond panels. Chat send, mood and calls do not call detection or the lexicon (grep-verified).",
    }, null, 2) + "\n");
    expect(short.p95).toBeLessThan(50);
  });
});

describe("AUDIT FIX: Help-me-respond now goes through the safety gate", () => {
  it("a threat in any language → no drafted reply, localized neutral guidance, no accusation", async () => {
    const { supportResponse } = await import("@/lib/relationship/responsiveness");
    for (const [msg, lang] of [["I'll hurt you if you leave.", "en"], ["मैं तुम्हें जान से मार दूंगा", "hi"], ["usne mujhe dhamki di", "en"], ["அவன் என்னை மிரட்டினான்", "ta"]] as const) {
      const { support: s } = await supportResponse({ partnerMessage: msg }, { nowMs: 0, language: "en" });
      expect(s.safetyHold, msg).toBe(true);
      expect(s.possibleResponse).toBe("");
      expect(s.components).toEqual([]);
      expect(s.notes.join(" ")).not.toMatch(/abusive|abuser|toxic|your partner is/i);
      expect(s.notes.join(" ")).not.toContain("112"); // no region given → neutral
      if (lang !== "en") expect(s.language).toBe(lang);
    }
  });
  it("ordinary messages are unaffected", async () => {
    const { supportResponse } = await import("@/lib/relationship/responsiveness");
    expect((await supportResponse({ partnerMessage: "You didn't call me after work." }, { nowMs: 0 })).support.safetyHold).toBeFalsy();
  });
});

import { describe, it, expect } from "vitest";
import { detectLanguage, multilingualSafetyCategories, REL_LANGS, type RelLang } from "@/lib/relationship/i18n/lang";
import { t, ALL_KEYS } from "@/lib/relationship/i18n/strings";
import { checkSafety, prepareRepair, newSession, safetyGuidance, type RepairAnswers } from "@/lib/relationship/repair";
import { supportResponse } from "@/lib/relationship/responsiveness";
import { SPLASH_LANGUAGES } from "@/lib/i18n";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const repair = (a: RepairAnswers, language?: string) => prepareRepair({ ...newSession({ id: "r", conflictId: "c", userId: "u", relationshipId: null, nowMs: NOW }), answers: a, stage: "REVIEW", safetyState: checkSafety(a) }, { nowMs: NOW, language });

describe("app languages", () => {
  it("English + Indian languages only", () => {
    expect(SPLASH_LANGUAGES.map((l) => l.code)).toEqual(["en", "hi", "mr", "as", "bn", "te", "ta", "kn", "ml", "gu", "pa", "or"]);
    expect(SPLASH_LANGUAGES.map((l) => l.code)).not.toContain("ur");
  });
});

describe("language detection", () => {
  const cases: [string, RelLang][] = [
    ["You cancelled dinner.", "en"],
    ["तुमने कल फ़ोन नहीं किया।", "hi"],
    ["तू काल फोन केला नाही आणि मला वाईट वाटलं.", "mr"],
    ["তুমি কাল ফোন করোনি।", "bn"],
    ["তুমি কালি মোক ফোন কৰা নাছিলা।", "as"],
    ["నువ్వు నిన్న ఫోన్ చేయలేదు.", "te"],
    ["நீ நேற்று போன் செய்யவில்லை.", "ta"],
    ["ನೀನು ನಿನ್ನೆ ಫೋನ್ ಮಾಡಲಿಲ್ಲ.", "kn"],
    ["നീ ഇന്നലെ ഫോൺ ചെയ്തില്ല.", "ml"],
    ["તેં કાલે ફોન ન કર્યો.", "gu"],
    ["ਤੂੰ ਕੱਲ੍ਹ ਫ਼ੋਨ ਨਹੀਂ ਕੀਤਾ।", "pa"],
    ["ତୁମେ କାଲି ଫୋନ କଲ ନାହିଁ।", "or"],
  ];
  for (const [text, lang] of cases) it(`${lang}: ${text}`, () => expect(detectLanguage(text).lang).toBe(lang));
  it("Hinglish (Hindi in Latin script)", () => {
    expect(detectLanguage("tum ne kal phone kyun nahi kiya, mujhe bahut bura laga").romanizedHindi).toBe(true);
    expect(detectLanguage("I missed your call yesterday").lang).toBe("en");
  });
});

describe("safety gate works in every language (fails closed into SAFETY_HOLD)", () => {
  const danger: [string, string][] = [
    ["hi", "वो मुझे मारता है और धमकी देता है"],
    ["hinglish", "woh mujhe maarta hai aur dhamki deta hai"],
    ["mr", "तो मला मारतो आणि धमकी देतो"],
    ["bn", "সে আমাকে মারে আর হুমকি দেয়"],
    ["as", "তেওঁ মোক মাৰে আৰু ভাবুকি দিয়ে"],
    ["te", "అతను నన్ను కొడతాడు, బెదిరిస్తాడు"],
    ["ta", "அவன் என்னை அடிக்கிறான், மிரட்டுகிறான்"],
    ["kn", "ಅವನು ನನ್ನನ್ನು ಹೊಡೆಯುತ್ತಾನೆ, ಬೆದರಿಕೆ ಹಾಕುತ್ತಾನೆ"],
    ["ml", "അവൻ എന്നെ തല്ലും, ഭീഷണി പെടുത്തും"],
    ["gu", "તે મને મારે છે અને ધમકી આપે છે"],
    ["pa", "ਉਹ ਮੈਨੂੰ ਮਾਰਦਾ ਹੈ ਤੇ ਧਮਕੀ ਦਿੰਦਾ ਹੈ"],
    ["or", "ସେ ମୋତେ ମାରେ ଓ ଧମକ ଦିଏ"],
    ["hi-blackmail", "उसने कहा फोटो वायरल कर देगा"],
    ["hi-isolation", "वो मुझे घरवालों से मिलने नहीं देता"],
    ["hi-selfharm-control", "कहता है मैं छोड़ूँ तो खुद को मार लूंगा"],
    ["ta-money", "என் சம்பளத்தை எடுத்து கொள்கிறான், பணத்தை பறித்து வைத்திருக்கிறான்"],
  ];
  for (const [name, text] of danger) {
    it(name, async () => {
      expect(multilingualSafetyCategories(text).length, text).toBeGreaterThan(0);
      const { result } = await repair({ concreteEvent: text });
      expect(result.safetyState.status).toBe("CONCERN");
      expect(result.proposedMessage).toBe("");
      expect(result.shareable).toBe(false);
    });
  }
  it("ordinary disagreements are NOT flagged (incl. words that contain a lexicon term)", () => {
    for (const benign of ["हमारा डिनर कैंसल हो गया", "tum ne hamara plan cancel kar diya", "मेरी पीठ में दर्द है", "peeth mein dard hai aaj", "আমরা কাল ঝগড়া করেছি", "நாம் நேற்று சண்டை போட்டோம்", "మనం నిన్న గొడవపడ్డాం", "आम्ही काल भांडलो"]) {
      expect(checkSafety({ concreteEvent: benign }).status, benign).toBe("CLEAR");
    }
  });
  it("safety guidance exists in every language; 112 appears ONLY when the device region is India", () => {
    for (const l of REL_LANGS) {
      const neutral = safetyGuidance(l);
      expect(neutral.body).toHaveLength(5);
      expect(neutral.body.join(" ")).not.toContain("112");
      const india = safetyGuidance(l, "IN");
      expect(india.body).toHaveLength(6);
      expect(india.body.join(" ")).toContain("112");
    }
  });
});

describe("limited mode: non-English text is never interpreted", () => {
  it("repair: Hindi answers → verbatim words, localized templates, no English-pattern interpretations", async () => {
    const { result: r } = await repair({ concreteEvent: "तुमने डिनर फिर से कैंसल कर दिया, मतलब मैं तुम्हारे लिए ज़रूरी नहीं हूँ", myResponsibility: "मैंने गुस्से में आवाज़ ऊँची की", specificChange: "प्लान बदले तो पहले बता देना" }, "hi");
    expect(r.limitedMode).toBe(true);
    expect(r.language).toBe("hi");
    expect(r.facts[0].text).toBe("तुमने डिनर फिर से कैंसल कर दिया, मतलब मैं तुम्हारे लिए ज़रूरी नहीं हूँ"); // verbatim, not split
    expect(r.partnerUnderstanding.filter((p) => p.kind === "INTERPRETATION")).toEqual([]);
    expect(r.proposedMessage).toContain("इस हिस्से की ज़िम्मेदारी मैं लेता/लेती हूँ: मैंने गुस्से में आवाज़ ऊँची की।");
    expect(r.proposedMessage).toContain("मेरे लिए यह मददगार होगा: प्लान बदले तो पहले बता देना।");
    expect(r.proposedMessage).not.toMatch(/sorry|responsibility/i);
    expect(r.communicationNotes[0].text).toBe(t("hi", "limitedNotice"));
  });
  it("repair: Tamil with apology only when chosen, and boundary preserved", async () => {
    const a = { myResponsibility: "நான் கோபமாக பேசினேன்", boundary: "என் இருப்பிடத்தை எப்போதும் பகிர மாட்டேன்", cannotAgreeToRequest: true };
    const noSorry = (await repair(a, "ta")).result.proposedMessage;
    expect(noSorry).not.toContain(t("ta", "apology"));
    expect(noSorry).toContain("உன் கோரிக்கை எனக்குப் புரிகிறது, ஆனால் என்னால் இதற்கு ஒப்புக்கொள்ள முடியாது: என் இருப்பிடத்தை எப்போதும் பகிர மாட்டேன்");
    expect((await repair({ ...a, apologize: true }, "ta")).result.proposedMessage).toContain(t("ta", "apology"));
  });
  it("response support: Telugu message → clarification first, verbatim, no inferred feelings", async () => {
    const { support: s } = await supportResponse({ partnerMessage: "సరే." }, { nowMs: NOW, language: "te" });
    expect(s.limitedMode).toBe(true);
    expect(s.clarificationFirst).toBe(true);
    expect(s.clarifyingQuestion).toBe(t("te", "clarifyAmbiguous"));
    expect(s.whatPartnerExplicitlySaid.text).toBe("సరే.");
    expect(s.whatSeemsToMatter).toEqual([]);
  });
  it("detected language is used when the app is in English", async () => {
    const { support: s } = await supportResponse({ partnerMessage: "তুমি কাল আমাকে ফোন করোনি।" }, { nowMs: NOW, language: "en" });
    expect(s.language).toBe("bn");
  });
  it("English stays on the full engine", async () => {
    expect((await repair({ concreteEvent: "You cancelled dinner again, so clearly I'm not important to you." })).result.limitedMode).toBe(false);
  });
});

describe("every template exists in every language, with {x} kept where needed", () => {
  for (const l of REL_LANGS) {
    it(l, () => {
      for (const k of ALL_KEYS) {
        const s = t(l, k, "<<X>>");
        expect(s.length, `${l}.${k}`).toBeGreaterThan(0);
        if (["understandCheck", "partnerSaid", "own", "explain", "nextTime", "request", "boundaryCannot"].includes(k)) expect(s, `${l}.${k}`).toContain("<<X>>");
      }
    });
  }
});

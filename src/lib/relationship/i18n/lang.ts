/**
 * Relationship AI — language detection and multilingual safety lexicon.
 *
 * Detection is script-based (Unicode blocks) with word markers to split
 * Hindi/Marathi (Devanagari) and Bengali/Assamese (Bengali script), plus a
 * marker list for Hindi typed in Latin script ("Hinglish").
 *
 * The safety lexicon is intentionally conservative and small. It was written
 * without native-speaker review and WILL miss some phrasings — see
 * docs/MULTILINGUAL_RELATIONSHIP_AI.md. It only ever ADDS safety holds; it
 * never clears one.
 */
import type { SafetyCategory } from "../repair/types";

export type RelLang = "en" | "hi" | "mr" | "as" | "bn" | "te" | "ta" | "kn" | "ml" | "gu" | "pa" | "or";
export const REL_LANGS: readonly RelLang[] = ["en", "hi", "mr", "as", "bn", "te", "ta", "kn", "ml", "gu", "pa", "or"];
export const isRelLang = (c: string | null | undefined): c is RelLang => !!c && (REL_LANGS as readonly string[]).includes(c);

const SCRIPT: [RegExp, RelLang | "deva" | "beng"][] = [
  [/[\u0900-\u097F]/g, "deva"], [/[\u0980-\u09FF]/g, "beng"], [/[\u0A00-\u0A7F]/g, "pa"], [/[\u0A80-\u0AFF]/g, "gu"],
  [/[\u0B00-\u0B7F]/g, "or"], [/[\u0B80-\u0BFF]/g, "ta"], [/[\u0C00-\u0C7F]/g, "te"], [/[\u0C80-\u0CFF]/g, "kn"], [/[\u0D00-\u0D7F]/g, "ml"],
];
const MARATHI = /(?:^|\s)(आहे|आहेस|नाही|मला|तुला|केले|केलं|झाले|झालं|होते|होतं|आणि|पण|का\s?नाही|माझ|तुझ)/;
const ASSAMESE = /[\u09F0\u09F1]|(?:^|\s)(মই|তুমি\s?মোক|নাই|কৰা|হয়নে|আৰু)/; // ৰ ৱ are Assamese-specific letters
const HINGLISH = /\b(hai|hain|nahi|nahin|mujhe|mujhko|tum|tumhe|tumne|kya|kyun|kyon|mera|meri|tera|teri|bahut|yaar|accha|acha|kab|kaise|mat|bhi|karta|karti|karo|gaya|gayi|raha|rahi)\b/gi;

export interface Detected { lang: RelLang; script: "latin" | "indic" | "none"; romanizedHindi: boolean }

/** Best guess for one piece of text. Mixed text → the dominant script. */
export function detectLanguage(text: string | null | undefined): Detected {
  const t = (text ?? "").trim();
  if (!t) return { lang: "en", script: "none", romanizedHindi: false };
  let best: RelLang | "deva" | "beng" | null = null, bestN = 0;
  for (const [re, l] of SCRIPT) { const n = (t.match(re) ?? []).length; if (n > bestN) { best = l; bestN = n; } }
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  if (best && bestN >= Math.max(2, latin / 3)) {
    const lang: RelLang = best === "deva" ? (MARATHI.test(t) ? "mr" : "hi") : best === "beng" ? (ASSAMESE.test(t) ? "as" : "bn") : best;
    return { lang, script: "indic", romanizedHindi: false };
  }
  const words = t.split(/\s+/).length;
  const hing = (t.match(HINGLISH) ?? []).length;
  if (hing >= 2 && hing / words >= 0.2) return { lang: "hi", script: "latin", romanizedHindi: true };
  return { lang: "en", script: "latin", romanizedHindi: false };
}

/** Is any of these texts something the English pattern engines can't read? */
export function needsLimitedMode(texts: (string | null | undefined)[]): boolean {
  return texts.some((x) => { const d = detectLanguage(x); return d.lang !== "en"; });
}

// ── safety lexicon ─────────────────────────────────────────────────────────

type Lex = Partial<Record<SafetyCategory, string[]>>;
/** Word forms, matched at a word start (no letter/mark before), any suffix after. */
export const LEX: Record<Exclude<RelLang, "en">, Lex> & { hinglish: Lex } = {
  hi: {
    THREAT_OR_VIOLENCE: ["मारपीट", "थप्पड़", "थप्पड", "धमकी", "धमकाया", "धमकाता", "धमकाती", "जान से मार", "चाकू", "बंदूक", "गला दबा", "डर लगता है कि वो", "उससे डर", "उस से डर"],
    STALKING_OR_MONITORING: ["पीछा करता", "पीछा करती", "फोन चेक", "फ़ोन चेक", "फोन को चेक", "लोकेशन ट्रैक", "मेरे मैसेज पढ़"],
    ISOLATION: ["मिलने नहीं देता", "मिलने नहीं देती", "बात नहीं करने देता", "घर से निकलने नहीं"],
    FINANCIAL_COERCION: ["पैसे छीन", "सारे पैसे रख", "पैसे नहीं देता", "तनख्वाह ले लेता"],
    SEXUAL_COERCION: ["ज़बरदस्ती", "जबरदस्ती", "मना करने पर भी"],
    BLACKMAIL: ["ब्लैकमेल", "फोटो वायरल", "फोटो डाल देगा", "फोटो सबको", "फोटो भेज देगा", "फोटो भेज दूंगा", "वीडियो वायरल"],
    SELF_HARM_THREAT_AS_CONTROL: ["खुद को मार लूंगा", "खुद को मार लूँगा", "खुद को मार लूंगी", "आत्महत्या कर लूंगा", "आत्महत्या कर लूंगी", "जान दे दूंगा", "जान दे दूंगी"],
    THREAT_TO_CHILDREN_OR_PETS: ["बच्चों को मार", "बच्चे को मार", "बच्चों को ले जा"],
    IMMEDIATE_DANGER: ["अभी खतरे में", "खतरे में हूँ", "खतरे में हूं", "दरवाज़े पर खड़ा", "बंद कर दिया है"],
  },
  hinglish: {
    THREAT_OR_VIOLENCE: ["mara mujhe", "maarpeet", "maar peet", "pitai", "thappad", "dhamki", "dhamkaya", "dhamkata", "dhamkati", "jaan se maar", "chaku", "chaaku", "bandook", "usse darr", "usse dar lag", "us se darr", "usse darta", "usse darti"],
    STALKING_OR_MONITORING: ["peecha karta", "picha karta", "phone check karta", "phone check karti", "phone ko check", "phone check kar", "mera phone check", "location track"],
    ISOLATION: ["milne nahi deta", "milne nahi deti", "baat nahi karne deta"],
    FINANCIAL_COERCION: ["paise cheen", "paise chheen", "saare paise le leta", "saare paise le leti", "saare paise rakh leta", "saare paise rakh leti", "salary le leta", "salary le leti"],
    SEXUAL_COERCION: ["zabardasti", "jabardasti", "zabardasti ki"],
    BLACKMAIL: ["photo viral", "photos viral", "video viral", "photos daal dega", "photo daal dega", "photos bhej dega", "photo sabko"],
    SELF_HARM_THREAT_AS_CONTROL: ["khud ko maar lunga", "khud ko maar lungi", "suicide kar lunga", "suicide kar lungi", "jaan de dunga", "jaan de dungi"],
    THREAT_TO_CHILDREN_OR_PETS: ["bachon ko maar", "bacchon ko maar", "bache ko maar"],
    IMMEDIATE_DANGER: ["khatre mein hoon", "khatre me hu", "abhi darwaze pe"],
  },
  mr: {
    THREAT_OR_VIOLENCE: ["मारतो", "मारते", "मारलं", "मारले", "मारहाण", "थप्पड", "कानाखाली", "धमकी", "जीवे मार", "चाकू"],
    STALKING_OR_MONITORING: ["पाठलाग", "फोन तपास", "फोन चेक", "लोकेशन ट्रॅक"],
    ISOLATION: ["भेटू देत नाही", "बोलू देत नाही", "घराबाहेर जाऊ देत नाही"],
    FINANCIAL_COERCION: ["पैसे काढून घेत", "पगार काढून घेत", "पैसे देत नाही"],
    SEXUAL_COERCION: ["जबरदस्ती", "जबरदस्तीने"],
    BLACKMAIL: ["ब्लॅकमेल", "फोटो व्हायरल"],
    SELF_HARM_THREAT_AS_CONTROL: ["जीव देईन", "आत्महत्या करेन"],
    THREAT_TO_CHILDREN_OR_PETS: ["मुलांना मार"],
    IMMEDIATE_DANGER: ["धोक्यात आहे", "आत्ता धोक"],
  },
  bn: {
    THREAT_OR_VIOLENCE: ["মারে", "মেরেছে", "মারধর", "চড় মার", "হুমকি", "মেরে ফেল", "ছুরি", "বন্দুক"],
    STALKING_OR_MONITORING: ["পিছু নেয়", "ফোন চেক", "লোকেশন ট্র্যাক"],
    ISOLATION: ["দেখা করতে দেয় না", "কথা বলতে দেয় না", "বাইরে যেতে দেয় না"],
    FINANCIAL_COERCION: ["টাকা কেড়ে", "বেতন নিয়ে নেয়", "টাকা দেয় না"],
    SEXUAL_COERCION: ["জোর করে"],
    BLACKMAIL: ["ব্ল্যাকমেইল", "ছবি ছড়িয়ে", "ভিডিও ছড়িয়ে"],
    SELF_HARM_THREAT_AS_CONTROL: ["আত্মহত্যা করব", "মরে যাব যদি"],
    THREAT_TO_CHILDREN_OR_PETS: ["বাচ্চাদের মার"],
    IMMEDIATE_DANGER: ["বিপদে আছি", "এখনই বিপদ"],
  },
  as: {
    THREAT_OR_VIOLENCE: ["মাৰে", "মাৰিলে", "মাৰপিট", "চৰ মাৰ", "ভাবুকি", "মাৰি পেলাম", "মাৰি পেলাব", "কটাৰী"],
    STALKING_OR_MONITORING: ["পিছে পিছে", "ফোন চেক"],
    ISOLATION: ["লগ কৰিবলৈ নিদিয়ে", "কথা পাতিবলৈ নিদিয়ে"],
    FINANCIAL_COERCION: ["টকা কাঢ়ি", "দৰমহা লৈ লয়"],
    SEXUAL_COERCION: ["জোৰকৈ", "বলপূৰ্বক"],
    BLACKMAIL: ["ব্লেকমেইল", "ফটো ভাইৰেল"],
    SELF_HARM_THREAT_AS_CONTROL: ["আত্মহত্যা কৰিম"],
    THREAT_TO_CHILDREN_OR_PETS: ["ল'ৰা-ছোৱালীক মাৰ"],
    IMMEDIATE_DANGER: ["বিপদত আছোঁ", "এতিয়াই বিপদ"],
  },
  te: {
    THREAT_OR_VIOLENCE: ["కొడతాడు", "కొట్టాడు", "కొడుతుంది", "కొట్టింది", "బెదిరింపు", "బెదిరిస్తాడు", "బెదిరించాడు", "చంపేస్తా", "చంపుతా", "కత్తి"],
    STALKING_OR_MONITORING: ["వెంబడిస్తాడు", "ఫోన్ చెక్", "లొకేషన్ ట్రాక్"],
    ISOLATION: ["కలవనివ్వడు", "మాట్లాడనివ్వడు", "బయటకు వెళ్లనివ్వడు"],
    FINANCIAL_COERCION: ["డబ్బు లాక్కుంటాడు", "జీతం తీసుకుంటాడు"],
    SEXUAL_COERCION: ["బలవంతంగా", "బలవంతం"],
    BLACKMAIL: ["బ్లాక్‌మెయిల్", "బ్లాక్మెయిల్", "ఫోటోలు వైరల్"],
    SELF_HARM_THREAT_AS_CONTROL: ["ఆత్మహత్య చేసుకుంటా", "చచ్చిపోతా"],
    THREAT_TO_CHILDREN_OR_PETS: ["పిల్లల్ని చంపు", "పిల్లలను కొడ"],
    IMMEDIATE_DANGER: ["ప్రమాదంలో ఉన్నా", "ఇప్పుడే ప్రమాదం"],
  },
  ta: {
    THREAT_OR_VIOLENCE: ["அடிக்கிறான்", "அடித்தான்", "அடிக்கிறாள்", "அடித்தாள்", "மிரட்டல்", "மிரட்டுகிறான்", "மிரட்டினான்", "கொன்றுவிடுவேன்", "கொல்லுவேன்", "கத்தி"],
    STALKING_OR_MONITORING: ["பின்தொடர்கிறான்", "போன் சோதனை", "போனை செக்", "லொகேஷன் டிராக்"],
    ISOLATION: ["சந்திக்க விடுவதில்லை", "பேச விடுவதில்லை", "வெளியே போக விடுவதில்லை"],
    FINANCIAL_COERCION: ["பணத்தை பறித்து", "சம்பளத்தை எடுத்து"],
    SEXUAL_COERCION: ["கட்டாயப்படுத்தி", "வலுக்கட்டாயமாக"],
    BLACKMAIL: ["பிளாக்மெயில்", "புகைப்படங்களை பரப்ப"],
    SELF_HARM_THREAT_AS_CONTROL: ["தற்கொலை செய்துகொள்வேன்", "செத்துவிடுவேன்"],
    THREAT_TO_CHILDREN_OR_PETS: ["குழந்தைகளை அடி", "குழந்தைகளை கொல்"],
    IMMEDIATE_DANGER: ["ஆபத்தில் இருக்கிறேன்", "இப்போது ஆபத்து"],
  },
  kn: {
    THREAT_OR_VIOLENCE: ["ಹೊಡೆಯುತ್ತಾನೆ", "ಹೊಡೆದ", "ಹೊಡೆಯುತ್ತಾಳೆ", "ಬೆದರಿಕೆ", "ಕೊಲ್ಲುತ್ತೇನೆ", "ಚಾಕು"],
    STALKING_OR_MONITORING: ["ಹಿಂಬಾಲಿಸುತ್ತಾನೆ", "ಫೋನ್ ಚೆಕ್"],
    ISOLATION: ["ಭೇಟಿಯಾಗಲು ಬಿಡುವುದಿಲ್ಲ", "ಮಾತನಾಡಲು ಬಿಡುವುದಿಲ್ಲ"],
    FINANCIAL_COERCION: ["ಹಣ ಕಿತ್ತುಕೊಳ್ಳುತ್ತಾನೆ", "ಸಂಬಳ ತೆಗೆದುಕೊಳ್ಳುತ್ತಾನೆ"],
    SEXUAL_COERCION: ["ಬಲವಂತವಾಗಿ", "ಬಲವಂತ"],
    BLACKMAIL: ["ಬ್ಲ್ಯಾಕ್‌ಮೇಲ್", "ಬ್ಲ್ಯಾಕ್ಮೇಲ್"],
    SELF_HARM_THREAT_AS_CONTROL: ["ಆತ್ಮಹತ್ಯೆ ಮಾಡಿಕೊಳ್ಳುತ್ತೇನೆ"],
    THREAT_TO_CHILDREN_OR_PETS: ["ಮಕ್ಕಳನ್ನು ಹೊಡೆ"],
    IMMEDIATE_DANGER: ["ಅಪಾಯದಲ್ಲಿದ್ದೇನೆ", "ಈಗ ಅಪಾಯ"],
  },
  ml: {
    THREAT_OR_VIOLENCE: ["അടിക്കും", "അടിച്ചു", "തല്ലി", "തല്ലും", "ഭീഷണി", "കൊല്ലും", "കത്തി"],
    STALKING_OR_MONITORING: ["പിന്തുടരുന്നു", "ഫോൺ പരിശോധിക്കും", "ഫോൺ ചെക്ക്"],
    ISOLATION: ["കാണാൻ അനുവദിക്കില്ല", "സംസാരിക്കാൻ അനുവദിക്കില്ല"],
    FINANCIAL_COERCION: ["പണം പിടിച്ചുവാങ്ങ", "ശമ്പളം എടുക്കും"],
    SEXUAL_COERCION: ["നിർബന്ധിച്ച്", "ബലമായി"],
    BLACKMAIL: ["ബ്ലാക്ക്മെയിൽ"],
    SELF_HARM_THREAT_AS_CONTROL: ["ആത്മഹത്യ ചെയ്യും"],
    THREAT_TO_CHILDREN_OR_PETS: ["കുട്ടികളെ തല്ല", "കുട്ടികളെ കൊല്ല"],
    IMMEDIATE_DANGER: ["അപകടത്തിലാണ്", "ഇപ്പോൾ അപകടം"],
  },
  gu: {
    THREAT_OR_VIOLENCE: ["મારે છે", "માર્યો", "માર્યું", "માર મારે", "થપ્પડ", "ધમકી", "જાનથી મારી", "છરી"],
    STALKING_OR_MONITORING: ["પીછો કરે", "ફોન ચેક"],
    ISOLATION: ["મળવા નથી દેતો", "મળવા નથી દેતી", "વાત કરવા નથી દેતો"],
    FINANCIAL_COERCION: ["પૈસા છીનવી", "પગાર લઈ લે"],
    SEXUAL_COERCION: ["જબરદસ્તી"],
    BLACKMAIL: ["બ્લેકમેલ", "ફોટો વાયરલ"],
    SELF_HARM_THREAT_AS_CONTROL: ["આત્મહત્યા કરી લઈશ", "જીવ આપી દઈશ"],
    THREAT_TO_CHILDREN_OR_PETS: ["બાળકોને માર"],
    IMMEDIATE_DANGER: ["જોખમમાં છું", "અત્યારે જોખમ"],
  },
  pa: {
    THREAT_OR_VIOLENCE: ["ਮਾਰਦਾ", "ਮਾਰਦੀ", "ਕੁੱਟਦਾ", "ਕੁੱਟਿਆ", "ਧਮਕੀ", "ਜਾਨੋਂ ਮਾਰ", "ਚਾਕੂ"],
    STALKING_OR_MONITORING: ["ਪਿੱਛਾ ਕਰਦਾ", "ਫ਼ੋਨ ਚੈੱਕ", "ਫੋਨ ਚੈੱਕ"],
    ISOLATION: ["ਮਿਲਣ ਨਹੀਂ ਦਿੰਦਾ", "ਮਿਲਣ ਨਹੀਂ ਦਿੰਦੀ"],
    FINANCIAL_COERCION: ["ਪੈਸੇ ਖੋਹ", "ਤਨਖਾਹ ਲੈ ਲੈਂਦਾ"],
    SEXUAL_COERCION: ["ਜ਼ਬਰਦਸਤੀ", "ਜਬਰਦਸਤੀ"],
    BLACKMAIL: ["ਬਲੈਕਮੇਲ"],
    SELF_HARM_THREAT_AS_CONTROL: ["ਖ਼ੁਦਕੁਸ਼ੀ ਕਰ ਲਵਾਂਗਾ", "ਖੁਦਕੁਸ਼ੀ ਕਰ ਲਵਾਂਗਾ"],
    THREAT_TO_CHILDREN_OR_PETS: ["ਬੱਚਿਆਂ ਨੂੰ ਮਾਰ"],
    IMMEDIATE_DANGER: ["ਖ਼ਤਰੇ ਵਿੱਚ ਹਾਂ", "ਖਤਰੇ ਵਿੱਚ ਹਾਂ"],
  },
  or: {
    THREAT_OR_VIOLENCE: ["ମାରେ", "ମାରିଲା", "ମାଡ଼ ମାରେ", "ଧମକ", "ମାରିଦେବି", "ଛୁରୀ"],
    STALKING_OR_MONITORING: ["ପିଛା କରେ", "ଫୋନ ଚେକ"],
    ISOLATION: ["ଦେଖା କରିବାକୁ ଦିଏନି", "କଥା ହେବାକୁ ଦିଏନି"],
    FINANCIAL_COERCION: ["ଟଙ୍କା ଛଡ଼େଇ", "ଦରମା ନେଇଯାଏ"],
    SEXUAL_COERCION: ["ଜବରଦସ୍ତି"],
    BLACKMAIL: ["ବ୍ଲାକମେଲ"],
    SELF_HARM_THREAT_AS_CONTROL: ["ଆତ୍ମହତ୍ୟା କରିବି"],
    THREAT_TO_CHILDREN_OR_PETS: ["ପିଲାଙ୍କୁ ମାର"],
    IMMEDIATE_DANGER: ["ବିପଦରେ ଅଛି", "ଏବେ ବିପଦ"],
  },
};

/**
 * Weak verbs: "maara"/"मारा" also means killing a mosquito or scoring in a
 * game. They count only when a PERSON is the object in the same sentence
 * (me / us / the children). Nothing is removed from the vocabulary — it just
 * needs that context. Other languages use inflected, person-directed forms.
 */
export const WEAK: { cat: SafetyCategory; verbs: string[]; object: RegExp }[] = [
  { cat: "THREAT_OR_VIOLENCE", verbs: ["maarta", "maarti", "marta", "marti", "maara", "mara", "maar diya", "maar deta", "maar deti", "peeta", "peet diya", "peetta", "peetata", "maarega", "maaregi"],
    object: /(?<![\p{L}\p{M}])(mujhe|mujhko|muje|mjhe|mujhe bhi|humein|hamein|hume|mujh ?par|mujh ?pe|mere upar|meri pitai|bach+on ko|bach+e ko|meri (maa|mom|behen|behan))(?![\p{L}\p{M}])/iu },
  { cat: "THREAT_OR_VIOLENCE", verbs: ["मारता", "मारती", "मारा", "मार दिया", "मार देता", "मार देती", "मारेगा", "मारेगी", "पीटा", "पीटता", "पीटती"],
    object: /(मुझे|मुझको|हमें|मुझ पर|मुझपर|मेरी पिटाई|बच्चों को|बच्चे को)/u },
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const COMPILED: [SafetyCategory, RegExp][] = Object.values(LEX).flatMap((lex) =>
  Object.entries(lex).map(([cat, terms]) => [cat as SafetyCategory, new RegExp(`(?<![\\p{L}\\p{M}])(?:${terms!.map(esc).join("|")})`, "iu")] as [SafetyCategory, RegExp]));

/** Categories matched by the multilingual lexicon (all languages, always — not only the detected one). */
export function multilingualSafetyCategories(text: string): SafetyCategory[] {
  const t = text.normalize("NFC");
  const out = new Set(COMPILED.filter(([, re]) => re.test(t)).map(([c]) => c));
  for (const sentence of t.split(/[.!?।॥\n]+/u)) {
    for (const w of WEAK_COMPILED) {
      // a person as object ("mujhe maarta"), or the verb directly after a
      // third-person subject with nothing in between ("woh maarta hai",
      // "usne maara") — but not "usne machhar maar diya".
      if (w.verb.test(sentence) && (w.object.test(sentence) || w.subjectVerb.test(sentence))) out.add(w.cat);
    }
  }
  return [...out];
}

const SUBJECT = "(?:woh|wo|vo|voh|usne|usnay|वो|वह|उसने)";
const WEAK_COMPILED = WEAK.map((w) => ({ cat: w.cat, object: w.object,
  subjectVerb: new RegExp(`(?<![\\p{L}\\p{M}])${SUBJECT}\\s+(?:${w.verbs.map(esc).join("|")})(?![\\p{L}\\p{M}])`, "iu"),
  verb: new RegExp(`(?<![\\p{L}\\p{M}])(?:${w.verbs.map(esc).join("|")})(?![\\p{L}\\p{M}])`, "iu") }));

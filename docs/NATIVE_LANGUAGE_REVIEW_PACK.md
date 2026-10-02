# Native Language Review Pack

Generated from the code on 2026-09-26 (`src/lib/relationship/i18n/*`). **Status for every language: NOT_REVIEWED.** Nothing here has been checked by a native speaker.

## How to review (structured — "looks okay" is not a review)
For EVERY line, fill in the columns. Scores 1–5 (5 = best) unless stated.

| Column | What to assess |
|---|---|
| A Natural | Would a native speaker say it this way? |
| B Meaning | Same meaning as the English source? (Y/N + note) |
| C–F Terms | For safety phrases: does it really express threat / coercion / violence / stalking? |
| G Emergency | Is the emergency guidance correct and safe for India? |
| H False positive | Common innocent sentences that contain this phrase (list them) |
| I False negative | Common ways people say the same thing that are MISSING (list them) |
| J Dialect | Regional/colloquial/romanized forms to add |
| K Tone | Respectful, non-judgemental, not accusatory? |
| L Culture | Culturally appropriate? |
| Decision | KEEP / CHANGE (give text) / REMOVE |

Reviewer sign-off per language: name, qualifications (ideally including experience with domestic-violence support), date. Only then may a language be marked REVIEWED; PRODUCTION_REVIEWED additionally needs a support-organisation check of the safety guidance.

## Design rules reviewers should know
- Every lexicon runs on every message (mixed-language text is covered).
- Matching starts at a word boundary; suffixes after the phrase are allowed.
- A match only opens a neutral safety flow ("may involve a safety concern"); it never accuses anyone.
- Ambiguous verbs (Hindi/Hinglish "maara"/"मारा") count only with a person as object or directly after a third-person subject.


---

## Hinglish (Hindi in Latin script) (`hinglish`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | mara mujhe | | | | | | | |
| THREAT_OR_VIOLENCE | maarpeet | | | | | | | |
| THREAT_OR_VIOLENCE | maar peet | | | | | | | |
| THREAT_OR_VIOLENCE | pitai | | | | | | | |
| THREAT_OR_VIOLENCE | thappad | | | | | | | |
| THREAT_OR_VIOLENCE | dhamki | | | | | | | |
| THREAT_OR_VIOLENCE | dhamkaya | | | | | | | |
| THREAT_OR_VIOLENCE | dhamkata | | | | | | | |
| THREAT_OR_VIOLENCE | dhamkati | | | | | | | |
| THREAT_OR_VIOLENCE | jaan se maar | | | | | | | |
| THREAT_OR_VIOLENCE | chaku | | | | | | | |
| THREAT_OR_VIOLENCE | chaaku | | | | | | | |
| THREAT_OR_VIOLENCE | bandook | | | | | | | |
| THREAT_OR_VIOLENCE | usse darr | | | | | | | |
| THREAT_OR_VIOLENCE | usse dar lag | | | | | | | |
| THREAT_OR_VIOLENCE | us se darr | | | | | | | |
| THREAT_OR_VIOLENCE | usse darta | | | | | | | |
| THREAT_OR_VIOLENCE | usse darti | | | | | | | |
| STALKING_OR_MONITORING | peecha karta | | | | | | | |
| STALKING_OR_MONITORING | picha karta | | | | | | | |
| STALKING_OR_MONITORING | phone check karta | | | | | | | |
| STALKING_OR_MONITORING | phone check karti | | | | | | | |
| STALKING_OR_MONITORING | phone ko check | | | | | | | |
| STALKING_OR_MONITORING | phone check kar | | | | | | | |
| STALKING_OR_MONITORING | mera phone check | | | | | | | |
| STALKING_OR_MONITORING | location track | | | | | | | |
| ISOLATION | milne nahi deta | | | | | | | |
| ISOLATION | milne nahi deti | | | | | | | |
| ISOLATION | baat nahi karne deta | | | | | | | |
| FINANCIAL_COERCION | paise cheen | | | | | | | |
| FINANCIAL_COERCION | paise chheen | | | | | | | |
| FINANCIAL_COERCION | saare paise le leta | | | | | | | |
| FINANCIAL_COERCION | saare paise le leti | | | | | | | |
| FINANCIAL_COERCION | saare paise rakh leta | | | | | | | |
| FINANCIAL_COERCION | saare paise rakh leti | | | | | | | |
| FINANCIAL_COERCION | salary le leta | | | | | | | |
| FINANCIAL_COERCION | salary le leti | | | | | | | |
| SEXUAL_COERCION | zabardasti | | | | | | | |
| SEXUAL_COERCION | jabardasti | | | | | | | |
| SEXUAL_COERCION | zabardasti ki | | | | | | | |
| BLACKMAIL | photo viral | | | | | | | |
| BLACKMAIL | photos viral | | | | | | | |
| BLACKMAIL | video viral | | | | | | | |
| BLACKMAIL | photos daal dega | | | | | | | |
| BLACKMAIL | photo daal dega | | | | | | | |
| BLACKMAIL | photos bhej dega | | | | | | | |
| BLACKMAIL | photo sabko | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | khud ko maar lunga | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | khud ko maar lungi | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | suicide kar lunga | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | suicide kar lungi | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | jaan de dunga | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | jaan de dungi | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | bachon ko maar | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | bacchon ko maar | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | bache ko maar | | | | | | | |
| IMMEDIATE_DANGER | khatre mein hoon | | | | | | | |
| IMMEDIATE_DANGER | khatre me hu | | | | | | | |
| IMMEDIATE_DANGER | abhi darwaze pe | | | | | | | |

**Context-gated verbs** (count only with a person object (?<![\p{L}\p{M}])(mujhe|mujhko|muje|mjhe|mujhe bhi|humein|hamein|hume|mujh ?par|… or right after a subject pronoun): maarta, maarti, marta, marti, maara, mara, maar diya, maar deta, maar deti, peeta, peet diya, peetta, peetata, maarega, maaregi

**Romanized forms:** this section IS the romanized set.

---

## Hindi (`hi`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | मारपीट | | | | | | | |
| THREAT_OR_VIOLENCE | थप्पड़ | | | | | | | |
| THREAT_OR_VIOLENCE | थप्पड | | | | | | | |
| THREAT_OR_VIOLENCE | धमकी | | | | | | | |
| THREAT_OR_VIOLENCE | धमकाया | | | | | | | |
| THREAT_OR_VIOLENCE | धमकाता | | | | | | | |
| THREAT_OR_VIOLENCE | धमकाती | | | | | | | |
| THREAT_OR_VIOLENCE | जान से मार | | | | | | | |
| THREAT_OR_VIOLENCE | चाकू | | | | | | | |
| THREAT_OR_VIOLENCE | बंदूक | | | | | | | |
| THREAT_OR_VIOLENCE | गला दबा | | | | | | | |
| THREAT_OR_VIOLENCE | डर लगता है कि वो | | | | | | | |
| THREAT_OR_VIOLENCE | उससे डर | | | | | | | |
| THREAT_OR_VIOLENCE | उस से डर | | | | | | | |
| STALKING_OR_MONITORING | पीछा करता | | | | | | | |
| STALKING_OR_MONITORING | पीछा करती | | | | | | | |
| STALKING_OR_MONITORING | फोन चेक | | | | | | | |
| STALKING_OR_MONITORING | फ़ोन चेक | | | | | | | |
| STALKING_OR_MONITORING | फोन को चेक | | | | | | | |
| STALKING_OR_MONITORING | लोकेशन ट्रैक | | | | | | | |
| STALKING_OR_MONITORING | मेरे मैसेज पढ़ | | | | | | | |
| ISOLATION | मिलने नहीं देता | | | | | | | |
| ISOLATION | मिलने नहीं देती | | | | | | | |
| ISOLATION | बात नहीं करने देता | | | | | | | |
| ISOLATION | घर से निकलने नहीं | | | | | | | |
| FINANCIAL_COERCION | पैसे छीन | | | | | | | |
| FINANCIAL_COERCION | सारे पैसे रख | | | | | | | |
| FINANCIAL_COERCION | पैसे नहीं देता | | | | | | | |
| FINANCIAL_COERCION | तनख्वाह ले लेता | | | | | | | |
| SEXUAL_COERCION | ज़बरदस्ती | | | | | | | |
| SEXUAL_COERCION | जबरदस्ती | | | | | | | |
| SEXUAL_COERCION | मना करने पर भी | | | | | | | |
| BLACKMAIL | ब्लैकमेल | | | | | | | |
| BLACKMAIL | फोटो वायरल | | | | | | | |
| BLACKMAIL | फोटो डाल देगा | | | | | | | |
| BLACKMAIL | फोटो सबको | | | | | | | |
| BLACKMAIL | फोटो भेज देगा | | | | | | | |
| BLACKMAIL | फोटो भेज दूंगा | | | | | | | |
| BLACKMAIL | वीडियो वायरल | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | खुद को मार लूंगा | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | खुद को मार लूँगा | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | खुद को मार लूंगी | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | आत्महत्या कर लूंगा | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | आत्महत्या कर लूंगी | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | जान दे दूंगा | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | जान दे दूंगी | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | बच्चों को मार | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | बच्चे को मार | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | बच्चों को ले जा | | | | | | | |
| IMMEDIATE_DANGER | अभी खतरे में | | | | | | | |
| IMMEDIATE_DANGER | खतरे में हूँ | | | | | | | |
| IMMEDIATE_DANGER | खतरे में हूं | | | | | | | |
| IMMEDIATE_DANGER | दरवाज़े पर खड़ा | | | | | | | |
| IMMEDIATE_DANGER | बंद कर दिया है | | | | | | | |

**Context-gated verbs** (count only with a person object (मुझे|मुझको|हमें|मुझ पर|मुझपर|मेरी पिटाई|बच्चों को|बच्चे को)… or right after a subject pronoun): मारता, मारती, मारा, मार दिया, मार देता, मार देती, मारेगा, मारेगी, पीटा, पीटता, पीटती

### Safety guidance (shown when the safety gate trips)
| Key | English source | Hindi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | इस स्थिति में सुरक्षा से जुड़ी चिंता हो सकती है | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace आपकी सुरक्षा का आकलन नहीं कर सकता, और यह आपके या किसी और के बारे में कोई फ़ैसला नहीं है। | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | आपने जो लिखा है उसकी वजह से DuoSpace अभी आपके साथी के लिए कोई संदेश, बातचीत, माफ़ी या मुलाक़ात का सुझाव नहीं देगा। | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | अगर आप तुरंत ख़तरे में हैं, तो अपने स्थानीय आपातकालीन नंबर पर संपर्क करें। | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | किसी भरोसेमंद व्यक्ति से या घरेलू हिंसा से जुड़ी किसी स्थानीय सहायता सेवा से बात करना मदद कर सकता है। | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | आप इसे कभी भी बंद कर सकते हैं। आपने यहाँ जो लिखा है वह न सेव होता है, न साझा किया जाता है। | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | भारत में आपातकालीन नंबर 112 है। | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Hindi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace अभी इस भाषा में लिखे शब्दों का मतलब नहीं निकालता। आपके शब्द वैसे ही दिखाए गए हैं जैसे आपने लिखे, और उनकी कोई व्याख्या नहीं की गई है। | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | इन शब्दों के आगे आपके साथी का क्या मतलब था: यह सिर्फ़ आपका साथी ही बता सकता है। | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | इस बारे में आपके साथी को कैसा लगता है: यहाँ नहीं बताया गया है। | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | यह अपनी बात कहने का सिर्फ़ एक तरीका है। यह कोई फ़ैसला नहीं है, और DuoSpace नहीं जान सकता कि आपका साथी क्या महसूस करता है या उसका क्या मतलब था। | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Hindi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | तुमने कहा: “{x}”। | | | | | | |
| own | I take responsibility for this part: {x}. | इस हिस्से की ज़िम्मेदारी मैं लेता/लेती हूँ: {x}। | | | | | | |
| apology | I'm sorry. | मुझे माफ़ करना। | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | मैं समझता/समझती हूँ कि यह तुम्हारे लिए मायने रखता है, लेकिन मुझे यह अलग तरह से याद है। | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | जो हुआ उसकी हर व्याख्या से मैं सहमत नहीं हूँ। | | | | | | |
| explain | From my side: {x}. | मेरी तरफ़ से: {x}। | | | | | | |
| nextTime | Next time, I can: {x}. | अगली बार मैं यह कर सकता/सकती हूँ: {x}। | | | | | | |
| request | What would help me is: {x}. | मेरे लिए यह मददगार होगा: {x}। | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | मैं तुम्हारी बात समझता/समझती हूँ, लेकिन मैं इसके लिए हाँ नहीं कह सकता/सकती: {x}। | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | जो हुआ उसमें तुम्हारे लिए सबसे ज़्यादा क्या मायने रखता था? | | | | | | |

### Response-support templates
| Key | English source | Hindi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | मैं सुन रहा/रही हूँ। | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | मैंने ऐसे समझा: “{x}”। क्या मैंने सही समझा? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | उस समय तुम्हें क्या करना अच्छा लगता? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | क्या तुम इस बारे में बात करना चाहते हो, या अभी थोड़ा समय अकेले चाहिए? | | | | | | |

**Romanized forms:** romanized Hindi is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

## Marathi (`mr`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | मारतो | | | | | | | |
| THREAT_OR_VIOLENCE | मारते | | | | | | | |
| THREAT_OR_VIOLENCE | मारलं | | | | | | | |
| THREAT_OR_VIOLENCE | मारले | | | | | | | |
| THREAT_OR_VIOLENCE | मारहाण | | | | | | | |
| THREAT_OR_VIOLENCE | थप्पड | | | | | | | |
| THREAT_OR_VIOLENCE | कानाखाली | | | | | | | |
| THREAT_OR_VIOLENCE | धमकी | | | | | | | |
| THREAT_OR_VIOLENCE | जीवे मार | | | | | | | |
| THREAT_OR_VIOLENCE | चाकू | | | | | | | |
| STALKING_OR_MONITORING | पाठलाग | | | | | | | |
| STALKING_OR_MONITORING | फोन तपास | | | | | | | |
| STALKING_OR_MONITORING | फोन चेक | | | | | | | |
| STALKING_OR_MONITORING | लोकेशन ट्रॅक | | | | | | | |
| ISOLATION | भेटू देत नाही | | | | | | | |
| ISOLATION | बोलू देत नाही | | | | | | | |
| ISOLATION | घराबाहेर जाऊ देत नाही | | | | | | | |
| FINANCIAL_COERCION | पैसे काढून घेत | | | | | | | |
| FINANCIAL_COERCION | पगार काढून घेत | | | | | | | |
| FINANCIAL_COERCION | पैसे देत नाही | | | | | | | |
| SEXUAL_COERCION | जबरदस्ती | | | | | | | |
| SEXUAL_COERCION | जबरदस्तीने | | | | | | | |
| BLACKMAIL | ब्लॅकमेल | | | | | | | |
| BLACKMAIL | फोटो व्हायरल | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | जीव देईन | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | आत्महत्या करेन | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | मुलांना मार | | | | | | | |
| IMMEDIATE_DANGER | धोक्यात आहे | | | | | | | |
| IMMEDIATE_DANGER | आत्ता धोक | | | | | | | |

### Safety guidance (shown when the safety gate trips)
| Key | English source | Marathi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | या परिस्थितीत सुरक्षिततेची चिंता असू शकते | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace तुमच्या सुरक्षिततेचे मूल्यमापन करू शकत नाही, आणि हा तुमच्याबद्दल किंवा इतर कोणाबद्दल निर्णय नाही. | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | तुम्ही जे लिहिले आहे त्यामुळे DuoSpace आत्ता तुमच्या जोडीदारासाठी संदेश, संभाषण, माफी किंवा भेट सुचवणार नाही. | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | तुम्ही तात्काळ धोक्यात असाल तर तुमच्या स्थानिक आपत्कालीन क्रमांकावर संपर्क करा. | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | विश्वासू व्यक्तीशी किंवा कौटुंबिक हिंसाचाराशी संबंधित स्थानिक मदत सेवेशी बोलणे उपयोगी ठरू शकते. | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | तुम्ही हे कधीही बंद करू शकता. तुम्ही इथे लिहिलेले काहीही जतन किंवा शेअर केले जात नाही. | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | भारतात आपत्कालीन क्रमांक 112 आहे. | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Marathi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace अजून या भाषेतील मजकुराचा अर्थ लावत नाही. तुमचे शब्द जसे लिहिले तसेच दाखवले आहेत, आणि त्यांचा कोणताही अर्थ लावलेला नाही. | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | या शब्दांपलीकडे तुमच्या जोडीदाराला काय म्हणायचे होते: हे फक्त तुमचा जोडीदारच सांगू शकतो. | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | याबद्दल तुमच्या जोडीदाराला कसे वाटते: इथे सांगितलेले नाही. | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | तुम्हाला जे माहीत आहे ते सांगण्याचा हा फक्त एक मार्ग आहे. हा निर्णय नाही, आणि तुमच्या जोडीदाराला काय वाटते किंवा काय म्हणायचे होते हे DuoSpace जाणू शकत नाही. | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Marathi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | तू म्हणालास/म्हणालीस: “{x}”. | | | | | | |
| own | I take responsibility for this part: {x}. | या भागाची जबाबदारी मी घेतो/घेते: {x}. | | | | | | |
| apology | I'm sorry. | मला माफ कर. | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | हे तुझ्यासाठी महत्त्वाचे होते हे मला समजते, पण मला ते वेगळ्या प्रकारे आठवते. | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | जे घडले त्याच्या प्रत्येक अर्थाशी मी सहमत नाही. | | | | | | |
| explain | From my side: {x}. | माझ्या बाजूने: {x}. | | | | | | |
| nextTime | Next time, I can: {x}. | पुढच्या वेळी मी हे करू शकतो/शकते: {x}. | | | | | | |
| request | What would help me is: {x}. | मला यामुळे मदत होईल: {x}. | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | मला तुझी विनंती समजते, पण मी याला होकार देऊ शकत नाही: {x}. | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | जे घडले त्यात तुझ्यासाठी सर्वात महत्त्वाचे काय होते? | | | | | | |

### Response-support templates
| Key | English source | Marathi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | मी ऐकतोय/ऐकतेय. | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | मला असे समजले: “{x}”. मी बरोबर समजलो/समजले का? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | त्या वेळी तुला काय उपयोगी वाटले असते? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | तुला याबद्दल बोलायचे आहे का, की आत्ता थोडा वेळ एकटे राहायचे आहे? | | | | | | |

**Romanized forms:** romanized Marathi is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

## Assamese (`as`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | মাৰে | | | | | | | |
| THREAT_OR_VIOLENCE | মাৰিলে | | | | | | | |
| THREAT_OR_VIOLENCE | মাৰপিট | | | | | | | |
| THREAT_OR_VIOLENCE | চৰ মাৰ | | | | | | | |
| THREAT_OR_VIOLENCE | ভাবুকি | | | | | | | |
| THREAT_OR_VIOLENCE | মাৰি পেলাম | | | | | | | |
| THREAT_OR_VIOLENCE | মাৰি পেলাব | | | | | | | |
| THREAT_OR_VIOLENCE | কটাৰী | | | | | | | |
| STALKING_OR_MONITORING | পিছে পিছে | | | | | | | |
| STALKING_OR_MONITORING | ফোন চেক | | | | | | | |
| ISOLATION | লগ কৰিবলৈ নিদিয়ে | | | | | | | |
| ISOLATION | কথা পাতিবলৈ নিদিয়ে | | | | | | | |
| FINANCIAL_COERCION | টকা কাঢ়ি | | | | | | | |
| FINANCIAL_COERCION | দৰমহা লৈ লয় | | | | | | | |
| SEXUAL_COERCION | জোৰকৈ | | | | | | | |
| SEXUAL_COERCION | বলপূৰ্বক | | | | | | | |
| BLACKMAIL | ব্লেকমেইল | | | | | | | |
| BLACKMAIL | ফটো ভাইৰেল | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | আত্মহত্যা কৰিম | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | ল'ৰা-ছোৱালীক মাৰ | | | | | | | |
| IMMEDIATE_DANGER | বিপদত আছোঁ | | | | | | | |
| IMMEDIATE_DANGER | এতিয়াই বিপদ | | | | | | | |

### Safety guidance (shown when the safety gate trips)
| Key | English source | Assamese | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | এই পৰিস্থিতিত সুৰক্ষাজনিত চিন্তা থাকিব পাৰে | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace-এ আপোনাৰ সুৰক্ষাৰ মূল্যায়ন কৰিব নোৱাৰে, আৰু এয়া আপোনাৰ বা আন কাৰোবাৰ বিষয়ে কোনো সিদ্ধান্ত নহয়। | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | আপুনি যি লিখিছে তাৰ বাবে DuoSpace-এ এতিয়া আপোনাৰ সংগীলৈ বাৰ্তা, কথা-বতৰা, ক্ষমা বা সাক্ষাতৰ পৰামৰ্শ নিদিয়ে। | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | যদি আপুনি তৎক্ষণাত বিপদত আছে, আপোনাৰ স্থানীয় জৰুৰীকালীন নম্বৰত যোগাযোগ কৰক। | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | বিশ্বাসী কাৰোবাৰ সৈতে বা ঘৰুৱা হিংসাৰ স্থানীয় সহায় সেৱাৰ সৈতে কথা পাতিলে সহায় হ'ব পাৰে। | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | আপুনি যিকোনো সময়তে এইটো বন্ধ কৰিব পাৰে। আপুনি ইয়াত লিখা একো সংৰক্ষণ বা শ্বেয়াৰ কৰা নহয়। | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | ভাৰতত জৰুৰীকালীন নম্বৰ 112। | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Assamese | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace-এ এতিয়াও এই ভাষাৰ লিখনিৰ অৰ্থ বিশ্লেষণ নকৰে। আপোনাৰ শব্দবোৰ যেনেকৈ লিখিছে তেনেকৈয়ে দেখুওৱা হৈছে, আৰু একো ব্যাখ্যা কৰা হোৱা নাই। | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | এই শব্দবোৰৰ বাহিৰে আপোনাৰ সংগীয়ে কি বুজাব বিচাৰিছিল: সেয়া কেৱল আপোনাৰ সংগীয়েহে ক'ব পাৰে। | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | এই বিষয়ে আপোনাৰ সংগীৰ কেনে লাগে: ইয়াত কোৱা হোৱা নাই। | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | আপুনি যি জানে সেয়া কোৱাৰ এইটো কেৱল এটা উপায়। এয়া কোনো সিদ্ধান্ত নহয়, আৰু আপোনাৰ সংগীয়ে কি অনুভৱ কৰে বা কি বুজাব বিচাৰিছিল DuoSpace-এ জানিব নোৱাৰে। | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Assamese | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | তুমি ক'লা: “{x}”। | | | | | | |
| own | I take responsibility for this part: {x}. | এই অংশৰ দায়িত্ব মই লৈছোঁ: {x}। | | | | | | |
| apology | I'm sorry. | মোক ক্ষমা কৰিবা। | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | মই বুজিছোঁ যে এয়া তোমাৰ বাবে গুৰুত্বপূৰ্ণ, কিন্তু মোৰ এয়া বেলেগ ধৰণে মনত আছে। | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | যি ঘটিল তাৰ প্ৰতিটো ব্যাখ্যাৰ সৈতে মই একমত নহয়। | | | | | | |
| explain | From my side: {x}. | মোৰ ফালৰ পৰা: {x}। | | | | | | |
| nextTime | Next time, I can: {x}. | পিছৰ বাৰ মই এইটো কৰিব পাৰোঁ: {x}। | | | | | | |
| request | What would help me is: {x}. | মোক এইটোৱে সহায় কৰিব: {x}। | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | মই তোমাৰ অনুৰোধ বুজিছোঁ, কিন্তু মই ইয়াত সন্মতি দিব নোৱাৰোঁ: {x}। | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | যি ঘটিল তাৰ কোনটো কথা তোমাৰ বাবে আটাইতকৈ গুৰুত্বপূৰ্ণ আছিল? | | | | | | |

### Response-support templates
| Key | English source | Assamese | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | মই শুনিছোঁ। | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | মই এনেদৰে বুজিলোঁ: “{x}”। মই শুদ্ধকৈ বুজিছোঁনে? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | সেই সময়ত তোমাক কি কৰিলে ভাল লাগিলহেঁতেন? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | তুমি এই বিষয়ে কথা পাতিব বিচৰা নে, নে এতিয়া অলপ সময় অকলে থাকিব বিচৰা? | | | | | | |

**Romanized forms:** romanized Assamese is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

## Bengali (`bn`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | মারে | | | | | | | |
| THREAT_OR_VIOLENCE | মেরেছে | | | | | | | |
| THREAT_OR_VIOLENCE | মারধর | | | | | | | |
| THREAT_OR_VIOLENCE | চড় মার | | | | | | | |
| THREAT_OR_VIOLENCE | হুমকি | | | | | | | |
| THREAT_OR_VIOLENCE | মেরে ফেল | | | | | | | |
| THREAT_OR_VIOLENCE | ছুরি | | | | | | | |
| THREAT_OR_VIOLENCE | বন্দুক | | | | | | | |
| STALKING_OR_MONITORING | পিছু নেয় | | | | | | | |
| STALKING_OR_MONITORING | ফোন চেক | | | | | | | |
| STALKING_OR_MONITORING | লোকেশন ট্র্যাক | | | | | | | |
| ISOLATION | দেখা করতে দেয় না | | | | | | | |
| ISOLATION | কথা বলতে দেয় না | | | | | | | |
| ISOLATION | বাইরে যেতে দেয় না | | | | | | | |
| FINANCIAL_COERCION | টাকা কেড়ে | | | | | | | |
| FINANCIAL_COERCION | বেতন নিয়ে নেয় | | | | | | | |
| FINANCIAL_COERCION | টাকা দেয় না | | | | | | | |
| SEXUAL_COERCION | জোর করে | | | | | | | |
| BLACKMAIL | ব্ল্যাকমেইল | | | | | | | |
| BLACKMAIL | ছবি ছড়িয়ে | | | | | | | |
| BLACKMAIL | ভিডিও ছড়িয়ে | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | আত্মহত্যা করব | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | মরে যাব যদি | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | বাচ্চাদের মার | | | | | | | |
| IMMEDIATE_DANGER | বিপদে আছি | | | | | | | |
| IMMEDIATE_DANGER | এখনই বিপদ | | | | | | | |

### Safety guidance (shown when the safety gate trips)
| Key | English source | Bengali | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | এই পরিস্থিতিতে নিরাপত্তার উদ্বেগ থাকতে পারে | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace আপনার নিরাপত্তা মূল্যায়ন করতে পারে না, এবং এটা আপনার বা অন্য কারও সম্পর্কে কোনো রায় নয়। | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | আপনি যা লিখেছেন তার কারণে DuoSpace এখন আপনার সঙ্গীর জন্য কোনো বার্তা, কথোপকথন, ক্ষমা বা দেখা করার পরামর্শ দেবে না। | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | আপনি যদি তাৎক্ষণিক বিপদে থাকেন, আপনার স্থানীয় জরুরি নম্বরে যোগাযোগ করুন। | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | বিশ্বস্ত কারও সঙ্গে বা পারিবারিক সহিংসতা বিষয়ক কোনো স্থানীয় সহায়তা পরিষেবার সঙ্গে কথা বলা সাহায্য করতে পারে। | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | আপনি যেকোনো সময় এটা বন্ধ করতে পারেন। আপনি এখানে যা লিখেছেন তা সংরক্ষণ বা শেয়ার করা হয় না। | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | ভারতে জরুরি নম্বর 112। | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Bengali | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace এখনও এই ভাষার লেখার অর্থ বিশ্লেষণ করে না। আপনার শব্দগুলো যেমন লিখেছেন তেমনই দেখানো হয়েছে, এবং কোনো ব্যাখ্যা করা হয়নি। | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | এই শব্দগুলোর বাইরে আপনার সঙ্গী কী বোঝাতে চেয়েছিলেন: তা শুধু আপনার সঙ্গীই বলতে পারেন। | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | এ বিষয়ে আপনার সঙ্গীর কেমন লাগছে: এখানে বলা হয়নি। | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | আপনি যা জানেন তা বলার এটা শুধু একটা উপায়। এটা কোনো রায় নয়, এবং আপনার সঙ্গী কী অনুভব করেন বা কী বোঝাতে চেয়েছিলেন তা DuoSpace জানতে পারে না। | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Bengali | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | তুমি বলেছিলে: “{x}”। | | | | | | |
| own | I take responsibility for this part: {x}. | এই অংশের দায়িত্ব আমি নিচ্ছি: {x}। | | | | | | |
| apology | I'm sorry. | আমাকে ক্ষমা করো। | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | আমি বুঝি এটা তোমার কাছে গুরুত্বপূর্ণ ছিল, কিন্তু আমার এটা অন্যভাবে মনে আছে। | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | যা ঘটেছে তার প্রতিটি ব্যাখ্যার সঙ্গে আমি একমত নই। | | | | | | |
| explain | From my side: {x}. | আমার দিক থেকে: {x}। | | | | | | |
| nextTime | Next time, I can: {x}. | পরের বার আমি এটা করতে পারি: {x}। | | | | | | |
| request | What would help me is: {x}. | আমার জন্য এটা সাহায্য করবে: {x}। | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | আমি তোমার অনুরোধ বুঝি, কিন্তু আমি এতে রাজি হতে পারব না: {x}। | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | যা ঘটেছে তার মধ্যে তোমার কাছে সবচেয়ে গুরুত্বপূর্ণ কী ছিল? | | | | | | |

### Response-support templates
| Key | English source | Bengali | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | আমি শুনছি। | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | আমি এভাবে বুঝেছি: “{x}”। আমি কি ঠিক বুঝেছি? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | তখন কী করলে তোমার ভালো লাগত? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | তুমি কি এ নিয়ে কথা বলতে চাও, নাকি এখন একটু একা থাকতে চাও? | | | | | | |

**Romanized forms:** romanized Bengali is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

## Telugu (`te`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | కొడతాడు | | | | | | | |
| THREAT_OR_VIOLENCE | కొట్టాడు | | | | | | | |
| THREAT_OR_VIOLENCE | కొడుతుంది | | | | | | | |
| THREAT_OR_VIOLENCE | కొట్టింది | | | | | | | |
| THREAT_OR_VIOLENCE | బెదిరింపు | | | | | | | |
| THREAT_OR_VIOLENCE | బెదిరిస్తాడు | | | | | | | |
| THREAT_OR_VIOLENCE | బెదిరించాడు | | | | | | | |
| THREAT_OR_VIOLENCE | చంపేస్తా | | | | | | | |
| THREAT_OR_VIOLENCE | చంపుతా | | | | | | | |
| THREAT_OR_VIOLENCE | కత్తి | | | | | | | |
| STALKING_OR_MONITORING | వెంబడిస్తాడు | | | | | | | |
| STALKING_OR_MONITORING | ఫోన్ చెక్ | | | | | | | |
| STALKING_OR_MONITORING | లొకేషన్ ట్రాక్ | | | | | | | |
| ISOLATION | కలవనివ్వడు | | | | | | | |
| ISOLATION | మాట్లాడనివ్వడు | | | | | | | |
| ISOLATION | బయటకు వెళ్లనివ్వడు | | | | | | | |
| FINANCIAL_COERCION | డబ్బు లాక్కుంటాడు | | | | | | | |
| FINANCIAL_COERCION | జీతం తీసుకుంటాడు | | | | | | | |
| SEXUAL_COERCION | బలవంతంగా | | | | | | | |
| SEXUAL_COERCION | బలవంతం | | | | | | | |
| BLACKMAIL | బ్లాక్‌మెయిల్ | | | | | | | |
| BLACKMAIL | బ్లాక్మెయిల్ | | | | | | | |
| BLACKMAIL | ఫోటోలు వైరల్ | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | ఆత్మహత్య చేసుకుంటా | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | చచ్చిపోతా | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | పిల్లల్ని చంపు | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | పిల్లలను కొడ | | | | | | | |
| IMMEDIATE_DANGER | ప్రమాదంలో ఉన్నా | | | | | | | |
| IMMEDIATE_DANGER | ఇప్పుడే ప్రమాదం | | | | | | | |

### Safety guidance (shown when the safety gate trips)
| Key | English source | Telugu | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | ఈ పరిస్థితిలో భద్రతా సమస్య ఉండవచ్చు | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace మీ భద్రతను అంచనా వేయలేదు, మరియు ఇది మీ గురించి గానీ ఇంకెవరి గురించి గానీ తీర్పు కాదు. | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | మీరు రాసినదాని వల్ల DuoSpace ఇప్పుడు మీ భాగస్వామికి సందేశం, సంభాషణ, క్షమాపణ లేదా కలయికను సూచించదు. | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | మీరు వెంటనే ప్రమాదంలో ఉంటే, మీ స్థానిక అత్యవసర నంబర్‌ను సంప్రదించండి. | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | మీరు నమ్మే వ్యక్తితో లేదా గృహ హింసకు సంబంధించిన స్థానిక సహాయ సేవతో మాట్లాడటం సహాయపడవచ్చు. | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | మీరు దీన్ని ఎప్పుడైనా మూసివేయవచ్చు. మీరు ఇక్కడ రాసినది ఏదీ సేవ్ చేయబడదు లేదా పంచుకోబడదు. | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | భారతదేశంలో అత్యవసర నంబర్ 112. | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Telugu | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace ఇంకా ఈ భాషలోని వచనానికి అర్థం విశ్లేషించదు. మీ మాటలు మీరు రాసినట్లే చూపించబడ్డాయి, వాటికి ఎలాంటి అర్థం చెప్పలేదు. | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | ఈ మాటలకు మించి మీ భాగస్వామి ఉద్దేశం ఏమిటో: అది మీ భాగస్వామి మాత్రమే చెప్పగలరు. | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | దీని గురించి మీ భాగస్వామికి ఎలా అనిపిస్తోందో: ఇక్కడ చెప్పలేదు. | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | మీకు తెలిసినది చెప్పడానికి ఇది ఒక మార్గం మాత్రమే. ఇది తీర్పు కాదు, మరియు మీ భాగస్వామి ఏమి భావిస్తున్నారో లేదా ఏమి ఉద్దేశించారో DuoSpace తెలుసుకోలేదు. | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Telugu | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | నువ్వు అన్నావు: “{x}”. | | | | | | |
| own | I take responsibility for this part: {x}. | ఈ భాగానికి బాధ్యత నేను తీసుకుంటున్నాను: {x}. | | | | | | |
| apology | I'm sorry. | నన్ను క్షమించు. | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | ఇది నీకు ముఖ్యమని నాకు అర్థమైంది, కానీ నాకు ఇది వేరేలా గుర్తుంది. | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | జరిగినదాని ప్రతి అర్థంతో నేను ఏకీభవించను. | | | | | | |
| explain | From my side: {x}. | నా వైపు నుంచి: {x}. | | | | | | |
| nextTime | Next time, I can: {x}. | తర్వాతిసారి నేను ఇది చేయగలను: {x}. | | | | | | |
| request | What would help me is: {x}. | నాకు ఇది సహాయపడుతుంది: {x}. | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | నీ అభ్యర్థన నాకు అర్థమైంది, కానీ నేను దీనికి ఒప్పుకోలేను: {x}. | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | జరిగినదానిలో నీకు అత్యంత ముఖ్యమైనది ఏమిటి? | | | | | | |

### Response-support templates
| Key | English source | Telugu | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | నేను వింటున్నాను. | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | నేను ఇలా అర్థం చేసుకున్నాను: “{x}”. నేను సరిగ్గా అర్థం చేసుకున్నానా? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | ఆ సమయంలో నీకు ఏది సహాయంగా అనిపించేది? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | నువ్వు దీని గురించి మాట్లాడాలనుకుంటున్నావా, లేక ఇప్పుడు కొంచెం సమయం ఒంటరిగా ఉండాలనుకుంటున్నావా? | | | | | | |

**Romanized forms:** romanized Telugu is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

## Tamil (`ta`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | அடிக்கிறான் | | | | | | | |
| THREAT_OR_VIOLENCE | அடித்தான் | | | | | | | |
| THREAT_OR_VIOLENCE | அடிக்கிறாள் | | | | | | | |
| THREAT_OR_VIOLENCE | அடித்தாள் | | | | | | | |
| THREAT_OR_VIOLENCE | மிரட்டல் | | | | | | | |
| THREAT_OR_VIOLENCE | மிரட்டுகிறான் | | | | | | | |
| THREAT_OR_VIOLENCE | மிரட்டினான் | | | | | | | |
| THREAT_OR_VIOLENCE | கொன்றுவிடுவேன் | | | | | | | |
| THREAT_OR_VIOLENCE | கொல்லுவேன் | | | | | | | |
| THREAT_OR_VIOLENCE | கத்தி | | | | | | | |
| STALKING_OR_MONITORING | பின்தொடர்கிறான் | | | | | | | |
| STALKING_OR_MONITORING | போன் சோதனை | | | | | | | |
| STALKING_OR_MONITORING | போனை செக் | | | | | | | |
| STALKING_OR_MONITORING | லொகேஷன் டிராக் | | | | | | | |
| ISOLATION | சந்திக்க விடுவதில்லை | | | | | | | |
| ISOLATION | பேச விடுவதில்லை | | | | | | | |
| ISOLATION | வெளியே போக விடுவதில்லை | | | | | | | |
| FINANCIAL_COERCION | பணத்தை பறித்து | | | | | | | |
| FINANCIAL_COERCION | சம்பளத்தை எடுத்து | | | | | | | |
| SEXUAL_COERCION | கட்டாயப்படுத்தி | | | | | | | |
| SEXUAL_COERCION | வலுக்கட்டாயமாக | | | | | | | |
| BLACKMAIL | பிளாக்மெயில் | | | | | | | |
| BLACKMAIL | புகைப்படங்களை பரப்ப | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | தற்கொலை செய்துகொள்வேன் | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | செத்துவிடுவேன் | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | குழந்தைகளை அடி | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | குழந்தைகளை கொல் | | | | | | | |
| IMMEDIATE_DANGER | ஆபத்தில் இருக்கிறேன் | | | | | | | |
| IMMEDIATE_DANGER | இப்போது ஆபத்து | | | | | | | |

### Safety guidance (shown when the safety gate trips)
| Key | English source | Tamil | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | இந்தச் சூழ்நிலையில் பாதுகாப்பு சார்ந்த கவலை இருக்கலாம் | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace உங்கள் பாதுகாப்பை மதிப்பிட முடியாது; இது உங்களைப் பற்றியோ வேறு யாரைப் பற்றியோ தீர்ப்பு அல்ல. | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | நீங்கள் எழுதியதன் காரணமாக, DuoSpace இப்போது உங்கள் துணைக்கு செய்தி, உரையாடல், மன்னிப்பு அல்லது சந்திப்பு எதையும் பரிந்துரைக்காது. | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | நீங்கள் உடனடி ஆபத்தில் இருந்தால், உங்கள் உள்ளூர் அவசர எண்ணைத் தொடர்பு கொள்ளுங்கள். | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | நீங்கள் நம்பும் ஒருவரிடமோ, குடும்ப வன்முறை தொடர்பான உள்ளூர் உதவி சேவையிடமோ பேசுவது உதவக்கூடும். | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | இதை நீங்கள் எப்போது வேண்டுமானாலும் மூடலாம். நீங்கள் இங்கே எழுதியது எதுவும் சேமிக்கப்படுவதோ பகிரப்படுவதோ இல்லை. | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | இந்தியாவில் அவசர எண் 112. | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Tamil | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace இன்னும் இந்த மொழியில் உள்ள உரையின் பொருளை பகுப்பாய்வு செய்வதில்லை. உங்கள் வார்த்தைகள் நீங்கள் எழுதியபடியே காட்டப்படுகின்றன; எந்த விளக்கமும் சேர்க்கப்படவில்லை. | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | இந்த வார்த்தைகளைத் தாண்டி உங்கள் துணை என்ன சொல்ல வந்தார் என்பது: அதை உங்கள் துணை மட்டுமே விளக்க முடியும். | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | இதைப் பற்றி உங்கள் துணை எப்படி உணர்கிறார் என்பது: இங்கே சொல்லப்படவில்லை. | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | உங்களுக்குத் தெரிந்ததைச் சொல்ல இது ஒரு வழி மட்டுமே. இது தீர்ப்பு அல்ல; உங்கள் துணை என்ன உணர்கிறார் அல்லது என்ன சொல்ல வந்தார் என்பதை DuoSpace அறிய முடியாது. | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Tamil | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | நீ சொன்னாய்: “{x}”. | | | | | | |
| own | I take responsibility for this part: {x}. | இந்தப் பகுதிக்கான பொறுப்பை நான் ஏற்கிறேன்: {x}. | | | | | | |
| apology | I'm sorry. | என்னை மன்னித்துவிடு. | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | இது உனக்கு முக்கியம் என்று எனக்குப் புரிகிறது, ஆனால் எனக்கு இது வேறு விதமாக நினைவிருக்கிறது. | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | நடந்ததின் ஒவ்வொரு விளக்கத்துடனும் நான் உடன்படவில்லை. | | | | | | |
| explain | From my side: {x}. | என் பக்கத்திலிருந்து: {x}. | | | | | | |
| nextTime | Next time, I can: {x}. | அடுத்த முறை நான் இதைச் செய்ய முடியும்: {x}. | | | | | | |
| request | What would help me is: {x}. | எனக்கு இது உதவியாக இருக்கும்: {x}. | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | உன் கோரிக்கை எனக்குப் புரிகிறது, ஆனால் என்னால் இதற்கு ஒப்புக்கொள்ள முடியாது: {x}. | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | நடந்ததில் உனக்கு மிக முக்கியமாக இருந்தது எது? | | | | | | |

### Response-support templates
| Key | English source | Tamil | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | நான் கேட்கிறேன். | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | நான் இப்படிப் புரிந்துகொண்டேன்: “{x}”. நான் சரியாகப் புரிந்துகொண்டேனா? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | அந்த நேரத்தில் உனக்கு எது உதவியாக இருந்திருக்கும்? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | இதைப் பற்றி பேச விரும்புகிறாயா, அல்லது இப்போது கொஞ்சம் தனியாக இருக்க விரும்புகிறாயா? | | | | | | |

**Romanized forms:** romanized Tamil is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

## Kannada (`kn`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | ಹೊಡೆಯುತ್ತಾನೆ | | | | | | | |
| THREAT_OR_VIOLENCE | ಹೊಡೆದ | | | | | | | |
| THREAT_OR_VIOLENCE | ಹೊಡೆಯುತ್ತಾಳೆ | | | | | | | |
| THREAT_OR_VIOLENCE | ಬೆದರಿಕೆ | | | | | | | |
| THREAT_OR_VIOLENCE | ಕೊಲ್ಲುತ್ತೇನೆ | | | | | | | |
| THREAT_OR_VIOLENCE | ಚಾಕು | | | | | | | |
| STALKING_OR_MONITORING | ಹಿಂಬಾಲಿಸುತ್ತಾನೆ | | | | | | | |
| STALKING_OR_MONITORING | ಫೋನ್ ಚೆಕ್ | | | | | | | |
| ISOLATION | ಭೇಟಿಯಾಗಲು ಬಿಡುವುದಿಲ್ಲ | | | | | | | |
| ISOLATION | ಮಾತನಾಡಲು ಬಿಡುವುದಿಲ್ಲ | | | | | | | |
| FINANCIAL_COERCION | ಹಣ ಕಿತ್ತುಕೊಳ್ಳುತ್ತಾನೆ | | | | | | | |
| FINANCIAL_COERCION | ಸಂಬಳ ತೆಗೆದುಕೊಳ್ಳುತ್ತಾನೆ | | | | | | | |
| SEXUAL_COERCION | ಬಲವಂತವಾಗಿ | | | | | | | |
| SEXUAL_COERCION | ಬಲವಂತ | | | | | | | |
| BLACKMAIL | ಬ್ಲ್ಯಾಕ್‌ಮೇಲ್ | | | | | | | |
| BLACKMAIL | ಬ್ಲ್ಯಾಕ್ಮೇಲ್ | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | ಆತ್ಮಹತ್ಯೆ ಮಾಡಿಕೊಳ್ಳುತ್ತೇನೆ | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | ಮಕ್ಕಳನ್ನು ಹೊಡೆ | | | | | | | |
| IMMEDIATE_DANGER | ಅಪಾಯದಲ್ಲಿದ್ದೇನೆ | | | | | | | |
| IMMEDIATE_DANGER | ಈಗ ಅಪಾಯ | | | | | | | |

### Safety guidance (shown when the safety gate trips)
| Key | English source | Kannada | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | ಈ ಪರಿಸ್ಥಿತಿಯಲ್ಲಿ ಸುರಕ್ಷತೆಯ ಕಾಳಜಿ ಇರಬಹುದು | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace ನಿಮ್ಮ ಸುರಕ್ಷತೆಯನ್ನು ಅಂದಾಜಿಸಲಾರದು, ಮತ್ತು ಇದು ನಿಮ್ಮ ಅಥವಾ ಬೇರೆಯವರ ಬಗ್ಗೆ ತೀರ್ಪಲ್ಲ. | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | ನೀವು ಬರೆದದ್ದರ ಕಾರಣ, DuoSpace ಈಗ ನಿಮ್ಮ ಸಂಗಾತಿಗೆ ಸಂದೇಶ, ಮಾತುಕತೆ, ಕ್ಷಮೆ ಅಥವಾ ಭೇಟಿಯನ್ನು ಸೂಚಿಸುವುದಿಲ್ಲ. | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | ನೀವು ತಕ್ಷಣದ ಅಪಾಯದಲ್ಲಿದ್ದರೆ, ನಿಮ್ಮ ಸ್ಥಳೀಯ ತುರ್ತು ಸಂಖ್ಯೆಯನ್ನು ಸಂಪರ್ಕಿಸಿ. | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | ನೀವು ನಂಬುವ ವ್ಯಕ್ತಿಯೊಂದಿಗೆ ಅಥವಾ ಕೌಟುಂಬಿಕ ಹಿಂಸೆಗೆ ಸಂಬಂಧಿಸಿದ ಸ್ಥಳೀಯ ಸಹಾಯ ಸೇವೆಯೊಂದಿಗೆ ಮಾತನಾಡುವುದು ಸಹಾಯ ಮಾಡಬಹುದು. | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | ನೀವು ಇದನ್ನು ಯಾವಾಗ ಬೇಕಾದರೂ ಮುಚ್ಚಬಹುದು. ನೀವು ಇಲ್ಲಿ ಬರೆದ ಯಾವುದೂ ಉಳಿಸಲಾಗುವುದಿಲ್ಲ ಅಥವಾ ಹಂಚಿಕೊಳ್ಳಲಾಗುವುದಿಲ್ಲ. | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | ಭಾರತದಲ್ಲಿ ತುರ್ತು ಸಂಖ್ಯೆ 112. | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Kannada | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace ಇನ್ನೂ ಈ ಭಾಷೆಯ ಪಠ್ಯದ ಅರ್ಥವನ್ನು ವಿಶ್ಲೇಷಿಸುವುದಿಲ್ಲ. ನಿಮ್ಮ ಮಾತುಗಳನ್ನು ನೀವು ಬರೆದಂತೆಯೇ ತೋರಿಸಲಾಗಿದೆ, ಯಾವುದೇ ಅರ್ಥ ಹೇಳಿಲ್ಲ. | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | ಈ ಮಾತುಗಳನ್ನು ಮೀರಿ ನಿಮ್ಮ ಸಂಗಾತಿಯ ಉದ್ದೇಶವೇನು ಎಂಬುದು: ಅದನ್ನು ನಿಮ್ಮ ಸಂಗಾತಿ ಮಾತ್ರ ಹೇಳಬಲ್ಲರು. | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | ಈ ಬಗ್ಗೆ ನಿಮ್ಮ ಸಂಗಾತಿಗೆ ಹೇಗನಿಸುತ್ತದೆ ಎಂಬುದು: ಇಲ್ಲಿ ಹೇಳಿಲ್ಲ. | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | ನಿಮಗೆ ತಿಳಿದಿರುವುದನ್ನು ಹೇಳಲು ಇದು ಒಂದು ದಾರಿ ಮಾತ್ರ. ಇದು ತೀರ್ಪಲ್ಲ, ಮತ್ತು ನಿಮ್ಮ ಸಂಗಾತಿ ಏನು ಅನುಭವಿಸುತ್ತಾರೆ ಅಥವಾ ಏನು ಉದ್ದೇಶಿಸಿದ್ದರು ಎಂಬುದು DuoSpace ಗೆ ತಿಳಿಯಲಾರದು. | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Kannada | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | ನೀನು ಹೇಳಿದೆ: “{x}”. | | | | | | |
| own | I take responsibility for this part: {x}. | ಈ ಭಾಗದ ಜವಾಬ್ದಾರಿಯನ್ನು ನಾನು ತೆಗೆದುಕೊಳ್ಳುತ್ತೇನೆ: {x}. | | | | | | |
| apology | I'm sorry. | ನನ್ನನ್ನು ಕ್ಷಮಿಸು. | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | ಇದು ನಿನಗೆ ಮುಖ್ಯವಾಗಿತ್ತು ಎಂದು ನನಗೆ ಅರ್ಥವಾಗುತ್ತದೆ, ಆದರೆ ನನಗೆ ಇದು ಬೇರೆ ರೀತಿಯಲ್ಲಿ ನೆನಪಿದೆ. | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | ನಡೆದದ್ದರ ಪ್ರತಿಯೊಂದು ಅರ್ಥೈಸುವಿಕೆಗೂ ನಾನು ಒಪ್ಪುವುದಿಲ್ಲ. | | | | | | |
| explain | From my side: {x}. | ನನ್ನ ಕಡೆಯಿಂದ: {x}. | | | | | | |
| nextTime | Next time, I can: {x}. | ಮುಂದಿನ ಬಾರಿ ನಾನು ಇದನ್ನು ಮಾಡಬಲ್ಲೆ: {x}. | | | | | | |
| request | What would help me is: {x}. | ನನಗೆ ಇದು ಸಹಾಯ ಮಾಡುತ್ತದೆ: {x}. | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | ನಿನ್ನ ಕೋರಿಕೆ ನನಗೆ ಅರ್ಥವಾಗುತ್ತದೆ, ಆದರೆ ನಾನು ಇದಕ್ಕೆ ಒಪ್ಪಲಾರೆ: {x}. | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | ನಡೆದದ್ದರಲ್ಲಿ ನಿನಗೆ ಅತ್ಯಂತ ಮುಖ್ಯವಾಗಿದ್ದು ಏನು? | | | | | | |

### Response-support templates
| Key | English source | Kannada | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | ನಾನು ಕೇಳುತ್ತಿದ್ದೇನೆ. | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | ನಾನು ಹೀಗೆ ಅರ್ಥಮಾಡಿಕೊಂಡೆ: “{x}”. ನಾನು ಸರಿಯಾಗಿ ಅರ್ಥಮಾಡಿಕೊಂಡೆನಾ? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | ಆ ಸಮಯದಲ್ಲಿ ನಿನಗೆ ಯಾವುದು ಸಹಾಯಕವಾಗುತ್ತಿತ್ತು? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | ನೀನು ಇದರ ಬಗ್ಗೆ ಮಾತನಾಡಲು ಬಯಸುತ್ತೀಯಾ, ಅಥವಾ ಈಗ ಸ್ವಲ್ಪ ಸಮಯ ಒಬ್ಬಂಟಿಯಾಗಿರಲು ಬಯಸುತ್ತೀಯಾ? | | | | | | |

**Romanized forms:** romanized Kannada is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

## Malayalam (`ml`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | അടിക്കും | | | | | | | |
| THREAT_OR_VIOLENCE | അടിച്ചു | | | | | | | |
| THREAT_OR_VIOLENCE | തല്ലി | | | | | | | |
| THREAT_OR_VIOLENCE | തല്ലും | | | | | | | |
| THREAT_OR_VIOLENCE | ഭീഷണി | | | | | | | |
| THREAT_OR_VIOLENCE | കൊല്ലും | | | | | | | |
| THREAT_OR_VIOLENCE | കത്തി | | | | | | | |
| STALKING_OR_MONITORING | പിന്തുടരുന്നു | | | | | | | |
| STALKING_OR_MONITORING | ഫോൺ പരിശോധിക്കും | | | | | | | |
| STALKING_OR_MONITORING | ഫോൺ ചെക്ക് | | | | | | | |
| ISOLATION | കാണാൻ അനുവദിക്കില്ല | | | | | | | |
| ISOLATION | സംസാരിക്കാൻ അനുവദിക്കില്ല | | | | | | | |
| FINANCIAL_COERCION | പണം പിടിച്ചുവാങ്ങ | | | | | | | |
| FINANCIAL_COERCION | ശമ്പളം എടുക്കും | | | | | | | |
| SEXUAL_COERCION | നിർബന്ധിച്ച് | | | | | | | |
| SEXUAL_COERCION | ബലമായി | | | | | | | |
| BLACKMAIL | ബ്ലാക്ക്മെയിൽ | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | ആത്മഹത്യ ചെയ്യും | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | കുട്ടികളെ തല്ല | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | കുട്ടികളെ കൊല്ല | | | | | | | |
| IMMEDIATE_DANGER | അപകടത്തിലാണ് | | | | | | | |
| IMMEDIATE_DANGER | ഇപ്പോൾ അപകടം | | | | | | | |

### Safety guidance (shown when the safety gate trips)
| Key | English source | Malayalam | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | ഈ സാഹചര്യത്തിൽ സുരക്ഷാ ആശങ്ക ഉണ്ടാകാം | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace-ന് നിങ്ങളുടെ സുരക്ഷ വിലയിരുത്താൻ കഴിയില്ല, ഇത് നിങ്ങളെക്കുറിച്ചോ മറ്റാരെയെങ്കിലും കുറിച്ചോ ഉള്ള വിധിയല്ല. | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | നിങ്ങൾ എഴുതിയത് കാരണം, DuoSpace ഇപ്പോൾ നിങ്ങളുടെ പങ്കാളിക്ക് സന്ദേശമോ സംഭാഷണമോ ക്ഷമാപണമോ കൂടിക്കാഴ്ചയോ നിർദ്ദേശിക്കില്ല. | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | നിങ്ങൾ അടിയന്തര അപകടത്തിലാണെങ്കിൽ, നിങ്ങളുടെ പ്രാദേശിക അടിയന്തര നമ്പറുമായി ബന്ധപ്പെടുക. | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | നിങ്ങൾ വിശ്വസിക്കുന്ന ഒരാളോടോ ഗാർഹിക പീഡനവുമായി ബന്ധപ്പെട്ട പ്രാദേശിക സഹായ സേവനത്തോടോ സംസാരിക്കുന്നത് സഹായിച്ചേക്കാം. | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | നിങ്ങൾക്ക് ഇത് എപ്പോൾ വേണമെങ്കിലും അടയ്ക്കാം. നിങ്ങൾ ഇവിടെ എഴുതിയതൊന്നും സേവ് ചെയ്യുകയോ പങ്കിടുകയോ ഇല്ല. | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | ഇന്ത്യയിൽ അടിയന്തര നമ്പർ 112 ആണ്. | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Malayalam | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace ഇതുവരെ ഈ ഭാഷയിലെ എഴുത്തിന്റെ അർത്ഥം വിശകലനം ചെയ്യുന്നില്ല. നിങ്ങളുടെ വാക്കുകൾ നിങ്ങൾ എഴുതിയതുപോലെ തന്നെ കാണിച്ചിരിക്കുന്നു, ഒരു വ്യാഖ്യാനവും ചേർത്തിട്ടില്ല. | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | ഈ വാക്കുകൾക്കപ്പുറം നിങ്ങളുടെ പങ്കാളി എന്താണ് ഉദ്ദേശിച്ചത്: അത് നിങ്ങളുടെ പങ്കാളിക്ക് മാത്രമേ പറയാൻ കഴിയൂ. | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | ഇതിനെക്കുറിച്ച് നിങ്ങളുടെ പങ്കാളിക്ക് എങ്ങനെ തോന്നുന്നു: ഇവിടെ പറഞ്ഞിട്ടില്ല. | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | നിങ്ങൾക്കറിയാവുന്നത് പറയാനുള്ള ഒരു വഴി മാത്രമാണിത്. ഇതൊരു വിധിയല്ല; നിങ്ങളുടെ പങ്കാളി എന്ത് അനുഭവിക്കുന്നു അല്ലെങ്കിൽ എന്ത് ഉദ്ദേശിച്ചു എന്ന് DuoSpace-ന് അറിയാൻ കഴിയില്ല. | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Malayalam | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | നീ പറഞ്ഞു: “{x}”. | | | | | | |
| own | I take responsibility for this part: {x}. | ഈ ഭാഗത്തിന്റെ ഉത്തരവാദിത്തം ഞാൻ ഏറ്റെടുക്കുന്നു: {x}. | | | | | | |
| apology | I'm sorry. | എന്നോട് ക്ഷമിക്കൂ. | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | ഇത് നിനക്ക് പ്രധാനമായിരുന്നുവെന്ന് എനിക്ക് മനസ്സിലാകുന്നു, പക്ഷേ എനിക്ക് ഇത് വ്യത്യസ്തമായാണ് ഓർമ്മ. | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | സംഭവിച്ചതിന്റെ എല്ലാ വ്യാഖ്യാനങ്ങളോടും ഞാൻ യോജിക്കുന്നില്ല. | | | | | | |
| explain | From my side: {x}. | എന്റെ ഭാഗത്തുനിന്ന്: {x}. | | | | | | |
| nextTime | Next time, I can: {x}. | അടുത്ത തവണ എനിക്ക് ഇത് ചെയ്യാൻ കഴിയും: {x}. | | | | | | |
| request | What would help me is: {x}. | എനിക്ക് ഇത് സഹായകരമാകും: {x}. | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | നിന്റെ അഭ്യർത്ഥന എനിക്ക് മനസ്സിലാകുന്നു, പക്ഷേ എനിക്ക് ഇതിന് സമ്മതിക്കാൻ കഴിയില്ല: {x}. | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | സംഭവിച്ചതിൽ നിനക്ക് ഏറ്റവും പ്രധാനമായിരുന്നത് എന്താണ്? | | | | | | |

### Response-support templates
| Key | English source | Malayalam | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | ഞാൻ കേൾക്കുന്നുണ്ട്. | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | ഞാൻ ഇങ്ങനെയാണ് മനസ്സിലാക്കിയത്: “{x}”. ഞാൻ ശരിയായി മനസ്സിലാക്കിയോ? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | ആ സമയത്ത് നിനക്ക് എന്താണ് സഹായകരമാകുമായിരുന്നത്? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | നിനക്ക് ഇതിനെക്കുറിച്ച് സംസാരിക്കണോ, അതോ ഇപ്പോൾ കുറച്ച് സമയം ഒറ്റയ്ക്കിരിക്കണോ? | | | | | | |

**Romanized forms:** romanized Malayalam is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

## Gujarati (`gu`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | મારે છે | | | | | | | |
| THREAT_OR_VIOLENCE | માર્યો | | | | | | | |
| THREAT_OR_VIOLENCE | માર્યું | | | | | | | |
| THREAT_OR_VIOLENCE | માર મારે | | | | | | | |
| THREAT_OR_VIOLENCE | થપ્પડ | | | | | | | |
| THREAT_OR_VIOLENCE | ધમકી | | | | | | | |
| THREAT_OR_VIOLENCE | જાનથી મારી | | | | | | | |
| THREAT_OR_VIOLENCE | છરી | | | | | | | |
| STALKING_OR_MONITORING | પીછો કરે | | | | | | | |
| STALKING_OR_MONITORING | ફોન ચેક | | | | | | | |
| ISOLATION | મળવા નથી દેતો | | | | | | | |
| ISOLATION | મળવા નથી દેતી | | | | | | | |
| ISOLATION | વાત કરવા નથી દેતો | | | | | | | |
| FINANCIAL_COERCION | પૈસા છીનવી | | | | | | | |
| FINANCIAL_COERCION | પગાર લઈ લે | | | | | | | |
| SEXUAL_COERCION | જબરદસ્તી | | | | | | | |
| BLACKMAIL | બ્લેકમેલ | | | | | | | |
| BLACKMAIL | ફોટો વાયરલ | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | આત્મહત્યા કરી લઈશ | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | જીવ આપી દઈશ | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | બાળકોને માર | | | | | | | |
| IMMEDIATE_DANGER | જોખમમાં છું | | | | | | | |
| IMMEDIATE_DANGER | અત્યારે જોખમ | | | | | | | |

### Safety guidance (shown when the safety gate trips)
| Key | English source | Gujarati | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | આ પરિસ્થિતિમાં સલામતીની ચિંતા હોઈ શકે છે | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace તમારી સલામતીનું મૂલ્યાંકન કરી શકતું નથી, અને આ તમારા કે બીજા કોઈ વિશે ચુકાદો નથી. | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | તમે જે લખ્યું છે તેના કારણે DuoSpace હમણાં તમારા સાથી માટે સંદેશ, વાતચીત, માફી કે મુલાકાતનું સૂચન નહીં કરે. | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | જો તમે તાત્કાલિક જોખમમાં હો, તો તમારા સ્થાનિક કટોકટી નંબરનો સંપર્ક કરો. | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | વિશ્વાસુ વ્યક્તિ સાથે અથવા ઘરેલુ હિંસા સંબંધિત સ્થાનિક સહાય સેવા સાથે વાત કરવાથી મદદ મળી શકે. | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | તમે આ ગમે ત્યારે બંધ કરી શકો છો. તમે અહીં લખેલું કંઈ સાચવવામાં કે શેર કરવામાં આવતું નથી. | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | ભારતમાં કટોકટી નંબર 112 છે. | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Gujarati | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace હજુ આ ભાષાના લખાણનો અર્થ વિશ્લેષિત કરતું નથી. તમારા શબ્દો તમે લખ્યા તે જ રીતે બતાવ્યા છે, અને કોઈ અર્થઘટન કરવામાં આવ્યું નથી. | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | આ શબ્દો ઉપરાંત તમારા સાથીનો શું અર્થ હતો: તે ફક્ત તમારા સાથી જ કહી શકે. | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | આ વિશે તમારા સાથીને કેવું લાગે છે: અહીં જણાવ્યું નથી. | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | તમે જે જાણો છો તે કહેવાનો આ ફક્ત એક રસ્તો છે. આ કોઈ ચુકાદો નથી, અને તમારા સાથી શું અનુભવે છે કે તેમનો શું અર્થ હતો તે DuoSpace જાણી શકતું નથી. | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Gujarati | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | તેં કહ્યું: “{x}”. | | | | | | |
| own | I take responsibility for this part: {x}. | આ ભાગની જવાબદારી હું લઉં છું: {x}. | | | | | | |
| apology | I'm sorry. | મને માફ કરજે. | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | હું સમજું છું કે આ તારા માટે મહત્વનું હતું, પણ મને આ અલગ રીતે યાદ છે. | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | જે થયું તેના દરેક અર્થઘટન સાથે હું સહમત નથી. | | | | | | |
| explain | From my side: {x}. | મારી બાજુથી: {x}. | | | | | | |
| nextTime | Next time, I can: {x}. | આવતી વખતે હું આ કરી શકું: {x}. | | | | | | |
| request | What would help me is: {x}. | મને આનાથી મદદ મળશે: {x}. | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | હું તારી વિનંતી સમજું છું, પણ હું આ માટે હા નહીં પાડી શકું: {x}. | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | જે થયું તેમાં તારા માટે સૌથી મહત્વનું શું હતું? | | | | | | |

### Response-support templates
| Key | English source | Gujarati | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | હું સાંભળું છું. | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | મેં આ રીતે સમજ્યું: “{x}”. શું મેં સાચું સમજ્યું? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | તે સમયે તને શું મદદરૂપ લાગ્યું હોત? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | શું તું આ વિશે વાત કરવા માંગે છે, કે હમણાં થોડો સમય એકલા રહેવા માંગે છે? | | | | | | |

**Romanized forms:** romanized Gujarati is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

## Punjabi (`pa`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | ਮਾਰਦਾ | | | | | | | |
| THREAT_OR_VIOLENCE | ਮਾਰਦੀ | | | | | | | |
| THREAT_OR_VIOLENCE | ਕੁੱਟਦਾ | | | | | | | |
| THREAT_OR_VIOLENCE | ਕੁੱਟਿਆ | | | | | | | |
| THREAT_OR_VIOLENCE | ਧਮਕੀ | | | | | | | |
| THREAT_OR_VIOLENCE | ਜਾਨੋਂ ਮਾਰ | | | | | | | |
| THREAT_OR_VIOLENCE | ਚਾਕੂ | | | | | | | |
| STALKING_OR_MONITORING | ਪਿੱਛਾ ਕਰਦਾ | | | | | | | |
| STALKING_OR_MONITORING | ਫ਼ੋਨ ਚੈੱਕ | | | | | | | |
| STALKING_OR_MONITORING | ਫੋਨ ਚੈੱਕ | | | | | | | |
| ISOLATION | ਮਿਲਣ ਨਹੀਂ ਦਿੰਦਾ | | | | | | | |
| ISOLATION | ਮਿਲਣ ਨਹੀਂ ਦਿੰਦੀ | | | | | | | |
| FINANCIAL_COERCION | ਪੈਸੇ ਖੋਹ | | | | | | | |
| FINANCIAL_COERCION | ਤਨਖਾਹ ਲੈ ਲੈਂਦਾ | | | | | | | |
| SEXUAL_COERCION | ਜ਼ਬਰਦਸਤੀ | | | | | | | |
| SEXUAL_COERCION | ਜਬਰਦਸਤੀ | | | | | | | |
| BLACKMAIL | ਬਲੈਕਮੇਲ | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | ਖ਼ੁਦਕੁਸ਼ੀ ਕਰ ਲਵਾਂਗਾ | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | ਖੁਦਕੁਸ਼ੀ ਕਰ ਲਵਾਂਗਾ | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | ਬੱਚਿਆਂ ਨੂੰ ਮਾਰ | | | | | | | |
| IMMEDIATE_DANGER | ਖ਼ਤਰੇ ਵਿੱਚ ਹਾਂ | | | | | | | |
| IMMEDIATE_DANGER | ਖਤਰੇ ਵਿੱਚ ਹਾਂ | | | | | | | |

### Safety guidance (shown when the safety gate trips)
| Key | English source | Punjabi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | ਇਸ ਸਥਿਤੀ ਵਿੱਚ ਸੁਰੱਖਿਆ ਦੀ ਚਿੰਤਾ ਹੋ ਸਕਦੀ ਹੈ | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace ਤੁਹਾਡੀ ਸੁਰੱਖਿਆ ਦਾ ਮੁਲਾਂਕਣ ਨਹੀਂ ਕਰ ਸਕਦਾ, ਅਤੇ ਇਹ ਤੁਹਾਡੇ ਜਾਂ ਕਿਸੇ ਹੋਰ ਬਾਰੇ ਕੋਈ ਫ਼ੈਸਲਾ ਨਹੀਂ ਹੈ। | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | ਤੁਸੀਂ ਜੋ ਲਿਖਿਆ ਹੈ ਉਸ ਕਰਕੇ DuoSpace ਹੁਣ ਤੁਹਾਡੇ ਸਾਥੀ ਲਈ ਕੋਈ ਸੁਨੇਹਾ, ਗੱਲਬਾਤ, ਮਾਫ਼ੀ ਜਾਂ ਮੁਲਾਕਾਤ ਦਾ ਸੁਝਾਅ ਨਹੀਂ ਦੇਵੇਗਾ। | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | ਜੇ ਤੁਸੀਂ ਤੁਰੰਤ ਖ਼ਤਰੇ ਵਿੱਚ ਹੋ, ਤਾਂ ਆਪਣੇ ਸਥਾਨਕ ਐਮਰਜੈਂਸੀ ਨੰਬਰ 'ਤੇ ਸੰਪਰਕ ਕਰੋ। | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | ਕਿਸੇ ਭਰੋਸੇਮੰਦ ਵਿਅਕਤੀ ਨਾਲ ਜਾਂ ਘਰੇਲੂ ਹਿੰਸਾ ਨਾਲ ਸਬੰਧਤ ਸਥਾਨਕ ਸਹਾਇਤਾ ਸੇਵਾ ਨਾਲ ਗੱਲ ਕਰਨਾ ਮਦਦ ਕਰ ਸਕਦਾ ਹੈ। | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | ਤੁਸੀਂ ਇਸ ਨੂੰ ਕਦੇ ਵੀ ਬੰਦ ਕਰ ਸਕਦੇ ਹੋ। ਤੁਸੀਂ ਇੱਥੇ ਜੋ ਲਿਖਿਆ ਉਹ ਨਾ ਸੇਵ ਹੁੰਦਾ ਹੈ ਨਾ ਸਾਂਝਾ ਕੀਤਾ ਜਾਂਦਾ ਹੈ। | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | ਭਾਰਤ ਵਿੱਚ ਐਮਰਜੈਂਸੀ ਨੰਬਰ 112 ਹੈ। | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Punjabi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace ਹਾਲੇ ਇਸ ਭਾਸ਼ਾ ਦੀ ਲਿਖਤ ਦਾ ਅਰਥ ਨਹੀਂ ਕੱਢਦਾ। ਤੁਹਾਡੇ ਸ਼ਬਦ ਉਵੇਂ ਹੀ ਦਿਖਾਏ ਗਏ ਹਨ ਜਿਵੇਂ ਤੁਸੀਂ ਲਿਖੇ, ਅਤੇ ਕੋਈ ਵਿਆਖਿਆ ਨਹੀਂ ਕੀਤੀ ਗਈ। | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | ਇਨ੍ਹਾਂ ਸ਼ਬਦਾਂ ਤੋਂ ਅੱਗੇ ਤੁਹਾਡੇ ਸਾਥੀ ਦਾ ਕੀ ਮਤਲਬ ਸੀ: ਇਹ ਸਿਰਫ਼ ਤੁਹਾਡਾ ਸਾਥੀ ਹੀ ਦੱਸ ਸਕਦਾ ਹੈ। | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | ਇਸ ਬਾਰੇ ਤੁਹਾਡੇ ਸਾਥੀ ਨੂੰ ਕਿਵੇਂ ਲੱਗਦਾ ਹੈ: ਇੱਥੇ ਨਹੀਂ ਦੱਸਿਆ ਗਿਆ। | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | ਇਹ ਤੁਹਾਡੀ ਗੱਲ ਕਹਿਣ ਦਾ ਸਿਰਫ਼ ਇੱਕ ਤਰੀਕਾ ਹੈ। ਇਹ ਕੋਈ ਫ਼ੈਸਲਾ ਨਹੀਂ, ਅਤੇ DuoSpace ਨਹੀਂ ਜਾਣ ਸਕਦਾ ਕਿ ਤੁਹਾਡਾ ਸਾਥੀ ਕੀ ਮਹਿਸੂਸ ਕਰਦਾ ਹੈ ਜਾਂ ਉਸ ਦਾ ਕੀ ਮਤਲਬ ਸੀ। | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Punjabi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | ਤੂੰ ਕਿਹਾ: “{x}”। | | | | | | |
| own | I take responsibility for this part: {x}. | ਇਸ ਹਿੱਸੇ ਦੀ ਜ਼ਿੰਮੇਵਾਰੀ ਮੈਂ ਲੈਂਦਾ/ਲੈਂਦੀ ਹਾਂ: {x}। | | | | | | |
| apology | I'm sorry. | ਮੈਨੂੰ ਮਾਫ਼ ਕਰੀਂ। | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | ਮੈਂ ਸਮਝਦਾ/ਸਮਝਦੀ ਹਾਂ ਕਿ ਇਹ ਤੇਰੇ ਲਈ ਮਾਇਨੇ ਰੱਖਦਾ ਸੀ, ਪਰ ਮੈਨੂੰ ਇਹ ਵੱਖਰੀ ਤਰ੍ਹਾਂ ਯਾਦ ਹੈ। | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | ਜੋ ਹੋਇਆ ਉਸ ਦੀ ਹਰ ਵਿਆਖਿਆ ਨਾਲ ਮੈਂ ਸਹਿਮਤ ਨਹੀਂ ਹਾਂ। | | | | | | |
| explain | From my side: {x}. | ਮੇਰੇ ਪਾਸਿਓਂ: {x}। | | | | | | |
| nextTime | Next time, I can: {x}. | ਅਗਲੀ ਵਾਰ ਮੈਂ ਇਹ ਕਰ ਸਕਦਾ/ਸਕਦੀ ਹਾਂ: {x}। | | | | | | |
| request | What would help me is: {x}. | ਮੇਰੇ ਲਈ ਇਹ ਮਦਦਗਾਰ ਹੋਵੇਗਾ: {x}। | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | ਮੈਂ ਤੇਰੀ ਬੇਨਤੀ ਸਮਝਦਾ/ਸਮਝਦੀ ਹਾਂ, ਪਰ ਮੈਂ ਇਸ ਲਈ ਹਾਂ ਨਹੀਂ ਕਹਿ ਸਕਦਾ/ਸਕਦੀ: {x}। | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | ਜੋ ਹੋਇਆ ਉਸ ਵਿੱਚ ਤੇਰੇ ਲਈ ਸਭ ਤੋਂ ਜ਼ਿਆਦਾ ਕੀ ਮਾਇਨੇ ਰੱਖਦਾ ਸੀ? | | | | | | |

### Response-support templates
| Key | English source | Punjabi | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | ਮੈਂ ਸੁਣ ਰਿਹਾ/ਰਹੀ ਹਾਂ। | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | ਮੈਂ ਇਸ ਤਰ੍ਹਾਂ ਸਮਝਿਆ: “{x}”। ਕੀ ਮੈਂ ਸਹੀ ਸਮਝਿਆ? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | ਉਸ ਵੇਲੇ ਤੈਨੂੰ ਕੀ ਮਦਦਗਾਰ ਲੱਗਦਾ? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | ਕੀ ਤੂੰ ਇਸ ਬਾਰੇ ਗੱਲ ਕਰਨਾ ਚਾਹੁੰਦਾ/ਚਾਹੁੰਦੀ ਹੈਂ, ਜਾਂ ਹੁਣ ਥੋੜ੍ਹਾ ਸਮਾਂ ਇਕੱਲੇ ਰਹਿਣਾ ਚਾਹੁੰਦਾ/ਚਾਹੁੰਦੀ ਹੈਂ? | | | | | | |

**Romanized forms:** romanized Punjabi is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

## Odia (`or`) — NOT_REVIEWED

### Safety phrases
| Category | Phrase | A | B | C–F | H false-positive examples | I missing forms | J dialect | Decision |
|---|---|---|---|---|---|---|---|---|
| THREAT_OR_VIOLENCE | ମାରେ | | | | | | | |
| THREAT_OR_VIOLENCE | ମାରିଲା | | | | | | | |
| THREAT_OR_VIOLENCE | ମାଡ଼ ମାରେ | | | | | | | |
| THREAT_OR_VIOLENCE | ଧମକ | | | | | | | |
| THREAT_OR_VIOLENCE | ମାରିଦେବି | | | | | | | |
| THREAT_OR_VIOLENCE | ଛୁରୀ | | | | | | | |
| STALKING_OR_MONITORING | ପିଛା କରେ | | | | | | | |
| STALKING_OR_MONITORING | ଫୋନ ଚେକ | | | | | | | |
| ISOLATION | ଦେଖା କରିବାକୁ ଦିଏନି | | | | | | | |
| ISOLATION | କଥା ହେବାକୁ ଦିଏନି | | | | | | | |
| FINANCIAL_COERCION | ଟଙ୍କା ଛଡ଼େଇ | | | | | | | |
| FINANCIAL_COERCION | ଦରମା ନେଇଯାଏ | | | | | | | |
| SEXUAL_COERCION | ଜବରଦସ୍ତି | | | | | | | |
| BLACKMAIL | ବ୍ଲାକମେଲ | | | | | | | |
| SELF_HARM_THREAT_AS_CONTROL | ଆତ୍ମହତ୍ୟା କରିବି | | | | | | | |
| THREAT_TO_CHILDREN_OR_PETS | ପିଲାଙ୍କୁ ମାର | | | | | | | |
| IMMEDIATE_DANGER | ବିପଦରେ ଅଛି | | | | | | | |
| IMMEDIATE_DANGER | ଏବେ ବିପଦ | | | | | | | |

### Safety guidance (shown when the safety gate trips)
| Key | English source | Odia | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| safetyTitle | This situation may involve a safety concern | ଏହି ପରିସ୍ଥିତିରେ ସୁରକ୍ଷା ସମ୍ବନ୍ଧୀୟ ଚିନ୍ତା ଥାଇପାରେ | | | | | | |
| safety1 | DuoSpace can't assess your safety, and this isn't a judgement about you or anyone else. | DuoSpace ଆପଣଙ୍କ ସୁରକ୍ଷାର ମୂଲ୍ୟାଙ୍କନ କରିପାରିବ ନାହିଁ, ଏବଂ ଏହା ଆପଣଙ୍କ ବା ଅନ୍ୟ କାହା ବିଷୟରେ ରାୟ ନୁହେଁ। | | | | | | |
| safety2 | Because of what you wrote, DuoSpace won't draft a message to your partner or suggest a conversation, apology or meeting right now. | ଆପଣ ଯାହା ଲେଖିଛନ୍ତି ସେଥିପାଇଁ DuoSpace ଏବେ ଆପଣଙ୍କ ସାଥୀଙ୍କ ପାଇଁ କୌଣସି ବାର୍ତ୍ତା, କଥାବାର୍ତ୍ତା, କ୍ଷମା ବା ସାକ୍ଷାତର ପରାମର୍ଶ ଦେବ ନାହିଁ। | | | | | | |
| safety3 | If you are in immediate danger, contact your local emergency number. | ଯଦି ଆପଣ ତୁରନ୍ତ ବିପଦରେ ଅଛନ୍ତି, ଆପଣଙ୍କ ସ୍ଥାନୀୟ ଜରୁରୀକାଳୀନ ନମ୍ବରରେ ଯୋଗାଯୋଗ କରନ୍ତୁ। | | | | | | |
| safety4 | Talking to someone you trust, or a local support service for domestic violence, may help you think through what's safe for you. | ବିଶ୍ୱସ୍ତ କାହା ସହ ବା ଘରୋଇ ହିଂସା ସମ୍ବନ୍ଧୀୟ ସ୍ଥାନୀୟ ସହାୟତା ସେବା ସହ କଥା ହେବା ସାହାଯ୍ୟ କରିପାରେ। | | | | | | |
| safety5 | You can close this at any time. Nothing you wrote here is saved or shared. | ଆପଣ ଏହାକୁ ଯେକୌଣସି ସମୟରେ ବନ୍ଦ କରିପାରିବେ। ଆପଣ ଏଠାରେ ଯାହା ଲେଖିଛନ୍ତି ତାହା ସେଭ୍ ବା ସେୟାର କରାଯାଏ ନାହିଁ। | | | | | | |
| emergencyIndia | In India, the emergency number is 112. | ଭାରତରେ ଜରୁରୀକାଳୀନ ନମ୍ବର 112। | | | | | | |

### Limited-mode & uncertainty text
| Key | English source | Odia | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| limitedNotice | DuoSpace doesn't analyse the meaning of text in this language yet. Your words are shown exactly as written, and nothing is interpreted for you. | DuoSpace ଏବେ ପର୍ଯ୍ୟନ୍ତ ଏହି ଭାଷାର ଲେଖାର ଅର୍ଥ ବିଶ୍ଳେଷଣ କରେ ନାହିଁ। ଆପଣଙ୍କ ଶବ୍ଦ ଯେପରି ଲେଖିଛନ୍ତି ସେହିପରି ଦେଖାଯାଇଛି, ଏବଂ କୌଣସି ବ୍ୟାଖ୍ୟା କରାଯାଇନାହିଁ। | | | | | | |
| unknownMeaning | What your partner meant beyond these exact words: only your partner can explain it. | ଏହି ଶବ୍ଦଗୁଡ଼ିକ ବାହାରେ ଆପଣଙ୍କ ସାଥୀଙ୍କ କ'ଣ ଅର୍ଥ ଥିଲା: ତାହା କେବଳ ଆପଣଙ୍କ ସାଥୀ ହିଁ କହିପାରିବେ। | | | | | | |
| unknownFeelings | How your partner feels about it: not stated here. | ଏ ବିଷୟରେ ଆପଣଙ୍କ ସାଥୀଙ୍କୁ କେମିତି ଲାଗୁଛି: ଏଠାରେ କୁହାଯାଇନାହିଁ। | | | | | | |
| uncertainty | This is one possible way to say what you know. It isn't a verdict, and DuoSpace can't know what your partner feels or meant. | ଆପଣ ଯାହା ଜାଣନ୍ତି ତାହା କହିବାର ଏହା କେବଳ ଗୋଟିଏ ଉପାୟ। ଏହା କୌଣସି ରାୟ ନୁହେଁ, ଏବଂ ଆପଣଙ୍କ ସାଥୀ କ'ଣ ଅନୁଭବ କରନ୍ତି ବା କ'ଣ ବୁଝାଇଥିଲେ ତାହା DuoSpace ଜାଣିପାରିବ ନାହିଁ। | | | | | | |

### Repair / conflict templates ({x} = the user's own words)
| Key | English source | Odia | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| partnerSaid | You said: “{x}”. | ତୁମେ କହିଲ: “{x}”। | | | | | | |
| own | I take responsibility for this part: {x}. | ଏହି ଅଂଶର ଦାୟିତ୍ୱ ମୁଁ ନେଉଛି: {x}। | | | | | | |
| apology | I'm sorry. | ମୋତେ କ୍ଷମା କର। | | | | | | |
| rememberDifferently | I understand this mattered to you, but I remember it differently. | ମୁଁ ବୁଝୁଛି ଯେ ଏହା ତୁମ ପାଇଁ ଗୁରୁତ୍ୱପୂର୍ଣ୍ଣ ଥିଲା, କିନ୍ତୁ ମୋର ଏହା ଅଲଗା ଭାବରେ ମନେ ଅଛି। | | | | | | |
| disagreeInterp | I don't agree with every interpretation of what happened. | ଯାହା ଘଟିଲା ତାର ପ୍ରତ୍ୟେକ ବ୍ୟାଖ୍ୟା ସହ ମୁଁ ସହମତ ନୁହେଁ। | | | | | | |
| explain | From my side: {x}. | ମୋ ପକ୍ଷରୁ: {x}। | | | | | | |
| nextTime | Next time, I can: {x}. | ପରଥର ମୁଁ ଏହା କରିପାରିବି: {x}। | | | | | | |
| request | What would help me is: {x}. | ମୋ ପାଇଁ ଏହା ସହାୟକ ହେବ: {x}। | | | | | | |
| boundaryCannot | I understand your request, but I can't agree to it: {x}. | ମୁଁ ତୁମ ଅନୁରୋଧ ବୁଝୁଛି, କିନ୍ତୁ ମୁଁ ଏଥିରେ ରାଜି ହୋଇପାରିବି ନାହିଁ: {x}। | | | | | | |
| repairQuestion | What part of what happened mattered most to you? | ଯାହା ଘଟିଲା ସେଥିରେ ତୁମ ପାଇଁ ସବୁଠାରୁ ଗୁରୁତ୍ୱପୂର୍ଣ୍ଣ କ'ଣ ଥିଲା? | | | | | | |

### Response-support templates
| Key | English source | Odia | A | B | G | K | L | Decision |
|---|---|---|---|---|---|---|---|---|
| ack | I hear you. | ମୁଁ ଶୁଣୁଛି। | | | | | | |
| understandCheck | This is how I understood it: “{x}”. Did I understand that correctly? | ମୁଁ ଏପରି ବୁଝିଲି: “{x}”। ମୁଁ ଠିକ୍ ବୁଝିଲି କି? | | | | | | |
| clarifyGeneric | What would have felt helpful to you in that situation? | ସେତେବେଳେ ତୁମକୁ କ'ଣ ସହାୟକ ଲାଗିଥାନ୍ତା? | | | | | | |
| clarifyAmbiguous | Do you want to talk about it, or would you rather have some space for now? | ତୁମେ ଏ ବିଷୟରେ କଥା ହେବାକୁ ଚାହୁଁଛ, ନା ଏବେ ଟିକେ ସମୟ ଏକୁଟିଆ ରହିବାକୁ ଚାହୁଁଛ? | | | | | | |

**Romanized forms:** romanized Odia is NOT covered by any lexicon — reviewers please list common romanized spellings.

---

Keys covered: 25 templates × 11 languages + safety lexicons for 11 languages + Hinglish.

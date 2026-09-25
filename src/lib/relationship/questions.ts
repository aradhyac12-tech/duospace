/**
 * The Values Reflection question bank (static, versioned with the app).
 *
 * Design rules:
 *  - No answer is "better". Options describe different, ordinary ways people
 *    prefer things; none is worded as healthier, more mature or more loving.
 *  - Nothing here scores anything. Questions exist to help a person put their
 *    own preferences into words.
 *  - Each question can also be answered "not sure" or declined — those modes
 *    are handled by the store, not listed as options.
 *  - Intimacy / boundaries wording stays general and non-explicit.
 */
import { ValueCategory as C, type ValueQuestion, type ValueCategory } from "./types";

const q = (id: string, category: ValueCategory, prompt: string, options: [string, string][]): ValueQuestion => ({
  id, category, prompt, options: options.map(([oid, label]) => ({ id: oid, label })),
});

export const VALUE_QUESTIONS: readonly ValueQuestion[] = [
  q("comm-1", C.COMMUNICATION, "How much contact do you like on an ordinary day?", [
    ["often", "Small check-ins throughout the day"],
    ["few", "A couple of longer conversations"],
    ["evening", "Mostly catching up in the evening"],
    ["flex", "It varies — I don't need a set pattern"],
  ]),
  q("comm-2", C.COMMUNICATION, "When something is on your mind, how do you prefer to raise it?", [
    ["right-away", "Soon after it comes up"],
    ["planned", "At a calm, agreed time"],
    ["write", "In writing first, then talk"],
    ["depends", "It depends on the topic"],
  ]),
  q("aff-1", C.AFFECTION, "Which ways of showing affection mean the most to you?", [
    ["words", "Saying it in words"],
    ["touch", "Physical closeness"],
    ["acts", "Helpful things done for me"],
    ["time", "Focused time together"],
    ["gifts", "Thoughtful small gifts"],
  ]),
  q("aff-2", C.AFFECTION, "How do you feel about affection in front of other people?", [
    ["comfortable", "Comfortable with it"],
    ["some", "A little is fine"],
    ["private", "I prefer to keep it private"],
    ["depends", "It depends on the setting"],
  ]),
  q("ind-1", C.INDEPENDENCE, "How much do you like to do separately from your partner?", [
    ["lots", "Quite a lot — separate interests matter to me"],
    ["some", "Some separate activities"],
    ["mostly-together", "Mostly things together"],
    ["varies", "It changes with the season of life"],
  ]),
  q("ind-2", C.INDEPENDENCE, "How do you like to make personal decisions (career, hobbies, friends)?", [
    ["own", "Mostly on my own, then share"],
    ["talk-first", "Talk it through first"],
    ["joint", "Decide together"],
    ["depends", "Depends on the decision"],
  ]),
  q("trust-1", C.TRUST, "What helps you feel able to rely on someone?", [
    ["consistency", "Consistency over time"],
    ["openness", "Openness about plans and feelings"],
    ["follow-through", "Following through on what was said"],
    ["given-space", "Being given room to grow into it"],
  ]),
  q("trust-2", C.TRUST, "How do you feel about sharing phones, accounts or passwords?", [
    ["open", "Comfortable being open with them"],
    ["case-by-case", "Case by case, by mutual choice"],
    ["separate", "I prefer to keep them separate"],
    ["unsure", "I haven't settled on a view"],
  ]),
  q("time-1", C.QUALITY_TIME, "What does good time together look like for you?", [
    ["home", "Quiet time at home"],
    ["out", "Going out and doing things"],
    ["trips", "Trips and new places"],
    ["mix", "A mix of these"],
  ]),
  q("time-2", C.QUALITY_TIME, "How often do you like planned time together?", [
    ["daily", "Most days"],
    ["weekly", "A few times a week"],
    ["weekend", "Mainly weekends"],
    ["flex", "Whenever it works out"],
  ]),
  q("space-1", C.PERSONAL_SPACE, "When you need time alone, how do you like to say so?", [
    ["say-directly", "Tell them directly"],
    ["hint", "Take some space and explain later"],
    ["agreed-signal", "Use a signal we've agreed on"],
    ["not-sure", "I find it hard to say"],
  ]),
  q("space-2", C.PERSONAL_SPACE, "How do you feel about your own room, desk or belongings being shared?", [
    ["shared", "Happy to share most things"],
    ["some", "Some shared, some mine"],
    ["mine", "I like clearly separate spaces"],
    ["varies", "It depends on the thing"],
  ]),
  q("conf-1", C.CONFLICT_HANDLING, "When you disagree, what do you usually prefer first?", [
    ["talk-now", "Talk it through right away"],
    ["pause", "A pause, then talk"],
    ["write", "Write down thoughts, then talk"],
    ["third", "Ask a trusted third person for perspective"],
  ]),
  q("conf-2", C.CONFLICT_HANDLING, "After a disagreement, what helps you feel it's settled?", [
    ["words", "Saying what we each understood"],
    ["time", "Time and a calm return to normal"],
    ["plan", "Agreeing on something concrete"],
    ["closeness", "Reconnecting, even without a full discussion"],
  ]),
  q("supp-1", C.EMOTIONAL_SUPPORT, "When you're having a hard time, what do you tend to want?", [
    ["listen", "Someone to listen"],
    ["advice", "Practical ideas"],
    ["company", "Company without much talking"],
    ["space", "Space first, then company"],
  ]),
  q("supp-2", C.EMOTIONAL_SUPPORT, "How do you like to ask for support?", [
    ["directly", "Ask directly"],
    ["hint", "Drop hints and hope they land"],
    ["scheduled", "Set a time to talk"],
    ["hard", "I find it hard to ask"],
  ]),
  q("fin-1", C.FINANCES, "How do you feel about combining money?", [
    ["all", "Fully combined"],
    ["shared-pot", "A shared pot plus separate money"],
    ["separate", "Kept separate, costs split"],
    ["unsure", "I haven't decided"],
  ]),
  q("fin-2", C.FINANCES, "How do you prefer to make larger spending decisions?", [
    ["together-always", "Together, always"],
    ["threshold", "Together above an agreed amount"],
    ["own", "Each decides for their own money"],
    ["depends", "Depends on the situation"],
  ]),
  q("fam-1", C.FAMILY, "How involved do you want extended family to be in your daily life?", [
    ["very", "Very involved"],
    ["regular", "Regular contact"],
    ["occasional", "Occasional contact"],
    ["unsure", "I'm not sure yet"],
  ]),
  q("fam-2", C.FAMILY, "How do you see having (or not having) children?", [
    ["want", "I want children"],
    ["open", "I'm open to it"],
    ["dont", "I don't want children"],
    ["unsure", "I'm undecided"],
  ]),
  q("future-1", C.FUTURE_PLANNING, "How do you like to think about the future together?", [
    ["detailed", "Detailed plans"],
    ["broad", "Broad direction, flexible details"],
    ["present", "Mostly the present"],
    ["unsure", "I'm still working it out"],
  ]),
  q("future-2", C.FUTURE_PLANNING, "How settled do you want your living situation to be?", [
    ["settled", "Settled in one place"],
    ["mobile", "Open to moving"],
    ["depends", "Depends on work or family"],
    ["unsure", "I'm not sure"],
  ]),
  q("life-1", C.LIFESTYLE, "What pace of daily life suits you?", [
    ["calm", "Calm and routine"],
    ["busy", "Busy and varied"],
    ["balanced", "A balance"],
    ["seasonal", "It changes"],
  ]),
  q("life-2", C.LIFESTYLE, "How do you feel about socialising with friends?", [
    ["often", "Often"],
    ["sometimes", "Sometimes"],
    ["rarely", "Rarely"],
    ["mixed", "Depends on my energy"],
  ]),
  q("bound-1", C.BOUNDARIES, "How do you prefer to talk about boundaries?", [
    ["early", "Early and clearly"],
    ["as-needed", "As they come up"],
    ["written", "Writing them down"],
    ["hard", "I find it hard to put into words"],
  ]),
  q("bound-2", C.BOUNDARIES, "How do you prefer your boundaries to be received?", [
    ["acknowledged", "Acknowledged out loud"],
    ["respected-quietly", "Respected without discussion"],
    ["talked-through", "Talked through together"],
    ["unsure", "I'm not sure"],
  ]),
  q("intim-1", C.INTIMACY, "How do you prefer to talk about closeness and physical intimacy?", [
    ["openly", "Openly and regularly"],
    ["when-arises", "When something comes up"],
    ["gently", "Gently, at my own pace"],
    ["unsure", "I'm not sure yet"],
  ]),
  q("intim-2", C.INTIMACY, "What makes it easier to feel close?", [
    ["trust", "Feeling trusted and unhurried"],
    ["time", "Enough time together"],
    ["talk", "Talking beforehand"],
    ["unsure", "I'm not sure"],
  ]),
  q("growth-1", C.PERSONAL_GROWTH, "How do you like to support each other's goals?", [
    ["cheer", "Encouragement"],
    ["practical", "Practical help"],
    ["accountability", "Gentle accountability"],
    ["space", "Room to pursue them alone"],
  ]),
  q("growth-2", C.PERSONAL_GROWTH, "How do you feel about learning and changing over time?", [
    ["seek", "I actively seek it"],
    ["open", "Open when it comes up"],
    ["stable", "I value staying consistent"],
    ["unsure", "I'm still thinking about it"],
  ]),
];

const BY_ID: ReadonlyMap<string, ValueQuestion> = new Map(VALUE_QUESTIONS.map((x) => [x.id, x]));

export function getQuestion(id: string): ValueQuestion | undefined {
  return BY_ID.get(id);
}
export function questionsForCategory(category: ValueCategory): ValueQuestion[] {
  return VALUE_QUESTIONS.filter((x) => x.category === category);
}
export function optionLabel(questionId: string, choiceId: string | null): string | null {
  if (!choiceId) return null;
  return getQuestion(questionId)?.options.find((o) => o.id === choiceId)?.label ?? null;
}

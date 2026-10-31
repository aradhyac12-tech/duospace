// Gender-aware pronoun helper
export type Gender = "male" | "female" | "non-binary" | null;

export const getPronouns = (gender: Gender) => {
  switch (gender) {
    case "male":
      return { subject: "he", object: "him", possessive: "his", reflexive: "himself" };
    case "female":
      return { subject: "she", object: "her", possessive: "her", reflexive: "herself" };
    default:
      return { subject: "they", object: "them", possessive: "their", reflexive: "themselves" };
  }
};

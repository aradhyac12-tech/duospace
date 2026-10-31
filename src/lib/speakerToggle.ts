import type { AudioRoute } from "duospace-audio-route";

export type SpeakerAction =
  | { kind: "set"; route: AudioRoute }
  | { kind: "picker" }
  | { kind: "none" };

/**
 * What the Speaker button does on a native build with real audio routes.
 * - not on speaker -> go to the speaker route
 * - on speaker with exactly one alternative -> go to it
 * - on speaker with several alternatives (or no speaker route to enter) -> open the picker, never guess
 * - no routes known -> nothing to pick from
 */
export function decideSpeakerAction(routes: AudioRoute[], current: AudioRoute | null): SpeakerAction {
  const speaker = routes.find((r) => r.type === "speaker");
  const others = routes.filter((r) => r.type !== "speaker");
  const onSpeaker = current?.type === "speaker";
  if (onSpeaker) {
    if (others.length === 1) return { kind: "set", route: others[0] };
    return others.length > 1 ? { kind: "picker" } : { kind: "none" };
  }
  if (speaker) return { kind: "set", route: speaker };
  return routes.length > 0 ? { kind: "picker" } : { kind: "none" };
}

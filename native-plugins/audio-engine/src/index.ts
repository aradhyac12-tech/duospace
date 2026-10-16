import { registerPlugin } from "@capacitor/core";
import type { DuospaceAudioEnginePlugin } from "./definitions";

const DuospaceAudioEngine = registerPlugin<DuospaceAudioEnginePlugin>("DuospaceAudioEngine", {
  web: () => import("./web").then((m) => new m.AudioEngineWeb()),
});

export * from "./definitions";
export { DuospaceAudioEngine };

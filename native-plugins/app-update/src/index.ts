import { registerPlugin } from "@capacitor/core";
import type { DuospaceAppUpdatePlugin } from "./definitions";

const DuospaceAppUpdate = registerPlugin<DuospaceAppUpdatePlugin>("DuospaceAppUpdate", {
  web: () => import("./web").then((m) => new m.AppUpdateWeb()),
});

export * from "./definitions";
export { DuospaceAppUpdate };

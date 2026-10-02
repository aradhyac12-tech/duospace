import { registerPlugin } from "@capacitor/core";
import type { DuospaceAdmobPlugin } from "./definitions";

const DuospaceAdmob = registerPlugin<DuospaceAdmobPlugin>("DuospaceAdmob", {
  web: () => import("./web").then((m) => new m.AdmobWeb()),
});

export * from "./definitions";
export { DuospaceAdmob };

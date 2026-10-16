import { registerPlugin } from "@capacitor/core";
import type { DuospaceBillingPlugin } from "./definitions";

const DuospaceBilling = registerPlugin<DuospaceBillingPlugin>("DuospaceBilling", {
  web: () => import("./web").then((m) => new m.BillingWeb()),
});

export * from "./definitions";
export { DuospaceBilling };

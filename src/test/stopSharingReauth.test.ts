import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase/migrations/20261003160000_stop_sharing_requires_recent_auth.sql", "utf8");
const ui = readFileSync("src/pages/settings/PartnerSettings.tsx", "utf8");
const dialog = readFileSync("src/components/settings/ConfirmActionDialog.tsx", "utf8");

describe("Stop sharing & unlink requires re-authentication", () => {
  it("the database refuses a stale session before any side effect", () => {
    const body = sql.slice(sql.indexOf("FUNCTION public.stop_sharing"));
    expect(body.indexOf("REAUTH_REQUIRED")).toBeGreaterThan(-1);
    expect(body.indexOf("REAUTH_REQUIRED")).toBeLessThan(body.indexOf("INSERT INTO public.sharing_state"));
  });
  it("the check fails closed when no amr timestamp is readable", () => {
    expect(sql).toMatch(/,\s*false\)/);
  });
  it("the confirmation turns authRequired on", () => {
    const i = ui.indexOf("open={showStopSharingConfirm}");
    expect(ui.slice(i, i + 1600)).toMatch(/authRequired=\{true\}/);
  });
  it("the dialog won't run the action unless verification passes", () => {
    expect(dialog).toMatch(/if \(!ok\) return;/);
  });
});

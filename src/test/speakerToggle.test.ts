import { describe, it, expect } from "vitest";
import { decideSpeakerAction } from "../lib/speakerToggle";

const r = (id: string, type: string) => ({ id, name: id, type }) as never;
const spk = r("spk", "speaker"), ear = r("ear", "earpiece"), bt = r("bt", "bluetooth"), wd = r("wd", "wired_headset");

describe("Speaker button decision", () => {
  it("not on speaker -> go to speaker", () => {
    expect(decideSpeakerAction([ear, spk, bt], ear)).toEqual({ kind: "set", route: spk });
  });
  it("on speaker with one alternative -> go to it", () => {
    expect(decideSpeakerAction([ear, spk], spk)).toEqual({ kind: "set", route: ear });
  });
  it("on speaker with several alternatives -> open picker, don't guess", () => {
    expect(decideSpeakerAction([ear, spk, bt, wd], spk)).toEqual({ kind: "picker" });
  });
  it("no speaker route listed but others exist -> picker", () => {
    expect(decideSpeakerAction([ear, bt], ear)).toEqual({ kind: "picker" });
  });
  it("nothing known -> none (UI toasts and refreshes)", () => {
    expect(decideSpeakerAction([], null)).toEqual({ kind: "none" });
    expect(decideSpeakerAction([spk], spk)).toEqual({ kind: "none" });
  });
});

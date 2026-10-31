/**
 * globalHaptics — baseline feedback for every tappable control.
 *
 * Premium feel comes from *coverage*: if some buttons answer your finger and
 * others are dead, the app feels cheap. Rather than hand-wiring ~hundreds of
 * handlers, one delegated listener gives every standard control a fitting
 * haptic:
 *
 *   switch / checkbox        toggleOn / toggleOff (reads the new state)
 *   tab / radio / option     selection tick
 *   button / link / menu     light tap
 *
 * It never doubles up with explicit call sites: React handlers run before this
 * document-level listener, and the engine's gate drops a weaker haptic that
 * lands within ~45 ms of a stronger one — plus we skip when any haptic fired in
 * the last 120 ms or the press was a long-press (> 350 ms, already handled by
 * the gesture's own haptic).
 *
 * Opt out per element/subtree with `data-haptic="off"`.
 */
import { fireNamed, msSinceLastHaptic, prepareHaptics, hapticsEnabled, hapticTier } from "@/lib/hapticEngine";

const INTERACTIVE = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
].join(",");

const SKIP = ':disabled, [aria-disabled="true"], [data-disabled], [data-haptic="off"]';
const LONG_PRESS_MS = 350;
const RECENT_HAPTIC_MS = 120;

let installed = false;
let downAt = 0;

const isOn = (el: Element): boolean => {
  const aria = el.getAttribute("aria-checked");
  if (aria === "true") return true;
  if (aria === "false") return false;
  const state = el.getAttribute("data-state");
  if (state) return state === "checked" || state === "on";
  return (el as HTMLInputElement).checked === true;
};

const onClick = (e: MouseEvent) => {
  if (!e.isTrusted || !hapticsEnabled()) return;
  const target = e.target as Element | null;
  if (!target || typeof target.closest !== "function") return;
  const el = target.closest(INTERACTIVE);
  if (!el || el.matches(SKIP) || el.closest('[data-haptic="off"]')) return;

  // Something more specific already answered this tap.
  if (msSinceLastHaptic() < RECENT_HAPTIC_MS) return;
  // Long-press gestures own their haptic.
  if (downAt && performance.now() - downAt > LONG_PRESS_MS) return;

  const role = el.getAttribute("role");
  const type = (el as HTMLInputElement).type;
  if (role === "switch" || role === "checkbox" || role === "menuitemcheckbox" || type === "checkbox") {
    // Radix/React flip state after this event — read it on the next frame.
    requestAnimationFrame(() => void fireNamed(isOn(el) ? "toggleOn" : "toggleOff"));
    return;
  }
  if (role === "tab" || role === "radio" || role === "option" || role === "menuitemradio" || type === "radio") {
    void fireNamed("selection");
    return;
  }
  void fireNamed("light");
};

const onPointerDown = () => {
  downAt = performance.now();
  prepareHaptics(); // warm the engine so the tap that follows has minimal latency
};

export function initGlobalHaptics() {
  if (installed || typeof document === "undefined") return;
  if (hapticTier() === "none") return;
  installed = true;
  document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  document.addEventListener("click", onClick, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") prepareHaptics();
  });
  prepareHaptics();
}

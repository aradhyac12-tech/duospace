#!/usr/bin/env python3
"""
Synthesizes the two /important and /urgent message-alert sounds.

Unlike the selectable notification sounds (scripts/generate-notification-sounds.py,
mastered at -19 dBFS so switching between them doesn't jump in volume), these
are MEANT to be loud and unmistakable, so they are mastered hot (-1 dBFS peak)
and are deliberately not part of the Settings sound catalog.

  important  rising three-note bell x2, gentle but insistent      (3.6 s loop unit)
  urgent     two-tone siren then rapid high beeps, harsh/alarming (3.0 s loop unit)

Rendered per tier to:
  public/sounds/alert_<tier>.m4a            web/in-app preview + playback (loop unit)
  native/android/res_raw/alert_<tier>.ogg   Android raw resource, looped by MessageAlertService (loop unit)
  native/ios/Sounds/alert_<tier>.caf        iOS push sound: the loop unit repeated to ~20-27 s
                                            (iOS plays a push sound once, max 30 s)

Every loop unit starts and ends at zero amplitude, so MediaPlayer/<audio> loops don't click.
Usage (repo root; needs numpy + ffmpeg):  python3 scripts/generate-alert-sounds.py
"""
import os
import subprocess
import tempfile
import wave

import numpy as np

SR = 44100
PEAK_DB = -1.0
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_WEB = os.path.join(ROOT, "public", "sounds")
OUT_ANDROID = os.path.join(ROOT, "native", "android", "res_raw")
OUT_IOS = os.path.join(ROOT, "native", "ios", "Sounds")


def silence(dur):
    return np.zeros(int(SR * dur))


def place(buf, sig, at):
    i = int(SR * at)
    end = min(len(buf), i + len(sig))
    buf[i:end] += sig[: end - i]


def bell(freq, dur, decay=0.55):
    t = np.arange(int(SR * dur)) / SR
    env = np.minimum(1.0, t / 0.003) * np.exp(-t / decay)
    sig = np.zeros_like(t)
    for ratio, amp in ((1.0, 1.0), (2.0, 0.45), (2.76, 0.30), (5.4, 0.12)):
        sig += amp * np.sin(2 * np.pi * freq * ratio * t)
    return sig * env


def buzz(freq, dur, attack=0.006, release=0.012):
    """Harsh square-ish tone (odd harmonics) with click-free edges."""
    t = np.arange(int(SR * dur)) / SR
    sig = np.zeros_like(t)
    for h, amp in ((1, 1.0), (3, 0.42), (5, 0.25), (7, 0.14)):
        sig += amp * np.sin(2 * np.pi * freq * h * t)
    env = np.minimum(1.0, t / attack) * np.minimum(1.0, (dur - t) / release)
    return sig * np.clip(env, 0, 1)


def important_unit():
    dur = 3.6
    buf = np.zeros(int(SR * dur))
    for base in (0.0, 1.8):
        for k, f in enumerate((783.99, 1046.50, 1318.51)):  # G5 C6 E6
            place(buf, bell(f, 1.0), base + k * 0.28)
    return buf


def urgent_unit():
    dur = 3.0
    buf = np.zeros(int(SR * dur))
    at = 0.0
    for k in range(8):  # hi-lo siren, 8 x 0.2 s
        place(buf, buzz(1000 if k % 2 == 0 else 720, 0.2), at)
        at += 0.2
    at = 1.75
    for _ in range(5):  # rapid beeps
        place(buf, buzz(1900, 0.1), at)
        at += 0.2
    return buf


def master(x):
    x = x / (np.max(np.abs(x)) + 1e-9) * (10 ** (PEAK_DB / 20))
    x[:8] *= np.linspace(0, 1, 8)
    x[-8:] *= np.linspace(1, 0, 8)
    return x


def write_wav(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def ffmpeg(src, dst, *args):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, *args, dst], check=True)


def render(name, unit, ios_repeats):
    unit = master(unit)
    with tempfile.TemporaryDirectory() as tmp:
        loop_wav = os.path.join(tmp, "loop.wav")
        ios_wav = os.path.join(tmp, "ios.wav")
        write_wav(loop_wav, unit)
        write_wav(ios_wav, np.tile(unit, ios_repeats))
        ffmpeg(loop_wav, os.path.join(OUT_WEB, f"alert_{name}.m4a"), "-c:a", "aac", "-b:a", "96k")
        ffmpeg(loop_wav, os.path.join(OUT_ANDROID, f"alert_{name}.ogg"), "-c:a", "libvorbis", "-q:a", "4")
        ffmpeg(ios_wav, os.path.join(OUT_IOS, f"alert_{name}.caf"), "-c:a", "pcm_s16le", "-f", "caf")
    print(f"alert_{name}: loop unit {len(unit)/SR:.1f}s, iOS file {len(unit)*ios_repeats/SR:.1f}s")


if __name__ == "__main__":
    render("important", important_unit(), 6)   # 21.6 s (< 30 s iOS cap)
    render("urgent", urgent_unit(), 9)         # 27.0 s (< 30 s iOS cap)

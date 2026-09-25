#!/usr/bin/env python3
"""
Synthesizes the bundled notification sounds + call ringtones added in v3.11.1
(no external audio assets, no network — same approach as the original 8).

Every id below is rendered to THREE files, because the three runtimes can't
share a codec:
  public/sounds/<id>_<msg|call>.m4a        web preview + in-app playback (AAC)
  native/android/res_raw/<id>_<msg|call>.ogg  Android raw resource (Vorbis)
  native/ios/Sounds/<id>_<msg|call>.caf    iOS bundle (16-bit PCM CAF)

Usage (from repo root; needs numpy + ffmpeg on PATH):
  python3 scripts/generate-notification-sounds.py            # render all new ids
  python3 scripts/generate-notification-sounds.py bell retro # just these

Level: the original 8 assets peak at about -19 dBFS. New ones are mastered to
the same peak so switching between sounds in Settings doesn't jump in volume.
If everything should be louder, raise TARGET_PEAK_DB here AND re-render the
original 8 (they were not produced by this script) — don't only raise one side.

Call ringtones are LOOPED (MediaPlayer isLooping on Android, CallKit on iOS,
<audio loop> in-app), so each one ends in silence and starts/ends at zero
amplitude — no click at the loop point.
"""
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

SR = 44100
TARGET_PEAK_DB = -19.0

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_WEB = os.path.join(ROOT, "public", "sounds")
OUT_ANDROID = os.path.join(ROOT, "native", "android", "res_raw")
OUT_IOS = os.path.join(ROOT, "native", "ios", "Sounds")


# ── primitives ──────────────────────────────────────────────────────────────
def t_axis(dur):
    return np.arange(int(SR * dur)) / SR


def env_exp(n, attack=0.004, decay=0.25):
    """Fast linear attack, exponential decay (struck/plucked sounds)."""
    t = np.arange(n) / SR
    a = np.minimum(1.0, t / max(attack, 1e-4))
    return a * np.exp(-t / decay)


def env_adsr(n, a=0.02, r=0.08, hold=1.0):
    t = np.arange(n) / SR
    e = np.minimum(1.0, t / max(a, 1e-4)) * hold
    tail = np.minimum(1.0, (n / SR - t) / max(r, 1e-4))
    return e * np.clip(tail, 0, 1)


def sine(freq, dur, phase=0.0):
    return np.sin(2 * np.pi * freq * t_axis(dur) + phase)


def bell_tone(freq, dur, decay=0.45, brightness=1.0):
    """Struck-bell: inharmonic partials with per-partial decay."""
    t = t_axis(dur)
    partials = [(1.0, 1.0, 1.0), (2.0, 0.55, 0.7), (2.76, 0.45, 0.55),
                (5.4, 0.18 * brightness, 0.35), (8.93, 0.08 * brightness, 0.2)]
    out = np.zeros_like(t)
    for ratio, amp, dk in partials:
        out += amp * np.sin(2 * np.pi * freq * ratio * t) * np.exp(-t / (decay * dk))
    return out * np.minimum(1.0, t / 0.002)


def pluck(freq, dur, damping=0.996):
    """Karplus–Strong plucked string."""
    n = int(SR * dur)
    period = max(2, int(SR / freq))
    rng = np.random.default_rng(int(freq))  # deterministic renders
    buf = rng.uniform(-1, 1, period)
    out = np.empty(n)
    for i in range(n):
        out[i] = buf[i % period]
        buf[i % period] = damping * 0.5 * (buf[i % period] + buf[(i + 1) % period])
    return out


def music_box(freq, dur, decay=0.35):
    t = t_axis(dur)
    tone = (np.sin(2 * np.pi * freq * t)
            + 0.35 * np.sin(2 * np.pi * freq * 2 * t) * np.exp(-t / (decay * 0.6))
            + 0.12 * np.sin(2 * np.pi * freq * 4.01 * t) * np.exp(-t / (decay * 0.3)))
    return tone * env_exp(len(t), 0.002, decay)


def epiano(freq, dur, decay=0.6):
    """Soft FM electric piano."""
    t = t_axis(dur)
    mod = np.sin(2 * np.pi * freq * t) * 1.6 * np.exp(-t / 0.25)
    tone = np.sin(2 * np.pi * freq * t + mod)
    return tone * env_exp(len(t), 0.004, decay)


def place(buf, sig, at):
    """Mix `sig` into `buf` starting at `at` seconds (clipped to buffer)."""
    i = int(at * SR)
    if i >= len(buf):
        return
    # 10 ms tail fade so a note that is cut off while still decaying (the
    # generators size each note a little shorter than its full ring-out)
    # doesn't leave a click at the cut.
    sig = np.array(sig, dtype=np.float64)
    fade = min(len(sig), int(0.010 * SR))
    if fade > 0:
        sig[-fade:] *= np.linspace(1, 0, fade)
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i]


def blank(dur):
    return np.zeros(int(SR * dur))


def note(name):
    """'C5' / 'F#4' / 'Bb3' -> Hz."""
    names = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    p = name[0]
    rest = name[1:]
    semi = names[p]
    if rest and rest[0] == "#":
        semi += 1
        rest = rest[1:]
    elif rest and rest[0] == "b":
        semi -= 1
        rest = rest[1:]
    octave = int(rest)
    midi = 12 * (octave + 1) + semi
    return 440.0 * 2 ** ((midi - 69) / 12)


# ── message sounds (short, ~0.15–0.9 s) ─────────────────────────────────────
def msg_bell():
    b = blank(0.95)
    place(b, bell_tone(note("E6"), 0.95, decay=0.30), 0.0)
    return b


def msg_droplet():
    b = blank(0.4)
    for at, f0, f1, amp in [(0.0, 1500, 620, 1.0), (0.13, 1150, 520, 0.55)]:
        dur = 0.22
        t = t_axis(dur)
        freq = f1 + (f0 - f1) * np.exp(-t / 0.035)
        phase = 2 * np.pi * np.cumsum(freq) / SR
        place(b, amp * np.sin(phase) * env_exp(len(t), 0.002, 0.07), at)
    return b


def msg_crystal():
    b = blank(0.9)
    for at, f, amp in [(0.0, note("C7"), 1.0), (0.09, note("G7"), 0.7)]:
        t = t_axis(0.8)
        vib = 1 + 0.003 * np.sin(2 * np.pi * 6 * t)
        tone = np.sin(2 * np.pi * f * t * vib) + 0.3 * np.sin(2 * np.pi * f * 2.01 * t) * np.exp(-t / 0.15)
        place(b, amp * tone * env_exp(len(t), 0.003, 0.22), at)
    return b


def msg_harp():
    b = blank(0.95)
    for at, n in [(0.0, "C5"), (0.09, "E5"), (0.18, "G5")]:
        place(b, pluck(note(n), 0.75, 0.9965), at)
    return b


def msg_sparkle():
    b = blank(0.7)
    for i, n in enumerate(["C6", "E6", "G6", "C7"]):
        t = t_axis(0.25)
        tone = np.sin(2 * np.pi * note(n) * t) + 0.25 * np.sin(2 * np.pi * note(n) * 3 * t)
        place(b, tone * env_exp(len(t), 0.002, 0.07) * (0.6 + 0.13 * i), i * 0.07)
    return b


def msg_tick():
    b = blank(0.14)
    t = t_axis(0.09)
    rng = np.random.default_rng(7)
    noise = rng.uniform(-1, 1, len(t))
    # crude one-pole low-pass so it reads as a woodblock, not hiss
    lp = np.zeros_like(noise)
    for i in range(1, len(noise)):
        lp[i] = lp[i - 1] + 0.25 * (noise[i] - lp[i - 1])
    tone = np.sin(2 * np.pi * 1850 * t) + 0.5 * np.sin(2 * np.pi * 1230 * t)
    place(b, (0.5 * lp + tone) * env_exp(len(t), 0.001, 0.014), 0.0)
    return b


def msg_whistle():
    b = blank(0.55)
    dur = 0.42
    t = t_axis(dur)
    glide = 1500 + 750 * (1 - np.exp(-t / 0.12))
    vib = 1 + 0.012 * np.sin(2 * np.pi * 9 * t) * np.minimum(1, t / 0.15)
    phase = 2 * np.pi * np.cumsum(glide * vib) / SR
    sig = np.sin(phase) + 0.12 * np.sin(2 * phase)
    place(b, sig * env_adsr(len(t), 0.03, 0.14), 0.0)
    return b


def msg_glass():
    b = blank(0.7)
    t = t_axis(0.65)
    sig = np.zeros_like(t)
    for ratio, amp, dk in [(1.0, 1.0, 0.16), (1.51, 0.6, 0.12), (2.32, 0.45, 0.09), (3.86, 0.2, 0.05)]:
        sig += amp * np.sin(2 * np.pi * 2350 * ratio * t) * np.exp(-t / dk)
    place(b, sig * np.minimum(1.0, t / 0.001), 0.0)
    return b


# ── call ringtones (looped, ~2–3.2 s, end in silence) ───────────────────────
def call_retro():
    """Old telephone bell: two AM-shimmering bursts, long gap."""
    b = blank(3.0)
    for start in (0.0, 0.95):
        dur = 0.65
        t = t_axis(dur)
        am = 0.55 + 0.45 * np.sin(2 * np.pi * 22 * t)
        sig = (np.sin(2 * np.pi * 1440 * t) + np.sin(2 * np.pi * 1800 * t)) * am
        place(b, sig * env_adsr(len(t), 0.01, 0.04), start)
    return b


def call_digital():
    """Clean electronic beeps, two groups of four."""
    b = blank(2.6)
    for group_start in (0.0, 1.1):
        for i, f in enumerate([880, 1320, 880, 1320]):
            t = t_axis(0.11)
            sq = np.sign(np.sin(2 * np.pi * f * t)) * 0.6 + np.sin(2 * np.pi * f * t) * 0.4
            place(b, sq * env_adsr(len(t), 0.004, 0.012), group_start + i * 0.16)
    return b


def call_melody():
    """Friendly rising phrase on a soft electric piano."""
    b = blank(3.0)
    seq = [("E5", 0.0), ("G5", 0.22), ("C6", 0.44), ("B5", 0.78), ("G5", 1.0), ("A5", 1.22), ("E5", 1.6)]
    for n, at in seq:
        place(b, epiano(note(n), 0.9, 0.5), at)
    return b


def call_bells():
    """Three slow bell strikes, descending."""
    b = blank(3.4)
    for n, at in [("G5", 0.0), ("E5", 0.75), ("C5", 1.5)]:
        place(b, bell_tone(note(n), 1.7, decay=0.7, brightness=0.8), at)
    return b


def call_pulse():
    """Soft sonar-style double pulse."""
    b = blank(2.4)
    for at in (0.0, 0.42):
        t = t_axis(0.5)
        freq = 520 + 120 * np.exp(-t / 0.05)
        phase = 2 * np.pi * np.cumsum(freq) / SR
        sig = np.sin(phase) + 0.2 * np.sin(2 * phase)
        place(b, sig * env_exp(len(t), 0.02, 0.16), at)
    return b


def call_sunrise():
    """Ascending pentatonic run over a slowly swelling pad."""
    b = blank(3.2)
    pad_t = t_axis(2.6)
    pad = (np.sin(2 * np.pi * note("C4") * pad_t) + 0.6 * np.sin(2 * np.pi * note("G4") * pad_t)
           + 0.4 * np.sin(2 * np.pi * note("E5") * pad_t))
    place(b, 0.45 * pad * env_adsr(len(pad_t), 1.2, 0.9), 0.0)
    for i, n in enumerate(["C5", "D5", "E5", "G5", "A5", "C6"]):
        place(b, epiano(note(n), 0.8, 0.45) * (0.7 + 0.06 * i), 0.15 + i * 0.3)
    return b


def call_waltz():
    """Music-box waltz figure in 3/4."""
    b = blank(3.0)
    beat = 0.32
    seq = [("C5", 0), ("E5", 1), ("G5", 2), ("A5", 3), ("G5", 4), ("E5", 5), ("D5", 6), ("F5", 7), ("E5", 8)]
    for n, k in seq:
        place(b, music_box(note(n), 0.7, 0.32) * (1.0 if k % 3 == 0 else 0.7), k * beat)
    return b


def call_groove():
    """Plucked bass-and-chord riff, syncopated."""
    b = blank(2.6)
    for n, at, amp in [("A3", 0.0, 1.0), ("A3", 0.3, 0.7), ("C4", 0.6, 0.9), ("E4", 0.9, 0.9), ("G4", 1.2, 1.0),
                       ("E4", 1.5, 0.7), ("D4", 1.8, 0.8)]:
        place(b, amp * pluck(note(n), 0.55, 0.994), at)
    return b


CATALOG = {
    "bell_msg": msg_bell, "droplet_msg": msg_droplet, "crystal_msg": msg_crystal, "harp_msg": msg_harp,
    "sparkle_msg": msg_sparkle, "tick_msg": msg_tick, "whistle_msg": msg_whistle, "glass_msg": msg_glass,
    "retro_call": call_retro, "digital_call": call_digital, "melody_call": call_melody, "bells_call": call_bells,
    "pulse_call": call_pulse, "sunrise_call": call_sunrise, "waltz_call": call_waltz, "groove_call": call_groove,
}


# ── mastering + encoding ────────────────────────────────────────────────────
def master(sig):
    sig = np.asarray(sig, dtype=np.float64)
    # zero-amplitude edges: 3 ms fade in, 25 ms fade out (loop point + no click)
    fi, fo = int(0.003 * SR), int(0.025 * SR)
    sig[:fi] *= np.linspace(0, 1, fi)
    sig[-fo:] *= np.linspace(1, 0, fo)
    peak = np.max(np.abs(sig)) or 1.0
    return sig * (10 ** (TARGET_PEAK_DB / 20) / peak)


def write_wav(path, sig):
    pcm = np.clip(sig * 32767, -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args], check=True)


def render(name, fn):
    sig = master(fn())
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, f"{name}.wav")
        write_wav(wav, sig)
        ffmpeg("-i", wav, "-c:a", "aac", "-b:a", "48k", "-ac", "1", os.path.join(OUT_WEB, f"{name}.m4a"))
        ffmpeg("-i", wav, "-c:a", "libvorbis", "-b:a", "96k", "-ac", "1", os.path.join(OUT_ANDROID, f"{name}.ogg"))
        ffmpeg("-i", wav, "-c:a", "pcm_s16le", "-ac", "1", os.path.join(OUT_IOS, f"{name}.caf"))
    print(f"rendered {name}  ({len(sig) / SR:.2f}s)")


def main(argv):
    for d in (OUT_WEB, OUT_ANDROID, OUT_IOS):
        os.makedirs(d, exist_ok=True)
    wanted = argv or [k.rsplit("_", 1)[0] for k in CATALOG]
    for name, fn in CATALOG.items():
        base = name.rsplit("_", 1)[0]
        if argv and base not in wanted and name not in wanted:
            continue
        render(name, fn)


if __name__ == "__main__":
    main(sys.argv[1:])

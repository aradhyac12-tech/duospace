export type SurpriseDraft = {
  title: string;
  html_content: string;
  css_content: string;
  js_content: string;
  max_views: number;
};

type ParticlePresetOptions = {
  id: string;
  title: string;
  emoji: string[];
  headline: string;
  subline: string;
  background: string;
  accent: string;
  accentSoft: string;
  count?: number;
};

const createParticlePreset = ({
  id,
  title,
  emoji,
  headline,
  subline,
  background,
  accent,
  accentSoft,
  count = 28,
}: ParticlePresetOptions) => ({
  id,
  title,
  max_views: 1,
  html_content: `
    <div class="scene">
      <div class="glow"></div>
      <div class="message-card">
        <div class="headline">${headline}</div>
        <div class="subline">${subline}</div>
      </div>
      <div id="particles" class="particles"></div>
    </div>
  `,
  css_content: `
    :root {
      --accent: ${accent};
      --accent-soft: ${accentSoft};
      --bg: ${background};
    }

    body {
      margin: 0;
      min-height: 100vh;
      overflow: hidden;
      background: var(--bg);
      font-family: "Georgia", "Times New Roman", serif;
      color: white;
    }

    .scene {
      position: relative;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px;
      isolation: isolate;
    }

    .glow {
      position: absolute;
      inset: 12%;
      border-radius: 999px;
      background: radial-gradient(circle, var(--accent-soft), transparent 60%);
      filter: blur(40px);
      opacity: 0.9;
      animation: pulseGlow 4s ease-in-out infinite;
    }

    .message-card {
      position: relative;
      z-index: 2;
      max-width: 320px;
      text-align: center;
      padding: 28px 24px;
      border-radius: 28px;
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(14px);
      box-shadow: 0 20px 80px rgba(0, 0, 0, 0.22);
      border: 1px solid rgba(255, 255, 255, 0.18);
      animation: floatCard 3.6s ease-in-out infinite;
    }

    .headline {
      font-size: clamp(2rem, 7vw, 3.25rem);
      line-height: 0.95;
      font-weight: 700;
      letter-spacing: -0.04em;
      text-wrap: balance;
    }

    .subline {
      margin-top: 12px;
      font-size: 0.98rem;
      line-height: 1.5;
      color: rgba(255, 255, 255, 0.84);
    }

    .particles {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
    }

    .particle {
      position: absolute;
      top: -12vh;
      font-size: var(--size);
      left: var(--left);
      animation: fall var(--duration) linear infinite;
      animation-delay: var(--delay);
      filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.16));
      opacity: 0.95;
    }

    @keyframes fall {
      0% { transform: translate3d(0, 0, 0) rotate(0deg) scale(0.9); }
      100% { transform: translate3d(var(--drift), 118vh, 0) rotate(360deg) scale(1.1); }
    }

    @keyframes floatCard {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }

    @keyframes pulseGlow {
      0%, 100% { transform: scale(0.94); opacity: 0.72; }
      50% { transform: scale(1.06); opacity: 1; }
    }
  `,
  js_content: `
    const icons = ${JSON.stringify(emoji)};
    const particles = document.getElementById("particles");
    const total = ${count};

    for (let index = 0; index < total; index += 1) {
      const particle = document.createElement("span");
      particle.className = "particle";
      particle.textContent = icons[index % icons.length];
      particle.style.setProperty("--left", (Math.random() * 100) + "%");
      particle.style.setProperty("--delay", (Math.random() * 4) + "s");
      particle.style.setProperty("--duration", (5 + Math.random() * 5) + "s");
      particle.style.setProperty("--drift", (-40 + Math.random() * 80) + "px");
      particle.style.setProperty("--size", (1 + Math.random() * 1.8) + "rem");
      particles.appendChild(particle);
    }
  `,
});

export const surprisePresets = [
  createParticlePreset({
    id: "hearts-shower",
    title: "Hearts Shower",
    emoji: ["❤️", "💖", "💕", "💘"],
    headline: "Love falling for you",
    subline: "A tiny storm of hearts, just for your screen.",
    background: "radial-gradient(circle at top, #ff90b3 0%, #d6336c 42%, #541133 100%)",
    accent: "#ffd7e6",
    accentSoft: "rgba(255, 212, 230, 0.65)",
  }),
  createParticlePreset({
    id: "flower-shower",
    title: "Flower Shower",
    emoji: ["🌸", "🌷", "🌹", "💐"],
    headline: "Bloom for me",
    subline: "A flower shower to brighten your moment.",
    background: "linear-gradient(180deg, #ffe3ec 0%, #f783ac 48%, #742b47 100%)",
    accent: "#fff0f6",
    accentSoft: "rgba(255, 240, 246, 0.7)",
  }),
  createParticlePreset({
    id: "love-you",
    title: "I Love You",
    emoji: ["✨", "❤️", "✨"],
    headline: "I love you",
    subline: "Today, tomorrow, and every little second in between.",
    background: "linear-gradient(135deg, #231942 0%, #5e548e 38%, #be95c4 100%)",
    accent: "#f8edff",
    accentSoft: "rgba(248, 237, 255, 0.55)",
    count: 18,
  }),
  createParticlePreset({
    id: "kiss-rain",
    title: "Kiss Rain",
    emoji: ["💋", "😘", "💞"],
    headline: "Catch this kiss",
    subline: "Sent with maximum drama and zero regrets.",
    background: "linear-gradient(180deg, #3f0d12 0%, #a71d31 45%, #ff4d6d 100%)",
    accent: "#ffe5ec",
    accentSoft: "rgba(255, 229, 236, 0.6)",
  }),
  createParticlePreset({
    id: "starlight",
    title: "Starlight",
    emoji: ["✨", "⭐", "🌙", "💫"],
    headline: "My favorite star",
    subline: "The night looks better with your name on it.",
    background: "radial-gradient(circle at top, #274c77 0%, #1b263b 44%, #0d1b2a 100%)",
    accent: "#e0fbfc",
    accentSoft: "rgba(224, 251, 252, 0.5)",
  }),
  createParticlePreset({
    id: "confetti-love",
    title: "Confetti Love",
    emoji: ["🎉", "🎊", "❤️", "✨"],
    headline: "You are my celebration",
    subline: "Every day with you deserves confetti.",
    background: "linear-gradient(135deg, #14213d 0%, #fca311 100%)",
    accent: "#fff4d6",
    accentSoft: "rgba(255, 244, 214, 0.55)",
  }),
  createParticlePreset({
    id: "sparkle-trail",
    title: "Sparkle Trail",
    emoji: ["✨", "🌟", "💫"],
    headline: "You sparkle everything",
    subline: "Even the ordinary moments shine with you around.",
    background: "radial-gradient(circle at top, #3a0ca3 0%, #240046 46%, #10002b 100%)",
    accent: "#e0aaff",
    accentSoft: "rgba(224, 170, 255, 0.55)",
  }),
  createParticlePreset({
    id: "butterfly-dream",
    title: "Butterfly Dream",
    emoji: ["🦋", "🌼", "✨"],
    headline: "You give me butterflies",
    subline: "Still, after all this time.",
    background: "linear-gradient(160deg, #cdb4db 0%, #a2d2ff 55%, #ffc8dd 100%)",
    accent: "#fefae0",
    accentSoft: "rgba(254, 250, 224, 0.6)",
  }),
  createParticlePreset({
    id: "snowfall-love",
    title: "Snowfall Love",
    emoji: ["❄️", "💙", "✨"],
    headline: "Cozy with you",
    subline: "Every winter feels warmer next to you.",
    background: "linear-gradient(180deg, #03045e 0%, #023e8a 45%, #0077b6 100%)",
    accent: "#caf0f8",
    accentSoft: "rgba(202, 240, 248, 0.55)",
  }),
  createParticlePreset({
    id: "firefly-night",
    title: "Firefly Night",
    emoji: ["🌟", "🌙", "✨"],
    headline: "You light up the dark",
    subline: "A quiet night, a thousand tiny lights, just like you.",
    background: "radial-gradient(circle at bottom, #14213d 0%, #0b132b 55%, #03040a 100%)",
    accent: "#ffe066",
    accentSoft: "rgba(255, 224, 102, 0.5)",
  }),
  createParticlePreset({
    id: "balloon-rise",
    title: "Balloon Rise",
    emoji: ["🎈", "🎈", "💝"],
    headline: "My heart keeps rising with you",
    subline: "Light, happy, and floating straight toward you.",
    background: "linear-gradient(160deg, #ffafcc 0%, #ffc8dd 45%, #bde0fe 100%)",
    accent: "#fff0f3",
    accentSoft: "rgba(255, 240, 243, 0.65)",
  }),
  {
    id: "floating-letter",
    title: "Love Letter",
    max_views: 1,
    html_content: `
      <div class="scene">
        <div class="envelope">
          <div class="letter">
            <div class="small">sealed for you</div>
            <h1>You make my world softer.</h1>
            <p>I wanted your screen to feel like a handwritten hug.</p>
          </div>
        </div>
      </div>
    `,
    css_content: `
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        overflow: hidden;
        background: linear-gradient(135deg, #fef6e4, #f3d2c1 50%, #8c5e58 100%);
        font-family: Georgia, serif;
      }
      .scene {
        padding: 24px;
      }
      .envelope {
        position: relative;
        width: min(84vw, 360px);
        padding: 20px;
        border-radius: 30px;
        background: rgba(255,255,255,0.14);
        backdrop-filter: blur(14px);
        box-shadow: 0 24px 70px rgba(60, 28, 21, 0.24);
        animation: drift 4s ease-in-out infinite;
      }
      .letter {
        border-radius: 24px;
        background: #fffaf3;
        color: #5c3b33;
        padding: 28px 24px;
        box-shadow: inset 0 0 0 1px rgba(140, 94, 88, 0.1);
      }
      .small {
        text-transform: uppercase;
        letter-spacing: 0.24em;
        font-size: 0.7rem;
        opacity: 0.65;
      }
      h1 {
        margin: 10px 0 12px;
        font-size: clamp(1.9rem, 7vw, 3rem);
        line-height: 0.98;
      }
      p {
        margin: 0;
        line-height: 1.6;
        font-size: 1rem;
      }
      @keyframes drift {
        0%, 100% { transform: translateY(0) rotate(-1deg); }
        50% { transform: translateY(-12px) rotate(1deg); }
      }
    `,
    js_content: "",
  },
  {
    id: "neon-promise",
    title: "Neon Promise",
    max_views: 1,
    html_content: `
      <main class="wrap">
        <p class="eyebrow">for my person</p>
        <h1>I still choose you.</h1>
        <p class="copy">Loudly. Softly. Again and again.</p>
      </main>
    `,
    css_content: `
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        overflow: hidden;
        background: radial-gradient(circle at top, #0b132b 0%, #05070f 72%);
        color: #f8f9ff;
        font-family: "Trebuchet MS", sans-serif;
      }
      .wrap {
        text-align: center;
        padding: 32px;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.35em;
        font-size: 0.76rem;
        opacity: 0.6;
      }
      h1 {
        margin: 14px 0;
        font-size: clamp(2.5rem, 11vw, 5rem);
        line-height: 0.9;
        letter-spacing: -0.06em;
        color: #ff8fab;
        text-shadow: 0 0 12px rgba(255, 143, 171, 0.55), 0 0 34px rgba(255, 143, 171, 0.4);
        animation: flicker 2.4s infinite;
      }
      .copy {
        margin: 0;
        font-size: 1.05rem;
        color: rgba(248, 249, 255, 0.78);
      }
      @keyframes flicker {
        0%, 18%, 22%, 25%, 53%, 57%, 100% { opacity: 1; }
        20%, 24%, 55% { opacity: 0.5; }
      }
    `,
    js_content: "",
  },
  {
    id: "orbiting-hearts",
    title: "Orbiting Hearts",
    max_views: 1,
    html_content: `
      <div class="scene">
        <div class="center">US</div>
        <div class="orbit orbit-a"><span>❤️</span></div>
        <div class="orbit orbit-b"><span>💫</span></div>
        <div class="orbit orbit-c"><span>💕</span></div>
        <div class="caption">You are my favorite gravity.</div>
      </div>
    `,
    css_content: `
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at center, #432371 0%, #1f1147 48%, #09030f 100%);
        overflow: hidden;
        font-family: Arial, sans-serif;
        color: white;
      }
      .scene {
        position: relative;
        width: min(88vw, 360px);
        aspect-ratio: 1;
        display: grid;
        place-items: center;
      }
      .center {
        width: 110px;
        height: 110px;
        border-radius: 999px;
        display: grid;
        place-items: center;
        background: rgba(255,255,255,0.12);
        backdrop-filter: blur(10px);
        font-size: 2rem;
        font-weight: 700;
        box-shadow: 0 0 60px rgba(255, 155, 230, 0.28);
      }
      .orbit {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.1);
      }
      .orbit span {
        position: absolute;
        top: -10px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 1.8rem;
      }
      .orbit-a { animation: spin 8s linear infinite; }
      .orbit-b { inset: 26px; animation: spin 5.5s linear infinite reverse; }
      .orbit-c { inset: 52px; animation: spin 3.8s linear infinite; }
      .caption {
        position: absolute;
        bottom: -22px;
        font-size: 0.96rem;
        color: rgba(255,255,255,0.75);
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    `,
    js_content: "",
  },
  {
    id: "typewriter-love",
    title: "Typewriter Love",
    max_views: 1,
    html_content: `
      <main class="stage">
        <div class="line">Loading feelings...</div>
        <h1 id="type"></h1>
      </main>
    `,
    css_content: `
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: linear-gradient(135deg, #111827, #1f2937, #7c3aed);
        color: white;
        overflow: hidden;
        font-family: "Courier New", monospace;
      }
      .stage {
        width: min(90vw, 420px);
        padding: 24px;
      }
      .line {
        font-size: 0.78rem;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        opacity: 0.65;
        margin-bottom: 12px;
      }
      h1 {
        margin: 0;
        min-height: 3.4em;
        font-size: clamp(2rem, 8vw, 3.2rem);
        line-height: 1;
        letter-spacing: -0.04em;
      }
      h1::after {
        content: "|";
        animation: blink 0.9s infinite;
      }
      @keyframes blink {
        0%, 49% { opacity: 1; }
        50%, 100% { opacity: 0; }
      }
    `,
    js_content: `
      const text = "Every version of my future looks better with you in it.";
      const target = document.getElementById("type");
      let index = 0;
      const timer = setInterval(() => {
        target.textContent = text.slice(0, index);
        index += 1;
        if (index > text.length) clearInterval(timer);
      }, 55);
    `,
  },
  {
    id: "scratch-reveal",
    title: "Scratch to Reveal",
    max_views: 1,
    reactive: true,
    html_content: `
      <div class="scene">
        <div class="card">
          <div class="hidden-message">
            <div class="small">a secret, just for you</div>
            <h1>You are my favorite person.</h1>
          </div>
          <canvas id="scratch" class="scratch-layer"></canvas>
          <div class="hint" id="hint">scratch me ✨</div>
        </div>
      </div>
    `,
    css_content: `
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; overflow: hidden;
        background: radial-gradient(circle at 30% 20%, #3a1c5c, #150a2b 70%); font-family: Georgia, serif; }
      .scene { padding: 20px; }
      .card { position: relative; width: min(86vw, 340px); aspect-ratio: 4/3; border-radius: 26px; overflow: hidden;
        box-shadow: 0 24px 70px rgba(0,0,0,0.4); }
      .hidden-message { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 28px;
        background: linear-gradient(135deg,#ffd1e8,#c9a7ff); color: #33194f; }
      .hidden-message .small { text-transform: uppercase; letter-spacing: .22em; font-size: .68rem; opacity: .65; margin-bottom: 8px; }
      .hidden-message h1 { margin: 0; font-size: clamp(1.5rem, 6.4vw, 2.1rem); line-height: 1.15; }
      .scratch-layer { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: pointer; }
      .hint { position: absolute; bottom: 14px; left: 0; right: 0; text-align: center; font-family: Arial, sans-serif;
        font-size: .78rem; letter-spacing: .08em; color: rgba(255,255,255,0.85); pointer-events: none;
        text-shadow: 0 1px 6px rgba(0,0,0,0.35); transition: opacity .4s ease; }
    `,
    js_content: `
      const canvas = document.getElementById("scratch");
      const hint = document.getElementById("hint");
      const card = document.querySelector(".card");
      let ctx, w, h, revealed = false;

      const size = () => {
        const rect = card.getBoundingClientRect();
        w = canvas.width = rect.width; h = canvas.height = rect.height;
        ctx = canvas.getContext("2d");
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, "#cfd8e3"); grad.addColorStop(0.5, "#f4f6f9"); grad.addColorStop(1, "#aab4c2");
        ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
        ctx.font = "700 14px Arial"; ctx.fillStyle = "rgba(90,90,110,0.35)"; ctx.textAlign = "center";
        ctx.fillText("SCRATCH HERE", w / 2, h / 2);
      };
      size();

      const scratchAt = (x, y) => {
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.fill();
      };

      const checkCleared = () => {
        if (revealed) return;
        const data = ctx.getImageData(0, 0, w, h).data;
        let cleared = 0;
        for (let i = 3; i < data.length; i += 4 * 37) if (data[i] === 0) cleared++;
        if (cleared / (data.length / (4 * 37)) > 0.55) {
          revealed = true;
          hint.style.opacity = "0";
          canvas.style.transition = "opacity .6s ease";
          canvas.style.opacity = "0";
          setTimeout(() => canvas.remove(), 650);
        }
      };

      let drawing = false;
      const pos = (e) => {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      };
      canvas.addEventListener("pointerdown", (e) => { drawing = true; const p = pos(e); scratchAt(p.x, p.y); hint.style.opacity = "0"; });
      canvas.addEventListener("pointermove", (e) => { if (!drawing) return; const p = pos(e); scratchAt(p.x, p.y); checkCleared(); });
      window.addEventListener("pointerup", () => { drawing = false; checkCleared(); });
      window.addEventListener("resize", size);
    `,
  },
  {
    id: "hold-to-bloom",
    title: "Hold to Bloom",
    max_views: 1,
    reactive: true,
    html_content: `
      <div class="scene">
        <div class="bud-wrap" id="press">
          <div class="petals">
            <span class="petal p1"></span><span class="petal p2"></span><span class="petal p3"></span>
            <span class="petal p4"></span><span class="petal p5"></span><span class="petal p6"></span>
            <div class="core"></div>
          </div>
        </div>
        <div class="caption" id="caption">press and hold to watch it bloom</div>
        <div id="burst" class="burst"></div>
      </div>
    `,
    css_content: `
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; overflow: hidden;
        background: linear-gradient(160deg,#fff1f4,#ffe3ea 55%,#ffd0dd); font-family: Arial, sans-serif; }
      .scene { position: relative; width: min(90vw, 380px); display: grid; place-items: center; gap: 22px; padding: 24px; }
      .bud-wrap { width: 140px; height: 140px; display: grid; place-items: center; cursor: pointer; touch-action: none; user-select: none; }
      .petals { position: relative; width: 60px; height: 60px; transition: transform .15s ease; }
      .petal { position: absolute; inset: 0; margin: auto; width: 26px; height: 42px; border-radius: 50% 50% 50% 50%/60% 60% 40% 40%;
        background: linear-gradient(180deg, #ff8fab, #ff4d6d); transform-origin: 50% 100%;
        transform: scale(0.25) rotate(var(--rot,0deg)) translateY(0); opacity: 0.5; transition: transform .6s cubic-bezier(.2,.8,.2,1), opacity .6s ease; }
      .p1 { --rot: 0deg; } .p2 { --rot: 60deg; } .p3 { --rot: 120deg; } .p4 { --rot: 180deg; } .p5 { --rot: 240deg; } .p6 { --rot: 300deg; }
      .core { position: absolute; inset: 0; margin: auto; width: 16px; height: 16px; border-radius: 999px;
        background: radial-gradient(circle, #ffe27a, #ffb703); box-shadow: 0 0 16px rgba(255,183,3,0.7); }
      .caption { font-size: .9rem; color: #7a3b4c; text-align: center; transition: opacity .4s ease; }
      .burst { position: absolute; inset: 0; pointer-events: none; }
      .burst span { position: absolute; top: 50%; left: 50%; font-size: 1.1rem; opacity: 0; }
    `,
    js_content: `
      const press = document.getElementById("press");
      const petals = document.querySelector(".petals");
      const caption = document.getElementById("caption");
      const burst = document.getElementById("burst");
      let holding = false, progress = 0, raf, bloomed = false;

      const setBloom = (p) => {
        document.querySelectorAll(".petal").forEach((el) => {
          const scale = (0.25 + p * 0.95).toFixed(3);
          const lift = (p * 10).toFixed(1);
          el.style.transform = 'scale(' + scale + ') rotate(var(--rot,0deg)) translateY(-' + lift + 'px)';
          el.style.opacity = String(0.5 + p * 0.5);
        });
        petals.style.transform = 'scale(' + (1 + p * 0.35).toFixed(3) + ')';
      };

      const tick = () => {
        if (holding && progress < 1) progress = Math.min(1, progress + 0.018);
        else if (!holding && !bloomed) progress = Math.max(0, progress - 0.03);
        setBloom(progress);
        if (progress >= 1 && !bloomed) {
          bloomed = true;
          caption.textContent = "you make everything bloom 🌸";
          for (let i = 0; i < 14; i++) {
            const s = document.createElement("span");
            s.textContent = ["🌸","✨","💗"][i % 3];
            const angle = (Math.PI * 2 * i) / 14;
            s.style.setProperty("--dx", Math.cos(angle) * 90 + "px");
            s.style.setProperty("--dy", Math.sin(angle) * 90 + "px");
            s.animate(
              [{ transform: "translate(-50%,-50%) translate(0,0)", opacity: 1 },
               { transform: 'translate(-50%,-50%) translate(' + Math.cos(angle) * 90 + 'px,' + Math.sin(angle) * 90 + 'px)', opacity: 0 }],
              { duration: 900, easing: "cubic-bezier(.2,.8,.2,1)" }
            );
            burst.appendChild(s);
            setTimeout(() => s.remove(), 950);
          }
        }
        if (progress > 0 || holding) raf = requestAnimationFrame(tick);
      };

      const start = () => { if (bloomed) return; holding = true; cancelAnimationFrame(raf); tick(); };
      const end = () => { holding = false; };
      press.addEventListener("pointerdown", start);
      window.addEventListener("pointerup", end);
    `,
  },
  {
    id: "whisper-orb",
    title: "Whisper Orb",
    max_views: 1,
    reactive: true,
    html_content: `
      <div class="scene">
        <div class="target" id="target"><span>bring it home</span></div>
        <div class="orb" id="orb"></div>
        <div class="reveal" id="reveal">
          <p>Every road I wander still leads back to you.</p>
        </div>
      </div>
    `,
    css_content: `
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; overflow: hidden;
        background: radial-gradient(circle at 50% 20%, #1b1035, #0a0616 75%); font-family: Georgia, serif; }
      .scene { position: relative; width: min(90vw, 380px); height: min(70vh, 480px); }
      .target { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); width: 130px; height: 130px;
        border-radius: 999px; border: 2px dashed rgba(255,255,255,0.25); display: grid; place-items: center; text-align: center;
        color: rgba(255,255,255,0.55); font-family: Arial, sans-serif; font-size: .72rem; letter-spacing: .1em; text-transform: uppercase; }
      .orb { position: absolute; left: 50%; bottom: 24px; width: 64px; height: 64px; margin-left: -32px; border-radius: 999px;
        background: radial-gradient(circle at 35% 30%, #ffe9ff, #c084fc 60%, #7c3aed); box-shadow: 0 0 40px rgba(192,132,252,0.65);
        cursor: grab; touch-action: none; transition: box-shadow .3s ease; }
      .reveal { position: absolute; inset: 0; display: grid; place-items: center; padding: 32px; text-align: center;
        opacity: 0; transform: translateY(12px); transition: opacity .8s ease, transform .8s ease; pointer-events: none; }
      .reveal p { color: #ffe9ff; font-size: clamp(1.15rem, 5.2vw, 1.5rem); line-height: 1.5; margin: 0; }
      .target.hit { border-color: rgba(255,255,255,0.7); box-shadow: 0 0 30px rgba(255,255,255,0.25) inset; }
    `,
    js_content: `
      const orb = document.getElementById("orb");
      const target = document.getElementById("target");
      const reveal = document.getElementById("reveal");
      let dragging = false, ox = 0, oy = 0, settled = false;

      const within = (a, b, dist) => {
        const dx = a.left + a.width/2 - (b.left + b.width/2);
        const dy = a.top + a.height/2 - (b.top + b.height/2);
        return Math.hypot(dx, dy) < dist;
      };

      const onDown = (e) => {
        if (settled) return;
        dragging = true;
        const r = orb.getBoundingClientRect();
        ox = e.clientX - r.left; oy = e.clientY - r.top;
        orb.style.cursor = "grabbing";
      };
      const onMove = (e) => {
        if (!dragging) return;
        const scene = document.querySelector(".scene").getBoundingClientRect();
        let x = e.clientX - scene.left - ox;
        let y = e.clientY - scene.top - oy;
        x = Math.max(-10, Math.min(scene.width - 54, x));
        y = Math.max(-10, Math.min(scene.height - 54, y));
        orb.style.left = x + "px"; orb.style.bottom = "auto"; orb.style.top = y + "px"; orb.style.marginLeft = "0";

        const orbRect = orb.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        target.classList.toggle("hit", within(orbRect, targetRect, 90));
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        orb.style.cursor = "grab";
        const orbRect = orb.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        if (within(orbRect, targetRect, 90) && !settled) {
          settled = true;
          orb.style.transition = "top .4s ease, left .4s ease, opacity .6s ease";
          const tr = target.getBoundingClientRect();
          const scene = document.querySelector(".scene").getBoundingClientRect();
          orb.style.left = (tr.left - scene.left + tr.width/2 - 32) + "px";
          orb.style.top = (tr.top - scene.top + tr.height/2 - 32) + "px";
          setTimeout(() => {
            orb.style.opacity = "0";
            reveal.style.opacity = "1";
            reveal.style.transform = "translateY(0)";
          }, 420);
        }
      };
      orb.addEventListener("pointerdown", onDown);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    `,
  },
];

export const defaultSurprisePreset = surprisePresets[0];

export const buildSurpriseDocument = ({ title, html_content, css_content, js_content }: SurpriseDraft) => {
  const safeScript = js_content.replace(/<\/script/gi, "<\\/script");

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>${title}</title>
        <style>
          html, body {
            width: 100%;
            height: 100%;
          }

          body {
            margin: 0;
            overflow: hidden;
            background: transparent;
          }

          *, *::before, *::after {
            box-sizing: border-box;
          }

          ${css_content}
        </style>
      </head>
      <body>
        ${html_content}
        <script>
          window.addEventListener("error", (event) => {
            window.parent?.postMessage({ type: "code-surprise-error", message: event.message }, "*");
          });

          try {
            ${safeScript}
          } catch (error) {
            window.parent?.postMessage({
              type: "code-surprise-error",
              message: error instanceof Error ? error.message : String(error),
            }, "*");
          }
        </scr${""}ipt>
      </body>
    </html>
  `;
};
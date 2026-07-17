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
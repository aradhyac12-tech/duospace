// The document builder (and the SurpriseDraft type) moved to
// ./surpriseDocument — it grew a real runtime (error reporting, autoplay
// unlock, link forwarding, URL normalization) and is shared with the
// importer. Re-exported here so existing imports keep working.
export { buildSurpriseDocument } from "./surpriseDocument";
export type { SurpriseDraft } from "./surpriseDocument";

type ParticleMotion =
  | "fall" | "petal" | "rise" | "twinkle" | "pop" | "burst"
  | "flutter" | "snow" | "firefly" | "trail"
  // v3.12 — motions with their own physics, not just a different emoji set
  | "meteor" | "bubble" | "matrix" | "orbit" | "rain" | "lantern" | "spiral" | "sway" | "zoom" | "ember";
type ParticleLook =
  | "glass" | "plain" | "poster" | "script"
  // v3.12 — typography/card treatments
  | "neon" | "frost" | "mono" | "polaroid" | "outline" | "stamp" | "handwritten" | "retro";

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
  /** How the particles MOVE — each preset gets its own motion so they no
   *  longer all read as "emoji falling down a screen". */
  motion?: ParticleMotion;
  /** Typography + card treatment, so the message itself also differs. */
  look?: ParticleLook;
  /** Pulse the headline like a heartbeat. */
  beat?: boolean;
};

// NOTE: no `backdrop-filter` and no `filter: blur()` anywhere in these
// documents. Inside the sandboxed frame (itself inside a 3D-transformed,
// glass-backed card) they made Android WebView blur the WHOLE frame.
// Soft looks are done with gradients / translucent fills instead.
const LOOKS: Record<string, string> = {
  glass: `
    .message-card { padding: 28px 24px; border-radius: 28px; background: rgba(255,255,255,0.16);
      border: 1px solid rgba(255,255,255,0.24); box-shadow: 0 20px 80px rgba(0,0,0,0.22);
      animation: floatCard 3.6s ease-in-out infinite; }
    .headline { font-size: clamp(2rem, 7vw, 3.25rem); line-height: 0.95; font-weight: 700; letter-spacing: -0.04em; }
  `,
  plain: `
    .message-card { padding: 8px; }
    .headline { font-size: clamp(1.8rem, 6.5vw, 3rem); line-height: 1.15; font-weight: 400; letter-spacing: 0.08em;
      text-shadow: 0 2px 24px rgba(0,0,0,0.35); }
    .subline { letter-spacing: 0.04em; }
  `,
  poster: `
    .message-card { padding: 22px 20px; border: 2px solid rgba(255,255,255,0.75); border-radius: 6px; background: rgba(0,0,0,0.2); }
    .headline { font-family: Impact, "Arial Black", sans-serif; text-transform: uppercase; font-weight: 400;
      font-size: clamp(1.9rem, 8vw, 3.4rem); line-height: 0.95; letter-spacing: 0.02em; }
    .subline { font-family: system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.18em; font-size: 0.72rem; }
  `,
  script: `
    .scene { place-items: end center; padding-bottom: 14vh; }
    .message-card { padding: 12px; }
    .headline { font-style: italic; font-weight: 400; font-size: clamp(2rem, 8vw, 3.4rem); line-height: 1.05;
      text-shadow: 0 2px 18px rgba(0,0,0,0.28); }
  `,
};

const MOTION_CSS: Record<string, string> = {
  fall: `
    .particle { top: -12vh; animation-name: fall; animation-timing-function: linear; }
    @keyframes fall { 0% { transform: translate3d(0,0,0) rotate(0deg) scale(.9); }
      100% { transform: translate3d(var(--drift),118vh,0) rotate(360deg) scale(1.1); } }`,
  petal: `
    .particle { top: -12vh; animation-name: petal; animation-timing-function: ease-in-out; }
    @keyframes petal { 0% { transform: translate3d(0,0,0) rotate(0deg); }
      25% { transform: translate3d(34px,30vh,0) rotate(70deg); } 50% { transform: translate3d(-28px,60vh,0) rotate(150deg); }
      75% { transform: translate3d(30px,90vh,0) rotate(230deg); } 100% { transform: translate3d(0,120vh,0) rotate(300deg); } }`,
  rise: `
    .particle { bottom: -14vh; animation-name: rise; animation-timing-function: linear; }
    @keyframes rise { 0% { transform: translate3d(0,0,0) rotate(-6deg); }
      50% { transform: translate3d(var(--drift),-60vh,0) rotate(6deg); }
      100% { transform: translate3d(calc(var(--drift) * -1),-128vh,0) rotate(-6deg); } }`,
  twinkle: `
    .particle { top: var(--top); opacity: 0; animation-name: twinkle; animation-timing-function: ease-in-out; }
    @keyframes twinkle { 0%,100% { opacity: 0; transform: scale(.3) rotate(0deg); }
      50% { opacity: 1; transform: scale(1.15) rotate(25deg); } }`,
  pop: `
    .particle { bottom: -8vh; opacity: 0; animation-name: pop; animation-timing-function: cubic-bezier(.2,.8,.3,1); }
    @keyframes pop { 0% { opacity: 0; transform: translate3d(0,0,0) scale(.4); }
      12% { opacity: 1; transform: translate3d(0,-8vh,0) scale(1.15); }
      100% { opacity: 0; transform: translate3d(var(--drift),-92vh,0) scale(1.5) rotate(var(--rot)); } }`,
  burst: `
    .particle { left: 50%; top: 50%; animation-name: burst; animation-timing-function: cubic-bezier(.1,.7,.3,1); }
    @keyframes burst { 0% { opacity: 1; transform: translate(-50%,-50%) scale(.2); }
      65% { opacity: 1; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) rotate(var(--rot)) scale(1); }
      100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy) + 34vh)) rotate(calc(var(--rot) * 2)) scale(.9); } }`,
  flutter: `
    .particle { left: -12vw; top: var(--top); animation-name: flutter; animation-timing-function: ease-in-out; }
    @keyframes flutter { 0% { transform: translate3d(0,0,0) scaleX(1); }
      25% { transform: translate3d(32vw,-44px,0) scaleX(.55); } 50% { transform: translate3d(64vw,30px,0) scaleX(1); }
      75% { transform: translate3d(96vw,-36px,0) scaleX(.55); } 100% { transform: translate3d(128vw,0,0) scaleX(1); } }`,
  snow: `
    .particle { top: -8vh; animation-name: snow; animation-timing-function: linear; }
    @keyframes snow { 0% { transform: translate3d(0,0,0); } 33% { transform: translate3d(18px,38vh,0); }
      66% { transform: translate3d(-18px,76vh,0); } 100% { transform: translate3d(var(--drift),116vh,0); } }`,
  firefly: `
    .particle { top: var(--top); opacity: .2; animation-name: firefly; animation-timing-function: ease-in-out;
      text-shadow: 0 0 14px var(--accent), 0 0 30px var(--accent); }
    @keyframes firefly { 0%,100% { transform: translate3d(0,0,0); opacity: .15; }
      25% { transform: translate3d(var(--dx),var(--dy),0); opacity: 1; }
      50% { transform: translate3d(calc(var(--dx) * -.6),calc(var(--dy) * .8),0); opacity: .3; }
      75% { transform: translate3d(calc(var(--dx) * .5),calc(var(--dy) * -1),0); opacity: 1; } }`,
  trail: `
    .particle { top: var(--top); opacity: 0; animation-name: twinkle; animation-timing-function: ease-in-out; }
    .trail { position: absolute; pointer-events: none; animation: trailFade 1.1s ease-out forwards; }
    @keyframes twinkle { 0%,100% { opacity: 0; transform: scale(.3); } 50% { opacity: .8; transform: scale(1); } }
    @keyframes trailFade { 0% { opacity: 1; transform: translate(-50%,-50%) scale(1); }
      100% { opacity: 0; transform: translate(-50%, calc(-50% + 46px)) scale(.3) rotate(80deg); } }`,
};

// Per-motion particle setup (runs inside the surprise frame).
const MOTION_JS: Record<string, string> = {
  fall: `p.style.setProperty("--drift",(-40+Math.random()*80)+"px");`,
  petal: `p.style.setProperty("--size",(1.3+Math.random()*1.4)+"rem");`,
  rise: `p.style.setProperty("--drift",(-50+Math.random()*100)+"px");`,
  twinkle: `p.style.setProperty("--top",(Math.random()*100)+"%");p.style.setProperty("--size",(.6+Math.random()*1.2)+"rem");`,
  pop: `p.style.setProperty("--drift",(-70+Math.random()*140)+"px");p.style.setProperty("--rot",(-40+Math.random()*80)+"deg");`,
  burst: `var a=Math.random()*Math.PI*2,r=90+Math.random()*180;p.style.setProperty("--dx",Math.cos(a)*r+"px");p.style.setProperty("--dy",(Math.sin(a)*r-60)+"px");p.style.setProperty("--rot",(Math.random()*360)+"deg");p.style.setProperty("--duration",(2.2+Math.random()*1.6)+"s");`,
  flutter: `p.style.setProperty("--top",(8+Math.random()*80)+"%");p.style.setProperty("--duration",(9+Math.random()*7)+"s");p.style.setProperty("--size",(1.4+Math.random()*1.2)+"rem");`,
  snow: `p.style.setProperty("--drift",(-30+Math.random()*60)+"px");p.style.setProperty("--size",(.5+Math.random()*.9)+"rem");p.style.setProperty("--duration",(9+Math.random()*7)+"s");`,
  firefly: `p.style.setProperty("--top",(20+Math.random()*75)+"%");p.style.setProperty("--dx",(-80+Math.random()*160)+"px");p.style.setProperty("--dy",(-70+Math.random()*140)+"px");p.style.setProperty("--size",(.7+Math.random()*.7)+"rem");p.style.setProperty("--duration",(6+Math.random()*6)+"s");`,
  trail: `p.style.setProperty("--top",(Math.random()*100)+"%");p.style.setProperty("--size",(.7+Math.random()*1)+"rem");`,
};

const EXTRA_LOOKS: Record<string, string> = {
  neon: `
    .message-card { padding: 18px 16px; }
    .headline { font-family: "Trebuchet MS", system-ui, sans-serif; font-weight: 700; font-size: clamp(2rem, 8vw, 3.4rem);
      line-height: 1; color: #fff; letter-spacing: 0.02em;
      text-shadow: 0 0 6px #fff, 0 0 16px var(--accent), 0 0 34px var(--accent), 0 0 64px var(--accent);
      animation: neonFlicker 3.2s infinite; }
    .subline { color: var(--accent); text-shadow: 0 0 10px var(--accent); letter-spacing: 0.12em; text-transform: lowercase; }
    @keyframes neonFlicker { 0%,19%,21%,62%,64%,100% { opacity: 1; } 20%,63% { opacity: .55; } }`,
  frost: `
    .message-card { padding: 30px 24px; border-radius: 40px 8px 40px 8px; background: linear-gradient(145deg, rgba(255,255,255,.34), rgba(255,255,255,.08));
      border: 1px solid rgba(255,255,255,.55); box-shadow: inset 0 0 40px rgba(255,255,255,.18), 0 18px 60px rgba(0,30,80,.35); }
    .headline { font-weight: 300; font-size: clamp(1.9rem, 7vw, 3rem); line-height: 1.05; letter-spacing: .12em; text-transform: uppercase; }`,
  mono: `
    .message-card { padding: 20px; text-align: left; border-left: 3px solid var(--accent); background: rgba(0,0,0,.35); border-radius: 4px; }
    .headline { font-family: "Courier New", monospace; font-weight: 700; font-size: clamp(1.4rem, 5.6vw, 2.4rem); line-height: 1.15; color: var(--accent); }
    .headline::after { content: "▌"; animation: caret 1s steps(1) infinite; }
    .subline { font-family: "Courier New", monospace; font-size: .85rem; }
    @keyframes caret { 50% { opacity: 0; } }`,
  polaroid: `
    .message-card { padding: 18px 18px 54px; background: #fdfcf7; color: #3b2f2f; border-radius: 3px; transform: rotate(-3deg);
      box-shadow: 0 18px 50px rgba(0,0,0,.4); max-width: 290px; }
    .message-card::before { content: ""; display: block; height: 170px; margin-bottom: 14px; border-radius: 2px;
      background: radial-gradient(circle at 30% 30%, var(--accent-soft), transparent 55%), linear-gradient(160deg, var(--accent), #0008); }
    .headline { font-family: "Comic Sans MS", "Bradley Hand", cursive; font-size: clamp(1.3rem, 5.4vw, 2rem); line-height: 1.1; }
    .subline { color: #6d5a54; font-size: .85rem; }`,
  outline: `
    .message-card { padding: 10px; }
    .headline { font-family: Impact, "Arial Black", sans-serif; font-weight: 400; text-transform: uppercase; font-size: clamp(2.4rem, 11vw, 4.6rem);
      line-height: .9; color: transparent; -webkit-text-stroke: 2px #fff; letter-spacing: .02em; }
    .subline { letter-spacing: .3em; text-transform: uppercase; font-size: .68rem; }`,
  stamp: `
    .message-card { padding: 22px 26px; border: 4px double var(--accent); border-radius: 12px; transform: rotate(-6deg);
      background: rgba(0,0,0,.18); animation: stampIn .7s cubic-bezier(.2,1.6,.4,1) both; }
    .headline { font-family: "Courier New", monospace; font-weight: 900; text-transform: uppercase; letter-spacing: .14em;
      font-size: clamp(1.6rem, 6.6vw, 2.6rem); color: var(--accent); }
    @keyframes stampIn { 0% { transform: rotate(-6deg) scale(2.6); opacity: 0; } 100% { transform: rotate(-6deg) scale(1); opacity: 1; } }`,
  handwritten: `
    .scene { place-items: start center; padding-top: 18vh; }
    .message-card { padding: 10px; max-width: 300px; transform: rotate(-2deg); }
    .headline { font-family: "Bradley Hand", "Segoe Script", "Comic Sans MS", cursive; font-weight: 400; font-size: clamp(2.1rem, 8.4vw, 3.4rem);
      line-height: 1.12; text-shadow: 0 1px 0 rgba(0,0,0,.25); }
    .subline { font-family: "Bradley Hand", "Segoe Script", cursive; font-size: 1.15rem; }`,
  retro: `
    .message-card { padding: 22px; background: linear-gradient(180deg, #ff2e93aa, #ffb000aa); border: 3px solid #fff; border-radius: 0; box-shadow: 8px 8px 0 #000a; }
    .headline { font-family: "Arial Black", Impact, sans-serif; font-style: italic; font-weight: 900; text-transform: uppercase;
      font-size: clamp(1.8rem, 7.4vw, 3rem); line-height: .95; text-shadow: 3px 3px 0 #000; }
    .subline { font-family: "Courier New", monospace; font-weight: 700; text-shadow: 2px 2px 0 #000; }`,
};
Object.assign(LOOKS, EXTRA_LOOKS);

const EXTRA_MOTION_CSS: Record<string, string> = {
  meteor: `
    .particle { top: -6vh; left: var(--left); animation-name: meteor; animation-timing-function: cubic-bezier(.4,0,1,1); opacity: 0;
      text-shadow: 0 0 12px var(--accent), -16px -16px 22px var(--accent); }
    @keyframes meteor { 0% { transform: translate3d(0,0,0) rotate(-35deg); opacity: 0; } 8% { opacity: 1; }
      100% { transform: translate3d(-55vw,75vh,0) rotate(-35deg); opacity: 0; } }`,
  bubble: `
    .particle { bottom: -10vh; opacity: 0; animation-name: bubble; animation-timing-function: ease-in; }
    @keyframes bubble { 0% { transform: translate3d(0,0,0) scale(.3); opacity: 0; } 10% { opacity: .9; }
      30% { transform: translate3d(22px,-30vh,0) scale(.9); } 55% { transform: translate3d(-22px,-58vh,0) scale(1.05); }
      85% { transform: translate3d(14px,-92vh,0) scale(1.25); opacity: .8; } 100% { transform: translate3d(0,-104vh,0) scale(1.6); opacity: 0; } }`,
  matrix: `
    .particle { top: -10vh; writing-mode: vertical-rl; font-family: "Courier New", monospace; animation-name: matrix; animation-timing-function: linear;
      color: var(--accent); text-shadow: 0 0 8px var(--accent); letter-spacing: .1em; }
    @keyframes matrix { 0% { transform: translate3d(0,0,0); opacity: 0; } 10% { opacity: 1; } 90% { opacity: .9; } 100% { transform: translate3d(0,120vh,0); opacity: 0; } }`,
  orbit: `
    .particle { left: 50%; top: 50%; animation-name: orbit; animation-timing-function: linear; margin: calc(var(--size) * -.5); }
    @keyframes orbit { 0% { transform: rotate(0deg) translateX(var(--radius)) rotate(0deg); }
      100% { transform: rotate(360deg) translateX(var(--radius)) rotate(-360deg); } }`,
  rain: `
    .particle { top: -10vh; font-size: calc(var(--size) * .55); opacity: .75; animation-name: rain; animation-timing-function: linear; transform-origin: top; }
    @keyframes rain { 0% { transform: translate3d(0,0,0) scaleY(1.8); } 100% { transform: translate3d(-40px,115vh,0) scaleY(1.8); } }`,
  lantern: `
    .particle { bottom: -14vh; text-shadow: 0 0 22px var(--accent), 0 0 50px var(--accent); animation-name: lantern; animation-timing-function: ease-in-out; }
    @keyframes lantern { 0% { transform: translate3d(0,0,0) rotate(-4deg) scale(.7); opacity: 0; } 12% { opacity: 1; }
      35% { transform: translate3d(30px,-38vh,0) rotate(5deg) scale(.9); } 70% { transform: translate3d(-30px,-82vh,0) rotate(-5deg) scale(.8); }
      100% { transform: translate3d(10px,-124vh,0) rotate(3deg) scale(.6); opacity: 0; } }`,
  spiral: `
    .particle { left: 50%; top: 50%; animation-name: spiral; animation-timing-function: ease-out; opacity: 0; }
    @keyframes spiral { 0% { transform: rotate(0deg) translateX(0) scale(.2); opacity: 0; } 15% { opacity: 1; }
      100% { transform: rotate(var(--turn)) translateX(var(--radius)) scale(1.1); opacity: 0; } }`,
  sway: `
    .particle { bottom: -4vh; transform-origin: bottom center; animation-name: sway; animation-timing-function: ease-in-out; }
    @keyframes sway { 0%,100% { transform: rotate(-14deg) scaleY(.9); } 50% { transform: rotate(14deg) scaleY(1.08); } }`,
  zoom: `
    .particle { left: 50%; top: 50%; animation-name: zoom; animation-timing-function: cubic-bezier(.3,0,.8,1); opacity: 0; }
    @keyframes zoom { 0% { transform: translate(-50%,-50%) translate(0,0) scale(.1); opacity: 0; } 20% { opacity: 1; }
      100% { transform: translate(-50%,-50%) translate(var(--dx),var(--dy)) scale(2.4); opacity: 0; } }`,
  ember: `
    .particle { bottom: -6vh; filter: none; text-shadow: 0 0 10px #ff9f1c; animation-name: ember; animation-timing-function: ease-out; }
    @keyframes ember { 0% { transform: translate3d(0,0,0) scale(1); opacity: 0; } 10% { opacity: 1; }
      100% { transform: translate3d(var(--drift),-98vh,0) scale(.2) rotate(180deg); opacity: 0; } }`,
};
Object.assign(MOTION_CSS, EXTRA_MOTION_CSS);

const EXTRA_MOTION_JS: Record<string, string> = {
  meteor: `p.style.setProperty("--left",(35+Math.random()*75)+"%");p.style.setProperty("--duration",(1.4+Math.random()*1.6)+"s");p.style.setProperty("--delay",(Math.random()*7)+"s");`,
  bubble: `p.style.setProperty("--size",(1.1+Math.random()*2)+"rem");p.style.setProperty("--duration",(6+Math.random()*6)+"s");`,
  matrix: `p.textContent=["愛","I","L","O","V","E","U","♥","1","0"].sort(function(){return Math.random()-.5}).slice(0,3+Math.floor(Math.random()*4)).join("");p.style.setProperty("--size",(.8+Math.random()*.7)+"rem");p.style.setProperty("--duration",(4+Math.random()*5)+"s");`,
  orbit: `p.style.setProperty("--radius",(70+Math.floor(index/6)*46)+"px");p.style.setProperty("--duration",(8+Math.floor(index/6)*4)+"s");p.style.setProperty("--delay",(-Math.random()*12)+"s");`,
  rain: `p.style.setProperty("--duration",(.9+Math.random()*.9)+"s");p.style.setProperty("--delay",(Math.random()*2)+"s");`,
  lantern: `p.style.setProperty("--size",(1.6+Math.random()*1.6)+"rem");p.style.setProperty("--duration",(11+Math.random()*8)+"s");p.style.setProperty("--delay",(Math.random()*8)+"s");`,
  spiral: `p.style.setProperty("--turn",(540+Math.random()*540)+"deg");p.style.setProperty("--radius",(90+Math.random()*190)+"px");p.style.setProperty("--duration",(3+Math.random()*2.5)+"s");`,
  sway: `p.style.setProperty("--left",(2+index/total*96)+"%");p.style.setProperty("--size",(1.6+Math.random()*1.8)+"rem");p.style.setProperty("--duration",(2.6+Math.random()*2.4)+"s");p.style.setProperty("--delay",(-Math.random()*4)+"s");`,
  zoom: `var a=Math.random()*Math.PI*2,r=180+Math.random()*320;p.style.setProperty("--dx",Math.cos(a)*r+"px");p.style.setProperty("--dy",Math.sin(a)*r+"px");p.style.setProperty("--duration",(1.6+Math.random()*1.8)+"s");`,
  ember: `p.style.setProperty("--drift",(-60+Math.random()*120)+"px");p.style.setProperty("--size",(.4+Math.random()*.8)+"rem");p.style.setProperty("--duration",(3+Math.random()*4)+"s");`,
};
Object.assign(MOTION_JS, EXTRA_MOTION_JS);

const TRAIL_JS = `
    let lastTrail = 0;
    const spawnTrail = (x, y) => {
      const now = Date.now();
      if (now - lastTrail < 45) return;
      lastTrail = now;
      const t = document.createElement("span");
      t.className = "trail";
      t.textContent = icons[Math.floor(Math.random() * icons.length)];
      t.style.left = x + "px";
      t.style.top = y + "px";
      t.style.fontSize = (0.9 + Math.random() * 1.1) + "rem";
      particles.appendChild(t);
      setTimeout(() => t.remove(), 1200);
    };
    document.addEventListener("pointermove", (e) => spawnTrail(e.clientX, e.clientY));
    document.addEventListener("pointerdown", (e) => spawnTrail(e.clientX, e.clientY));
`;

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
  motion = "fall",
  look = "glass",
  beat = false,
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
    :root { --accent: ${accent}; --accent-soft: ${accentSoft}; --bg: ${background}; }
    body { margin: 0; min-height: 100vh; overflow: hidden; background: var(--bg);
      font-family: "Georgia", "Times New Roman", serif; color: white; }
    .scene { position: relative; min-height: 100vh; display: grid; place-items: center; padding: 32px; isolation: isolate; }
    .glow { position: absolute; inset: 8%; border-radius: 999px;
      background: radial-gradient(circle, var(--accent-soft), transparent 62%);
      opacity: 0.85; animation: pulseGlow 4s ease-in-out infinite; }
    .message-card { position: relative; z-index: 2; max-width: 320px; text-align: center; }
    .subline { margin-top: 12px; font-size: 0.98rem; line-height: 1.5; color: rgba(255,255,255,0.86); }
    .particles { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
    .particle { position: absolute; left: var(--left); font-size: var(--size);
      animation-duration: var(--duration); animation-delay: var(--delay); animation-iteration-count: infinite;
      will-change: transform, opacity; }
    ${LOOKS[look]}
    ${MOTION_CSS[motion]}
    ${beat ? `.headline { animation: beat 1.3s ease-in-out infinite; }
    @keyframes beat { 0%,100% { transform: scale(1); } 14% { transform: scale(1.07); } 28% { transform: scale(1); } 42% { transform: scale(1.05); } }` : ""}
    @keyframes floatCard { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
    @keyframes pulseGlow { 0%,100% { transform: scale(0.94); opacity: 0.7; } 50% { transform: scale(1.06); opacity: 1; } }
  `,
  js_content: `
    const icons = ${JSON.stringify(emoji)};
    const particles = document.getElementById("particles");
    const total = ${count};
    for (let index = 0; index < total; index += 1) {
      const p = document.createElement("span");
      p.className = "particle";
      p.textContent = icons[index % icons.length];
      p.style.setProperty("--left", (Math.random() * 100) + "%");
      p.style.setProperty("--delay", (Math.random() * 4) + "s");
      p.style.setProperty("--duration", (5 + Math.random() * 5) + "s");
      p.style.setProperty("--size", (1 + Math.random() * 1.8) + "rem");
      ${MOTION_JS[motion]}
      particles.appendChild(p);
    }
    ${motion === "trail" ? TRAIL_JS : ""}
  `,
});

export const surprisePresets = [
  createParticlePreset({
    id: "hearts-shower",
    motion: "fall", look: "glass",
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
    motion: "petal", look: "plain",
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
    motion: "twinkle", look: "poster", beat: true,
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
    motion: "pop", look: "neon",
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
    motion: "twinkle", look: "plain",
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
    motion: "burst", look: "retro",
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
    motion: "trail", look: "plain",
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
    motion: "flutter", look: "script",
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
    motion: "snow", look: "frost",
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
    motion: "firefly", look: "handwritten",
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
    motion: "rise", look: "script",
    title: "Balloon Rise",
    emoji: ["🎈", "🎈", "💝"],
    headline: "My heart keeps rising with you",
    subline: "Light, happy, and floating straight toward you.",
    background: "linear-gradient(160deg, #ffafcc 0%, #ffc8dd 45%, #bde0fe 100%)",
    accent: "#fff0f3",
    accentSoft: "rgba(255, 240, 243, 0.65)",
  }),
  createParticlePreset({
    id: "shooting-stars", motion: "meteor", look: "outline",
    title: "Shooting Stars",
    emoji: ["☄️", "✨", "⭐"],
    headline: "Make a wish",
    subline: "I already know what I'd ask for: you.",
    background: "radial-gradient(circle at 70% 0%, #1d2b64 0%, #0b1026 55%, #02030a 100%)",
    accent: "#c5d8ff",
    accentSoft: "rgba(197,216,255,0.45)",
    count: 14,
  }),
  createParticlePreset({
    id: "champagne-bubbles", motion: "bubble", look: "frost",
    title: "Champagne Bubbles",
    emoji: ["🫧", "🥂", "✨"],
    headline: "Here's to us",
    subline: "Fizzy, golden, and a little bit dizzy.",
    background: "linear-gradient(180deg, #3d2c00 0%, #b8860b 55%, #ffe8a3 100%)",
    accent: "#fff6d6",
    accentSoft: "rgba(255,246,214,0.6)",
    count: 22,
  }),
  createParticlePreset({
    id: "love-code", motion: "matrix", look: "mono",
    title: "Love Code",
    emoji: ["1", "0", "♥"],
    headline: "> i_love_you.exe",
    subline: "Running… 100% complete. No bugs found.",
    background: "linear-gradient(180deg, #000 0%, #001a09 100%)",
    accent: "#39ff88",
    accentSoft: "rgba(57,255,136,0.35)",
    count: 32,
  }),
  createParticlePreset({
    id: "orbit-of-us", motion: "orbit", look: "neon",
    title: "Orbit of Us",
    emoji: ["🪐", "💫", "❤️", "🌙", "⭐"],
    headline: "You're my gravity",
    subline: "Everything keeps circling back to you.",
    background: "radial-gradient(circle at center, #2b0a4a 0%, #12002a 60%, #05000f 100%)",
    accent: "#ff6ad5",
    accentSoft: "rgba(255,106,213,0.5)",
    count: 24,
  }),
  createParticlePreset({
    id: "love-rain", motion: "rain", look: "plain",
    title: "Love Rain",
    emoji: ["💧", "💙", "💧"],
    headline: "Dance in the rain with me",
    subline: "Some storms are better when we're soaked together.",
    background: "linear-gradient(180deg, #1c2a3a 0%, #2f4858 55%, #5c7a8c 100%)",
    accent: "#d6ecff",
    accentSoft: "rgba(214,236,255,0.4)",
    count: 60,
  }),
  createParticlePreset({
    id: "sky-lanterns", motion: "lantern", look: "handwritten",
    title: "Sky Lanterns",
    emoji: ["🏮", "✨", "🏮"],
    headline: "Sending you my light",
    subline: "Every little lantern carries a thought of you.",
    background: "linear-gradient(180deg, #0b0c2a 0%, #2a1b4a 60%, #6b2f5e 100%)",
    accent: "#ffd27a",
    accentSoft: "rgba(255,210,122,0.55)",
    count: 14,
  }),
  createParticlePreset({
    id: "heart-spiral", motion: "spiral", look: "glass",
    title: "Heart Spiral",
    emoji: ["💗", "💞", "💖", "✨"],
    headline: "Falling for you, round and round",
    subline: "No bottom in sight, and I like it.",
    background: "conic-gradient(from 200deg at 50% 50%, #7b2cbf, #ff4d8d, #ffb703, #7b2cbf)",
    accent: "#fff",
    accentSoft: "rgba(255,255,255,0.4)",
    count: 34,
  }),
  createParticlePreset({
    id: "garden-of-us", motion: "sway", look: "handwritten",
    title: "Garden of Us",
    emoji: ["🌻", "🌷", "🌿", "🌼"],
    headline: "We grew something lovely",
    subline: "Water daily. Love loudly.",
    background: "linear-gradient(180deg, #cdeac0 0%, #95d5b2 55%, #2d6a4f 100%)",
    accent: "#fffbe6",
    accentSoft: "rgba(255,251,230,0.6)",
    count: 20,
  }),
  createParticlePreset({
    id: "warp-speed", motion: "zoom", look: "retro",
    title: "Warp Speed Love",
    emoji: ["⭐", "💖", "✨"],
    headline: "Falling for you at light speed",
    subline: "Engage. Hold on. Enjoy the ride.",
    background: "radial-gradient(circle at center, #1b1464 0%, #0a0a2a 60%, #000 100%)",
    accent: "#00e5ff",
    accentSoft: "rgba(0,229,255,0.4)",
    count: 30,
  }),
  createParticlePreset({
    id: "campfire", motion: "ember", look: "plain",
    title: "Campfire",
    emoji: ["🔥", "✨", "🧡"],
    headline: "Stay a while",
    subline: "Some places feel like home because you're in them.",
    background: "radial-gradient(circle at bottom, #7a1f00 0%, #2b0a00 55%, #0a0200 100%)",
    accent: "#ffb347",
    accentSoft: "rgba(255,179,71,0.5)",
    count: 30,
  }),
  createParticlePreset({
    id: "official-stamp", motion: "burst", look: "stamp",
    title: "Official Stamp",
    emoji: ["✅", "❤️", "✅"],
    headline: "Officially yours",
    subline: "Approved, sealed, and non-refundable.",
    background: "linear-gradient(135deg, #e9d8a6 0%, #c9a66b 100%)",
    accent: "#9b2226",
    accentSoft: "rgba(155,34,38,0.25)",
    count: 12,
  }),
  createParticlePreset({
    id: "polaroid-memory", motion: "twinkle", look: "polaroid",
    title: "Polaroid Memory",
    emoji: ["📸", "✨", "💛"],
    headline: "Remember this day?",
    subline: "I keep it in my pocket for the tough ones.",
    background: "linear-gradient(160deg, #3a2f2f 0%, #6b5b53 60%, #a08c82 100%)",
    accent: "#ffe3b3",
    accentSoft: "rgba(255,227,179,0.4)",
    count: 16,
  }),
  createParticlePreset({
    id: "neon-nights", motion: "rise", look: "neon", beat: true,
    title: "Neon Nights",
    emoji: ["💜", "🩷", "💙"],
    headline: "Out all night with you",
    subline: "The city's loud. I only hear you.",
    background: "linear-gradient(180deg, #0f0c29 0%, #302b63 55%, #24243e 100%)",
    accent: "#ff2e93",
    accentSoft: "rgba(255,46,147,0.5)",
    count: 22,
  }),
  createParticlePreset({
    id: "retro-mixtape", motion: "fall", look: "retro",
    title: "Retro Mixtape",
    emoji: ["📼", "🎵", "💿", "🎶"],
    headline: "Side A: every song is about you",
    subline: "Press play. Stay a while.",
    background: "linear-gradient(135deg, #ff6f91 0%, #ff9671 45%, #ffc75f 100%)",
    accent: "#fff",
    accentSoft: "rgba(255,255,255,0.4)",
    count: 20,
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
  {
    id: "two-screen-heart",
    title: "Two-Screen Heart",
    max_views: 999,
    // §7: a real, working dual-activation surprise — not just a sensory
    // preset. Uses window.DuoSpaceCoupleSync (injected by every surprise's
    // runtime, see lib/surpriseDocument.ts), a generic bridge any future
    // template can call the same way. Starts as a half heart; tapping
    // activates YOUR half locally and tells the host, which persists it
    // and pushes updated state back in — to both devices, independently,
    // once each has fetched the other's row.
    html_content: `
    <div class="scene">
      <div class="glow"></div>
      <div class="heart-wrap">
        <svg id="heart" viewBox="0 0 100 100" class="heart">
          <path id="heartHalfMine" class="half mine" d="M50 88 L50 22 C50 2 20 2 20 26 C20 46 34 58 50 88 Z" />
          <path id="heartHalfPartner" class="half partner" d="M50 88 L50 22 C50 2 80 2 80 26 C80 46 66 58 50 88 Z" />
        </svg>
        <div id="prompt" class="prompt">Tap your half</div>
      </div>
    </div>
  `,
    css_content: `
    :root { --pink: hsl(340, 82%, 66%); --pink-soft: hsl(340, 82%, 88%); }
    html, body { margin:0; height:100%; background:#100810; overflow:hidden; }
    .scene { position:relative; width:100%; height:100%; display:flex; align-items:center; justify-content:center; }
    .glow { position:absolute; inset:0; background:radial-gradient(circle at 50% 55%, var(--pink) 0%, transparent 65%); opacity:.35; }
    .heart-wrap { position:relative; display:flex; flex-direction:column; align-items:center; gap:18px; }
    .heart { width:min(60vw, 260px); height:min(60vw, 260px); touch-action:manipulation; }
    .half { stroke:var(--pink); stroke-width:1.5; transition: fill .35s ease, opacity .35s ease, filter .35s ease; cursor:pointer; }
    .half.mine { fill: rgba(255,255,255,.08); }
    .half.partner { fill: rgba(255,255,255,.08); }
    .half.mine.active { fill: var(--pink); filter: drop-shadow(0 0 14px var(--pink)); }
    .half.partner.active { fill: var(--pink-soft); filter: drop-shadow(0 0 14px var(--pink-soft)); }
    .heart.both-active { animation: pulse 1.1s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
    .prompt { color: rgba(255,255,255,.7); font: 500 14px system-ui, sans-serif; letter-spacing:.02em; transition: opacity .3s ease; }
    @media (prefers-reduced-motion: reduce) { .heart.both-active { animation: none; } .half { transition: none; } }
  `,
    js_content: `
    var mineEl = document.getElementById("heartHalfMine");
    var partnerEl = document.getElementById("heartHalfPartner");
    var heartEl = document.getElementById("heart");
    var promptEl = document.getElementById("prompt");
    var activated = false;

    function render(state) {
      mineEl.classList.toggle("active", !!state.mine);
      partnerEl.classList.toggle("active", !!state.partner);
      heartEl.classList.toggle("both-active", !!state.both);
      if (state.both) promptEl.textContent = "You found each other \\u2764";
      else if (state.mine) promptEl.textContent = "Waiting for your partner...";
      else promptEl.textContent = "Tap your half";
    }

    function activateMine() {
      if (activated) return;
      activated = true;
      // Optimistic local update — the host's own confirmed state arrives
      // right behind this via postMessage and simply confirms it.
      render({ mine: true, partner: partnerEl.classList.contains("active"), both: false });
      window.DuoSpaceCoupleSync.activate();
    }

    mineEl.addEventListener("click", activateMine);
    render(window.DuoSpaceCoupleSync.getState());
    window.DuoSpaceCoupleSync.onChange(render);
  `,
  },
  {
    id: "heartbeat-letter",
    title: "Heartbeat Letter",
    max_views: 999,
    // §8A: hold to reveal, at the pace of a heartbeat. Release before it's
    // fully revealed and it gently eases back down rather than snapping —
    // this is meant to feel patient, not like a progress bar.
    html_content: `
    <div class="stage">
      <div id="heart" class="heart">&#10084;</div>
      <p id="letter" class="letter">Every beat of my heart has your name on it. The longer I hold on, the more I want to tell you &mdash; so hold with me, just a little longer.</p>
      <div id="hint" class="hint">Press and hold</div>
    </div>
  `,
    css_content: `
    html, body { margin:0; height:100%; background:#12060c; overflow:hidden; }
    .stage { position:relative; width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:22px; padding:0 32px; box-sizing:border-box; user-select:none; -webkit-user-select:none; touch-action:manipulation; }
    .heart { font-size:44px; filter: drop-shadow(0 0 0 transparent); transition: filter .2s ease; }
    .heart.beating { animation: beat 0.86s ease-in-out infinite; filter: drop-shadow(0 0 18px hsl(340,82%,60%)); }
    .heart.climax { animation: climax 0.6s ease-out 1; }
    @keyframes beat { 0%,100% { transform: scale(1); } 30% { transform: scale(1.18); } 45% { transform: scale(0.98); } 60% { transform: scale(1.1); } }
    @keyframes climax { 0% { transform: scale(1); } 40% { transform: scale(1.6); } 100% { transform: scale(1.25); } }
    .letter { position:relative; margin:0; max-width:420px; text-align:center; font:400 17px/1.6 Georgia, serif; color: rgba(255,255,255,.92); }
    .letter .mask { background: linear-gradient(90deg, currentColor var(--reveal, 0%), transparent var(--reveal, 0%)); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .hint { color: rgba(255,255,255,.4); font: 500 12px system-ui, sans-serif; letter-spacing:.04em; text-transform:uppercase; transition: opacity .3s ease; }
    @media (prefers-reduced-motion: reduce) { .heart.beating, .heart.climax { animation: none; } }
  `,
    js_content: `
    var heart = document.getElementById("heart");
    var letter = document.getElementById("letter");
    var hint = document.getElementById("hint");
    var fullText = letter.textContent;
    letter.innerHTML = '<span class="mask">' + fullText + '</span>';
    var mask = letter.querySelector(".mask");

    var HOLD_MS = 2600;
    var reveal = 0; // 0..1
    var holding = false;
    var startedAt = 0;
    var raf = null;
    var climaxed = false;
    var lastHapticStep = -1;

    function setReveal(v) {
      reveal = Math.max(0, Math.min(1, v));
      mask.style.setProperty("--reveal", (reveal * 100) + "%");
      var step = Math.floor(reveal * 4); // four subtle pulses on the way up
      if (holding && step > lastHapticStep && step > 0 && step < 4) {
        lastHapticStep = step;
        if (window.DuoSpaceHaptics) window.DuoSpaceHaptics.pulse("soft");
      }
    }

    function tick(now) {
      if (holding) {
        setReveal((now - startedAt) / HOLD_MS);
        if (reveal >= 1 && !climaxed) {
          climaxed = true;
          heart.classList.remove("beating");
          heart.classList.add("climax");
          if (window.DuoSpaceHaptics) window.DuoSpaceHaptics.pulse("rigid");
          if (window.DuoSpaceCoupleSync) window.DuoSpaceCoupleSync.activate();
        }
      } else if (!climaxed && reveal > 0) {
        setReveal(reveal - 0.012); // ease back down when released early
      }
      if (reveal > 0 || holding) raf = requestAnimationFrame(tick);
      else raf = null;
    }

    function start() {
      if (climaxed) return;
      holding = true;
      startedAt = performance.now() - reveal * HOLD_MS;
      lastHapticStep = Math.floor(reveal * 4) - 1;
      heart.classList.add("beating");
      hint.style.opacity = "0";
      if (window.DuoSpaceHaptics) window.DuoSpaceHaptics.pulse("light");
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function stop() {
      holding = false;
      if (!climaxed) { heart.classList.remove("beating"); hint.style.opacity = "1"; }
      if (!raf) raf = requestAnimationFrame(tick);
    }

    document.body.addEventListener("pointerdown", start);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);

    // §8A: "recipient opening can optionally send a subtle heartbeat
    // reaction back" — reusing the SAME activate() call the climax fires;
    // no separate mechanism needed since dual-activation's "mine" IS that
    // signal, and Two-Screen Heart's bridge already delivers it symmetrically.
  `,
  },
  {
    id: "living-photograph",
    title: "Living Photograph",
    max_views: 999,
    // §8C: layered depth + real parallax. Placeholder gradient layers —
    // swap each layer's background (or drop an <img> inside it) for an
    // actual photo; the parallax/touch/ripple wiring works either way.
    html_content: `
    <div class="frame">
      <div id="bg" class="layer bg"></div>
      <div id="subject" class="layer subject"></div>
      <div id="light" class="layer light"></div>
      <div id="fg" class="layer fg"></div>
      <div id="ripple" class="ripple"></div>
    </div>
  `,
    css_content: `
    html, body { margin:0; height:100%; background:#000; overflow:hidden; }
    .frame { position:relative; width:100%; height:100%; overflow:hidden; perspective: 600px; touch-action:none; }
    .layer { position:absolute; inset:-10%; will-change: transform; }
    .bg { background: radial-gradient(circle at 40% 30%, hsl(230,40%,22%), hsl(250,45%,8%) 70%); }
    .subject { background: radial-gradient(circle at 50% 55%, hsl(340,60%,40%), transparent 60%); mix-blend-mode: screen; }
    .light { background: radial-gradient(circle at 65% 25%, rgba(255,255,255,.35), transparent 45%); mix-blend-mode: screen; }
    .fg { background: radial-gradient(circle at 30% 80%, rgba(255,255,255,.12), transparent 35%); }
    .frame.pressed .subject { filter: brightness(1.08); }
    .ripple { position:absolute; left:50%; top:50%; width:12px; height:12px; margin:-6px 0 0 -6px; border-radius:50%; border:2px solid rgba(255,255,255,.55); opacity:0; pointer-events:none; }
    .ripple.active { animation: ripple 1.1s ease-out 1; }
    @keyframes ripple { 0% { opacity:.8; transform: scale(1); } 100% { opacity:0; transform: scale(22); } }
    @media (prefers-reduced-motion: reduce) { .layer { transition: none !important; } .ripple.active { animation: none; opacity: 0; } }
  `,
    js_content: `
    var frame = document.querySelector(".frame");
    var bg = document.getElementById("bg"), subject = document.getElementById("subject");
    var light = document.getElementById("light"), fg = document.getElementById("fg");
    var rippleEl = document.getElementById("ripple");
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Depth planes — same multiplier spirit as the host's own DEPTH_PLANE
    // constants (background moves least, foreground most), applied here to
    // this photograph's own layers rather than the host chrome around it.
    var PLANES = [ [bg, 6], [subject, 14], [light, 20], [fg, 30] ];
    var curX = 0, curY = 0, targetX = 0, targetY = 0;

    function applyTilt(nx, ny) { // nx, ny in [-1, 1]
      targetX = nx; targetY = ny;
    }
    function raf() {
      if (!reduced) {
        curX += (targetX - curX) * 0.12;
        curY += (targetY - curY) * 0.12;
        for (var i = 0; i < PLANES.length; i++) {
          var el = PLANES[i][0], amt = PLANES[i][1];
          el.style.transform = "translate(" + (curX * amt) + "px," + (curY * amt) + "px)";
        }
      }
      requestAnimationFrame(raf);
    }
    raf();

    // Device tilt when available; pointer fallback otherwise (§5).
    var gotOrientation = false;
    window.addEventListener("deviceorientation", function (e) {
      if (e.beta === null || e.gamma === null) return;
      gotOrientation = true;
      applyTilt(Math.max(-1, Math.min(1, e.gamma / 30)), Math.max(-1, Math.min(1, (e.beta - 45) / 30)));
    });
    frame.addEventListener("pointermove", function (e) {
      if (gotOrientation) return;
      var r = frame.getBoundingClientRect();
      applyTilt(((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2);
    });

    // Touch = subtle physical response, not just parallax.
    frame.addEventListener("pointerdown", function () {
      frame.classList.add("pressed");
      if (window.DuoSpaceHaptics) window.DuoSpaceHaptics.pulse("soft");
    });
    window.addEventListener("pointerup", function () { frame.classList.remove("pressed"); });

    // §8C: "partner interaction can send a light ripple through the
    // photograph" — the live, one-shot bridge channel, not sticky state.
    if (window.DuoSpaceCoupleSync) {
      window.DuoSpaceCoupleSync.onRipple(function () {
        rippleEl.classList.remove("active");
        void rippleEl.offsetWidth; // restart the animation
        rippleEl.classList.add("active");
        if (window.DuoSpaceHaptics) window.DuoSpaceHaptics.pulse("light");
      });
    }
  `,
  },
  {
    id: "secret-touch",
    title: "Secret Touch",
    max_views: 999,
    // §8D: the gesture sequence is a plain array right here in the code —
    // "configurable and persisted with the Surprise" means exactly this:
    // it's part of js_content, the same column every other piece of this
    // surprise's behavior already lives in. Edit the array to change it.
    html_content: `
    <div id="pad" class="pad">
      <div id="dots" class="dots"></div>
      <div id="hint" class="hint">tap &middot; tap &middot; hold &middot; swipe up</div>
      <div id="message" class="message">A secret, just for you &mdash; you found it.</div>
    </div>
  `,
    css_content: `
    html, body { margin:0; height:100%; background:#0a0a12; overflow:hidden; }
    .pad { position:relative; width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; touch-action:none; user-select:none; -webkit-user-select:none; }
    .dots { display:flex; gap:10px; }
    .dots span { width:10px; height:10px; border-radius:50%; background: rgba(255,255,255,.18); transition: background .2s ease, transform .2s ease; }
    .dots span.hit { background: hsl(265,70%,65%); transform: scale(1.3); }
    .pad.shake .dots span { animation: shake .35s ease; }
    @keyframes shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
    .hint { color: rgba(255,255,255,.4); font: 500 12px system-ui, sans-serif; letter-spacing:.04em; text-transform:uppercase; }
    .message { opacity:0; transform: translateY(8px); transition: opacity .5s ease, transform .5s ease; color:#fff; font:400 18px/1.5 Georgia, serif; text-align:center; max-width:320px; }
    .pad.unlocked .message { opacity:1; transform: translateY(0); }
    .pad.unlocked .hint, .pad.unlocked .dots { opacity:0; }
    @media (prefers-reduced-motion: reduce) { .pad.shake .dots span { animation: none; } }
  `,
    js_content: `
    // Edit this to change the required gesture — order matters.
    var SECRET_SEQUENCE = ["tap", "tap", "hold", "swipe-up"];

    var pad = document.getElementById("pad");
    var dots = document.getElementById("dots");
    var progress = 0;
    var unlocked = false;

    SECRET_SEQUENCE.forEach(function () { dots.appendChild(document.createElement("span")); });
    var dotEls = dots.querySelectorAll("span");

    function reject() {
      progress = 0;
      dotEls.forEach(function (d) { d.classList.remove("hit"); });
      pad.classList.add("shake");
      setTimeout(function () { pad.classList.remove("shake"); }, 350);
      if (window.DuoSpaceHaptics) window.DuoSpaceHaptics.pulse("soft");
    }

    function submit(gesture) {
      if (unlocked) return;
      if (gesture === SECRET_SEQUENCE[progress]) {
        dotEls[progress].classList.add("hit");
        progress++;
        if (window.DuoSpaceHaptics) window.DuoSpaceHaptics.pulse("selection");
        if (progress === SECRET_SEQUENCE.length) {
          unlocked = true;
          pad.classList.add("unlocked");
          if (window.DuoSpaceHaptics) window.DuoSpaceHaptics.pulse("rigid");
          if (window.DuoSpaceCoupleSync) window.DuoSpaceCoupleSync.activate();
        }
      } else {
        reject();
      }
    }

    var downAt = 0, downX = 0, downY = 0, longPressTimer = null, longPressFired = false;
    var HOLD_MS = 500, SWIPE_PX = 40;

    pad.addEventListener("pointerdown", function (e) {
      downAt = Date.now(); downX = e.clientX; downY = e.clientY; longPressFired = false;
      longPressTimer = setTimeout(function () { longPressFired = true; submit("hold"); }, HOLD_MS);
    });
    pad.addEventListener("pointerup", function (e) {
      clearTimeout(longPressTimer);
      if (longPressFired) return;
      var dx = e.clientX - downX, dy = e.clientY - downY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > SWIPE_PX) {
        var dir = Math.abs(dx) > Math.abs(dy)
          ? (dx > 0 ? "swipe-right" : "swipe-left")
          : (dy > 0 ? "swipe-down" : "swipe-up");
        submit(dir);
      } else {
        submit("tap");
      }
    });
    pad.addEventListener("pointercancel", function () { clearTimeout(longPressTimer); });
  `,
  },
];

export const defaultSurprisePreset = surprisePresets[0];

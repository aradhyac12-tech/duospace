import { useCallback } from "react";
import * as THREE from "three";
import { useAmbientScene, type SceneSetup } from "@/hooks/useAmbientScene";

interface SceneProps {
  seed: number;
  className?: string;
  /** Phase 4 (§11): live tilt input, forwarded to useAmbientScene's
   *  shared camera nudge — see that hook for why this is a getter. */
  getTilt?: () => { x: number; y: number };
}

// Redesign brief §6 — Romantic: soft floating particles, heart-inspired
// geometry where appropriate, slow breathing/pulsing motion, soft light,
// depth, gentle parallax. No cartoonish giant hearts: the heart shape is
// traced in small soft points, not a single solid glyph, and sits behind
// two looser ambient layers so it reads as depth rather than a sticker.
const RomanticScene = ({ seed, className, getTilt }: SceneProps) => {
  const setup: SceneSetup = useCallback(({ scene, random }) => {
    // Parametric heart curve (classic "16sin³t" form), traced as a ring of
    // points rather than a filled solid — keeps it soft/premium instead of
    // a cartoon glyph, per the brief's explicit "no cartoonish giant
    // hearts" note.
    const heartCount = 260;
    const heartPositions = new Float32Array(heartCount * 3);
    for (let i = 0; i < heartCount; i++) {
      const t = (i / heartCount) * Math.PI * 2;
      const hx = 16 * Math.pow(Math.sin(t), 3);
      const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      // Slight per-point jitter so the outline reads as a soft cloud of
      // particles tracing a heart, not a rigid vector line.
      const jitter = () => (random() - 0.5) * 0.35;
      heartPositions[i * 3] = hx * 0.2 + jitter();
      heartPositions[i * 3 + 1] = hy * 0.2 + jitter();
      heartPositions[i * 3 + 2] = (random() - 0.5) * 1.2;
    }
    const heartGeom = new THREE.BufferGeometry();
    heartGeom.setAttribute("position", new THREE.BufferAttribute(heartPositions, 3));
    const heartMat = new THREE.PointsMaterial({
      color: new THREE.Color("hsl(340, 82%, 72%)"),
      size: 0.09,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const heart = new THREE.Points(heartGeom, heartMat);
    scene.add(heart);

    // Loose ambient field behind it for depth/parallax — same idea as the
    // old generic scene, kept modest so the heart stays the focal point.
    const ambientCount = 90;
    const ambientPositions = new Float32Array(ambientCount * 3);
    for (let i = 0; i < ambientCount; i++) {
      ambientPositions[i * 3] = (random() - 0.5) * 16;
      ambientPositions[i * 3 + 1] = (random() - 0.5) * 16;
      ambientPositions[i * 3 + 2] = (random() - 0.5) * 12 - 4;
    }
    const ambientGeom = new THREE.BufferGeometry();
    ambientGeom.setAttribute("position", new THREE.BufferAttribute(ambientPositions, 3));
    const ambientMat = new THREE.PointsMaterial({
      color: new THREE.Color("hsl(350, 90%, 85%)"),
      size: 0.04,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ambient = new THREE.Points(ambientGeom, ambientMat);
    scene.add(ambient);

    const animate = (t: number) => {
      // Slow breathing pulse — a gentle scale oscillation, the "alive"
      // motion the brief asks for instead of static geometry.
      const breathe = 1 + Math.sin(t * 0.6) * 0.045;
      heart.scale.setScalar(breathe);
      heart.rotation.y = Math.sin(t * 0.15) * 0.15; // gentle parallax sway, not a full spin
      heartMat.opacity = 0.75 + Math.sin(t * 0.6) * 0.1;
      ambient.rotation.y = t * 0.02;
      ambient.rotation.x = Math.sin(t * 0.05) * 0.05;
    };

    return { disposables: [heartGeom, heartMat, ambientGeom, ambientMat], animate };
  }, []);

  const mountRef = useAmbientScene(seed, setup, getTilt);
  return <div ref={mountRef} className={className} style={{ width: "100%", height: "100%" }} />;
};

export default RomanticScene;

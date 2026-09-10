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

// Redesign brief §10 — Intense: energy-like particles, stronger motion,
// controlled impact, faster but still polished transitions. "Controlled"
// is doing real work in that sentence — this is the highest-energy of the
// 5 scenes but still bounded/rhythmic, not flashing or chaotic (no strobe-
// like opacity flicker, which would also be an accessibility hazard).
const IntenseScene = ({ seed, className, getTilt }: SceneProps) => {
  const setup: SceneSetup = useCallback(({ scene, random }) => {
    const COUNT = 130;
    const positions = new Float32Array(COUNT * 3);
    const velocities: { r: number; speed: number; angle: number; z: number }[] = [];
    for (let i = 0; i < COUNT; i++) {
      const angle = random() * Math.PI * 2;
      const r = 0.5 + random() * 5;
      positions[i * 3] = Math.cos(angle) * r;
      positions[i * 3 + 1] = Math.sin(angle) * r;
      positions[i * 3 + 2] = (random() - 0.5) * 6;
      velocities.push({ r, speed: 0.5 + random() * 0.9, angle, z: (random() - 0.5) * 0.4 });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: new THREE.Color("hsl(14, 90%, 60%)"),
      size: 0.06,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);

    // A tighter, hotter core layer — gives the field a visual center of
    // gravity instead of reading as uniform noise at speed.
    const coreCount = 26;
    const corePositions = new Float32Array(coreCount * 3);
    for (let i = 0; i < coreCount; i++) {
      corePositions[i * 3] = (random() - 0.5) * 1.2;
      corePositions[i * 3 + 1] = (random() - 0.5) * 1.2;
      corePositions[i * 3 + 2] = (random() - 0.5) * 1.2;
    }
    const coreGeom = new THREE.BufferGeometry();
    coreGeom.setAttribute("position", new THREE.BufferAttribute(corePositions, 3));
    const coreMat = new THREE.PointsMaterial({
      color: new THREE.Color("hsl(45, 95%, 70%)"),
      size: 0.1, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const core = new THREE.Points(coreGeom, coreMat);
    scene.add(core);

    const posAttr = geometry.getAttribute("position") as THREE.BufferAttribute;

    // Controlled impact beat every ~3s: a brief, bounded radius pulse
    // (ease-out, not a snap) rather than a constant explosion — matches
    // the brief's "controlled impact" phrasing exactly.
    const IMPACT_INTERVAL = 3;

    const animate = (t: number) => {
      const impactPhase = (t % IMPACT_INTERVAL) / IMPACT_INTERVAL; // 0-1
      const impactPulse = Math.exp(-impactPhase * 6) * 0.4; // sharp rise, fast decay — no snap
      for (let i = 0; i < COUNT; i++) {
        const v = velocities[i];
        v.angle += 0.008 * v.speed;
        const r = v.r * (1 + impactPulse);
        posAttr.array[i * 3] = Math.cos(v.angle) * r;
        posAttr.array[i * 3 + 1] = Math.sin(v.angle) * r;
      }
      posAttr.needsUpdate = true;
      core.rotation.z = t * 0.6;
      coreMat.opacity = 0.7 + impactPulse; // brightens with the impact beat, capped well under strobe territory
      points.rotation.z = t * 0.03;
    };

    return { disposables: [geometry, material, coreGeom, coreMat], animate };
  }, []);

  const mountRef = useAmbientScene(seed, setup, getTilt);
  return <div ref={mountRef} className={className} style={{ width: "100%", height: "100%" }} />;
};

export default IntenseScene;

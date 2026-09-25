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

// Redesign brief §7 — Celebration: controlled particle bursts, confetti-
// like geometry, spark particles, short impact moments. Explicitly NOT
// constant particle explosions — bursts are timed (every ~4.5s) and each
// one settles before the next, rather than a continuous fountain.
const CelebrationScene = ({ seed, className, getTilt }: SceneProps) => {
  const setup: SceneSetup = useCallback(({ scene, random }) => {
    const CONFETTI_COUNT = 160;
    const BURST_INTERVAL = 4.5; // seconds between bursts
    const BURST_LIFETIME = 2.2; // seconds a burst takes to fall/settle

    // Confetti as small flat planes (not points) so they can tumble and
    // catch light like real paper squares — instanced for one draw call.
    // Per-instance color uses three's built-in InstancedMesh color support
    // (setColorAt + vertexColors:true) rather than a hand-patched shader —
    // same visual result, none of the fragility of hooking onBeforeCompile.
    const geometry = new THREE.PlaneGeometry(0.12, 0.18);
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const confetti = new THREE.InstancedMesh(geometry, material, CONFETTI_COUNT);
    const dummy = new THREE.Object3D();
    const colors = ["hsl(45,95%,60%)", "hsl(340,80%,65%)", "hsl(200,85%,60%)", "hsl(262,83%,66%)", "hsl(280,80%,68%)"]
      .map((c) => new THREE.Color(c));
    // Per-particle seed data: origin offset (so a burst isn't a single
    // point explosion), fall speed, spin speed, and which burst cycle it
    // belongs to (staggered so not all 160 pop at literally the same ms).
    const origins = Array.from({ length: CONFETTI_COUNT }, (_, i) => {
      const color = colors[Math.floor(random() * colors.length)];
      confetti.setColorAt(i, color);
      return {
        x: (random() - 0.5) * 3,
        vx: (random() - 0.5) * 4,
        vy: 3 + random() * 2.5,
        spin: (random() - 0.5) * 6,
        phase: random() * BURST_LIFETIME * 0.3, // stagger within the burst
      };
    });
    if (confetti.instanceColor) confetti.instanceColor.needsUpdate = true;
    scene.add(confetti);

    // Persistent sparkle points — the "still feels alive between bursts"
    // layer, gentle and continuous rather than another burst.
    const sparkCount = 60;
    const sparkPositions = new Float32Array(sparkCount * 3);
    for (let i = 0; i < sparkCount; i++) {
      sparkPositions[i * 3] = (random() - 0.5) * 12;
      sparkPositions[i * 3 + 1] = (random() - 0.5) * 10;
      sparkPositions[i * 3 + 2] = (random() - 0.5) * 8 - 2;
    }
    const sparkGeom = new THREE.BufferGeometry();
    sparkGeom.setAttribute("position", new THREE.BufferAttribute(sparkPositions, 3));
    const sparkMat = new THREE.PointsMaterial({
      color: new THREE.Color("hsl(50, 100%, 80%)"),
      size: 0.035, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const sparks = new THREE.Points(sparkGeom, sparkMat);
    scene.add(sparks);

    const animate = (t: number) => {
      const cycleT = t % BURST_INTERVAL;
      for (let i = 0; i < CONFETTI_COUNT; i++) {
        const o = origins[i];
        const local = cycleT - o.phase;
        if (local < 0 || local > BURST_LIFETIME) {
          // Between this particle's turn — parked off-screen, not disposed
          // (reused every cycle, no per-frame allocation).
          dummy.position.set(0, -20, 0);
        } else {
          const p = local / BURST_LIFETIME; // 0-1 through this particle's fall
          dummy.position.set(o.x + o.vx * p, o.vy * (1 - p * p) - 1, 0); // ease-out rise, gravity fall
          dummy.rotation.set(local * o.spin, local * o.spin * 0.7, 0);
        }
        dummy.updateMatrix();
        confetti.setMatrixAt(i, dummy.matrix);
      }
      confetti.instanceMatrix.needsUpdate = true;
      sparks.rotation.y = t * 0.03;
      sparkMat.opacity = 0.45 + Math.sin(t * 1.5) * 0.15;
    };

    return { disposables: [geometry, material, sparkGeom, sparkMat], animate };
  }, []);

  const mountRef = useAmbientScene(seed, setup, getTilt);
  return <div ref={mountRef} className={className} style={{ width: "100%", height: "100%" }} />;
};

export default CelebrationScene;

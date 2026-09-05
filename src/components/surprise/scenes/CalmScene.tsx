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

// Redesign brief §9 — Calm: slow floating particles, soft depth, low-
// frequency motion, restrained lighting. Deliberately the sparsest and
// slowest of the 5 scenes — restraint IS the visual language here, so this
// one should NOT borrow any of the density/speed from the others.
const CalmScene = ({ seed, className, getTilt }: SceneProps) => {
  const setup: SceneSetup = useCallback(({ scene, random }) => {
    const COUNT = 70; // sparsest of all 5 scenes, on purpose
    const positions = new Float32Array(COUNT * 3);
    const driftSeeds: number[] = [];
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (random() - 0.5) * 14;
      positions[i * 3 + 1] = (random() - 0.5) * 10;
      positions[i * 3 + 2] = (random() - 0.5) * 8 - 2;
      driftSeeds.push(random() * Math.PI * 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: new THREE.Color("hsl(205, 55%, 78%)"),
      size: 0.05,
      transparent: true,
      opacity: 0.55, // restrained — none of the other scenes go this low
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);

    // A second, even fainter layer further back — soft depth without
    // adding motion energy (it drifts at the same low frequency, just
    // offset in phase, rather than being a second distinct effect).
    const farCount = 40;
    const farPositions = new Float32Array(farCount * 3);
    for (let i = 0; i < farCount; i++) {
      farPositions[i * 3] = (random() - 0.5) * 18;
      farPositions[i * 3 + 1] = (random() - 0.5) * 12;
      farPositions[i * 3 + 2] = (random() - 0.5) * 4 - 8;
    }
    const farGeom = new THREE.BufferGeometry();
    farGeom.setAttribute("position", new THREE.BufferAttribute(farPositions, 3));
    const farMat = new THREE.PointsMaterial({
      color: new THREE.Color("hsl(220, 40%, 70%)"),
      size: 0.03, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const far = new THREE.Points(farGeom, farMat);
    scene.add(far);

    const posAttr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const basePositions = positions.slice();

    const animate = (t: number) => {
      // Low-frequency (~0.15Hz) vertical drift per-particle, not a group
      // rotation — reads as "floating", not "spinning".
      for (let i = 0; i < COUNT; i++) {
        posAttr.array[i * 3 + 1] = basePositions[i * 3 + 1] + Math.sin(t * 0.15 + driftSeeds[i]) * 0.4;
      }
      posAttr.needsUpdate = true;
      far.rotation.y = t * 0.008; // barely perceptible — depth cue, not an effect
    };

    return { disposables: [geometry, material, farGeom, farMat], animate };
  }, []);

  const mountRef = useAmbientScene(seed, setup, getTilt);
  return <div ref={mountRef} className={className} style={{ width: "100%", height: "100%" }} />;
};

export default CalmScene;

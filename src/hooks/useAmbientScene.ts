import { useEffect, useRef } from "react";
import * as THREE from "three";

// ─── useAmbientScene ─────────────────────────────────────────────────────
// Surprise 2.0 phase 2 (redesign brief §5, §16): the old SurpriseScene3D
// was one hardcoded particle field reused for every surprise regardless of
// mood. Splitting into 5 distinct scenes (Romantic/Celebration/Playful/
// Calm/Intense) means 5x the WebGL boilerplate — mount, resize, tab-
// visibility pausing, disposal — unless that boilerplate is factored out
// once and shared. This hook IS that shared lifecycle; each scene only
// supplies what makes it visually distinct (geometry, color, motion).
//
// Perf contract (brief §16), enforced here so every scene gets it for
// free: pause the render loop while the tab/app is backgrounded, dispose
// every geometry/material passed back from setup() on unmount, cap
// devicePixelRatio at 2, and do the WebGL context creation & sizing exactly
// once per (mount, seed) pair.

export interface SceneHandles {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Deterministic PRNG seeded from the surprise's own variant seed — same
   *  algorithm the old SurpriseScene3D used, so a given surprise still
   *  renders identically for both partners every time. */
  random: () => number;
}

export type SceneSetup = (handles: SceneHandles) => {
  /** Disposed automatically on unmount/reseed — every scene should return
   *  every geometry/material it creates here so nothing leaks. */
  disposables: (THREE.BufferGeometry | THREE.Material)[];
  /** Called once per frame with elapsed seconds; do all per-frame mutation
   *  (rotation, position, opacity) here rather than in setup(). */
  animate: (elapsedSeconds: number) => void;
};

export const useAmbientScene = (
  seed: number,
  setup: SceneSetup,
  // Phase 4 (§11): tilt input, read fresh every frame — deliberately a
  // getter FUNCTION, not a value prop. rawX/rawY upstream are Framer
  // Motion MotionValues updating continuously off the gyroscope; if the
  // current x/y were passed in as plain numbers they'd need to be a
  // dependency of the mount effect below, which would tear down and
  // rebuild the whole WebGL context on every tilt update — i.e. dozens of
  // times a second. A getter lets the render loop pull the latest value
  // each frame via .get() without ever being a dependency of anything.
  getTilt?: () => { x: number; y: number }
) => {
  const mountRef = useRef<HTMLDivElement>(null);
  // Stored in a ref and refreshed via a plain (no-dep-array) effect: this
  // runs on every render, which is cheap (just a ref write) and does NOT
  // touch the WebGL mount effect below, unlike putting getTilt itself in
  // that effect's dependency array would.
  const getTiltRef = useRef(getTilt);
  useEffect(() => {
    getTiltRef.current = getTilt;
  });

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth;
    const height = mount.clientHeight;
    if (width === 0 || height === 0) return; // not laid out yet — nothing to do

    let rng = seed || 1;
    const random = () => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
    camera.position.z = 8;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const { disposables, animate } = setup({ scene, camera, random });

    let frameId: number;
    let running = true;
    const clock = new THREE.Clock();

    // Phase 4 (§11): a single shared tilt→camera nudge applied AFTER each
    // scene's own animate() runs, so none of the 5 scene files need to
    // know about tilt individually — none of them move the camera
    // themselves (verified: camera.position is only ever touched here),
    // so this can't fight with anything a scene does on its own. Lerped
    // toward the target each frame rather than snapping, for the same
    // "held object" feel the card's own tilt spring already has. This is
    // also what produces "particle depth"/parallax per the brief — moving
    // the camera relative to fixed depth-layered geometry IS parallax; the
    // particles themselves don't need to move for that effect to read.
    const cameraHome = camera.position.clone();
    const CAMERA_TILT_RANGE = 1.4; // world units of camera travel at max tilt
    const loop = () => {
      if (!running) return;
      animate(clock.getElapsedTime());
      const tilt = getTiltRef.current?.();
      if (tilt) {
        const targetX = cameraHome.x + tilt.x * CAMERA_TILT_RANGE * 2;
        // Inverted: tilting the phone/pointer "down" (positive y) should
        // feel like looking further INTO the scene from above, matching
        // the card's own rotateX sign convention above.
        const targetY = cameraHome.y - tilt.y * CAMERA_TILT_RANGE * 2;
        camera.position.x += (targetX - camera.position.x) * 0.06;
        camera.position.y += (targetY - camera.position.y) * 0.06;
        camera.lookAt(0, 0, 0);
      }
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(loop);
    };
    loop();

    // Pause the render loop (and stop the clock from accruing) while the
    // tab/app isn't visible — an ambient background scene shouldn't burn
    // cycles the person can't even see.
    const handleVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frameId);
        clock.stop();
      } else if (!running) {
        running = true;
        clock.start();
        loop();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    const handleResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      running = false;
      cancelAnimationFrame(frameId);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("resize", handleResize);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [seed, setup]);

  return mountRef;
};

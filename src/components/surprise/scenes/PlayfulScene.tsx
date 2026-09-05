import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import { useAmbientScene, type SceneSetup } from "@/hooks/useAmbientScene";

interface SceneProps {
  seed: number;
  className?: string;
  /** Phase 4 (§11): live tilt input, forwarded to useAmbientScene's
   *  shared camera nudge — see that hook for why this is a getter. */
  getTilt?: () => { x: number; y: number };
}

// Redesign brief §8 — Playful: springy objects, elastic motion, subtle
// bounce, interactive response to touch — "interaction should feel
// physical". The other 4 scenes are purely ambient/ornamental; this is the
// one where the brief explicitly asks for touch response, so it's the one
// scene that reads pointer/touch position on its own mount element and
// nudges a target the blobs spring toward.
const PlayfulScene = ({ seed, className, getTilt }: SceneProps) => {
  // Plain refs, not React state — this needs to be readable from inside
  // the animate() closure every frame without triggering re-renders (which
  // would tear down/rebuild the whole WebGL scene on every pointer move).
  const pointerTarget = useRef({ x: 0, y: 0 });

  const setup: SceneSetup = useCallback(({ scene, random }) => {
    const BLOB_COUNT = 9;
    const geometry = new THREE.SphereGeometry(0.4, 20, 20);
    const colors = ["hsl(45,90%,60%)", "hsl(340,75%,68%)", "hsl(160,70%,55%)", "hsl(210,85%,62%)"];
    const blobs = Array.from({ length: BLOB_COUNT }, (_, i) => {
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(colors[i % colors.length]),
        roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.9,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set((random() - 0.5) * 8, (random() - 0.5) * 5, (random() - 0.5) * 4 - 1);
      mesh.scale.setScalar(0.5 + random() * 0.6);
      scene.add(mesh);
      return {
        mesh, material,
        basePos: mesh.position.clone(),
        bouncePhase: random() * Math.PI * 2,
        bounceSpeed: 1.6 + random() * 0.8,
        pointerPull: 0.15 + random() * 0.25, // how strongly this blob reaches toward the pointer
      };
    });

    const light = new THREE.PointLight(new THREE.Color("hsl(45, 90%, 85%)"), 40, 20);
    const lightHome = new THREE.Vector3(2, 3, 5);
    light.position.copy(lightHome);
    scene.add(light);
    const ambient = new THREE.AmbientLight(new THREE.Color("hsl(220, 40%, 60%)"), 0.5);
    scene.add(ambient);

    const animate = (t: number) => {
      // Phase 4 (§11) "light position": the only scene with an actual
      // THREE.Light, so it's the only one that needs its own tilt nudge —
      // the shared camera nudge in useAmbientScene covers every scene's
      // "camera position"/parallax already. Captured from the component's
      // getTilt prop directly (setup() is a stable useCallback, but that's
      // fine here: getTilt always resolves through to the same underlying
      // Framer Motion MotionValues via .get(), so even a closure from the
      // first render stays live — nothing about it goes stale).
      const tilt = getTilt?.();
      if (tilt) {
        light.position.x = lightHome.x + tilt.x * 3;
        light.position.y = lightHome.y - tilt.y * 3;
      }
      for (const b of blobs) {
        // Elastic bounce: an overshoot-and-settle curve (sin driven, not
        // linear) so it reads as springy rather than a metronome.
        const bounce = Math.abs(Math.sin(t * b.bounceSpeed + b.bouncePhase)) ** 0.5;
        b.mesh.position.y = b.basePos.y + bounce * 0.6 - 0.3;
        b.mesh.scale.y = 1 - bounce * 0.15; // squash on the way down, stretch on the way up
        b.mesh.scale.x = 1 + bounce * 0.08;
        b.mesh.scale.z = 1 + bounce * 0.08;
        // Gentle physical reach toward wherever the pointer last was —
        // this IS the "interactive response to touch" requirement. Capped
        // pull distance so blobs don't fly off-frame chasing a fast swipe.
        b.mesh.position.x = THREE.MathUtils.lerp(
          b.mesh.position.x, b.basePos.x + pointerTarget.current.x * b.pointerPull, 0.04
        );
        b.mesh.position.z = THREE.MathUtils.lerp(
          b.mesh.position.z, b.basePos.z, 0.04
        ) + Math.sin(t * 0.5 + b.bouncePhase) * 0.1;
      }
    };

    return {
      disposables: [geometry, ...blobs.map((b) => b.material)],
      animate,
    };
    // Intentionally empty — see the animate() comment above on why
    // closing over getTilt from mount stays live without needing to be a
    // dependency (and adding it here would tear down/rebuild the WebGL
    // context on every tilt update instead of just reading it each frame).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mountRef = useAmbientScene(seed, setup, getTilt);

  // Pointer/touch tracking, scoped to this scene's own mount element —
  // normalized to roughly -3..3 so it maps to a sensible in-scene reach
  // distance regardless of the element's actual pixel size.
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const updateFromClient = (clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      pointerTarget.current = {
        x: ((clientX - rect.left) / rect.width - 0.5) * 6,
        y: -((clientY - rect.top) / rect.height - 0.5) * 4,
      };
    };
    const onPointerMove = (e: PointerEvent) => updateFromClient(e.clientX, e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) updateFromClient(e.touches[0].clientX, e.touches[0].clientY);
    };
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, [mountRef]);

  return <div ref={mountRef} className={className} style={{ width: "100%", height: "100%" }} />;
};

export default PlayfulScene;

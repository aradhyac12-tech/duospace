import { useEffect, useRef } from "react";
import * as THREE from "three";

interface SurpriseScene3DProps {
  seed: number;
  className?: string;
}

/**
 * Purely ambient — a soft field of depth-sorted particles drifting behind
 * the surprise content. Content-agnostic on purpose so it can sit behind
 * ANY preset or custom-code surprise without knowing what's in it.
 *
 * Never mounted when the person prefers reduced motion or skipped the intro
 * (see SurpriseReveal) — this component itself additionally keeps the
 * particle count modest and pauses its render loop when the tab isn't
 * visible, so it stays "ambient" rather than a battery/CPU cost center.
 */
const SurpriseScene3D = ({ seed, className }: SurpriseScene3DProps) => {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let rng = seed || 1;
    const random = () => {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      return rng / 0x7fffffff;
    };

    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
    camera.position.z = 8;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    // Kept modest on purpose — this is ambient depth, not a hero visual.
    const count = 140;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (random() - 0.5) * 14;
      positions[i * 3 + 1] = (random() - 0.5) * 14;
      positions[i * 3 + 2] = (random() - 0.5) * 10;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: new THREE.Color("hsl(280, 90%, 75%)"),
      size: 0.045,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);

    let frameId: number;
    let running = true;
    const clock = new THREE.Clock();
    const animate = () => {
      if (!running) return;
      const t = clock.getElapsedTime();
      points.rotation.y = t * 0.04;
      points.rotation.x = Math.sin(t * 0.08) * 0.08;
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(animate);
    };
    animate();

    // Pause the render loop (and stop the clock from accruing) while the
    // tab/app isn't visible — a background surprise shouldn't burn cycles.
    const handleVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frameId);
        clock.stop();
      } else if (!running) {
        running = true;
        clock.start();
        animate();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    const handleResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
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
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [seed]);

  return <div ref={mountRef} className={className} style={{ width: "100%", height: "100%" }} />;
};

export default SurpriseScene3D;

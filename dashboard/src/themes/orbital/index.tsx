// Thème « Orbital » — outils (tools.md) : React Three Fiber (champ d'étoiles 3D) ; effets « border beam »
// et « meteors » inspirés de Magic UI / Aceternity UI, réécrits en CSS (pas de Tailwind dans le projet).
// Dossier autonome : le supprimer retire le thème (cf. ../registry.ts).
import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { ThemeModule } from "../registry";
import "./theme.css";

const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Disque lumineux (dégradé radial) : les points Three.js sont carrés par défaut. */
function useStarSprite() {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.85)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }, []);
}

/** Une couche d'étoiles sur une coquille sphérique, qui tourne lentement. */
function StarLayer({ count, radius, size, speed, color }: { count: number; radius: number; size: number; speed: number; color: string }) {
  const ref = useRef<THREE.Points>(null);
  const sprite = useStarSprite();
  const positions = useMemo(() => {
    const p = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = radius * (0.6 + Math.random() * 0.4);
      const s = Math.sqrt(1 - u * u);
      p.set([r * s * Math.cos(a), r * u, r * s * Math.sin(a)], i * 3);
    }
    return p;
  }, [count, radius]);
  useFrame((state, dt) => {
    if (!ref.current || REDUCED) return;
    ref.current.rotation.y += dt * speed;
    // légère parallaxe suivant la souris
    ref.current.rotation.x = THREE.MathUtils.lerp(ref.current.rotation.x, state.pointer.y * 0.05, 0.02);
  });
  return (
    <points ref={ref}>
      <bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]} /></bufferGeometry>
      <pointsMaterial size={size} color={color} map={sprite} alphaTest={0.01} transparent opacity={0.9} sizeAttenuation depthWrite={false}
                      blending={THREE.AdditiveBlending} />
    </points>
  );
}

function Background() {
  const meteors = useMemo(() => Array.from({ length: 6 }, (_, i) => ({
    left: `${10 + Math.random() * 85}%`, top: `${Math.random() * 40}%`, delay: `${i * 2.7 + Math.random() * 2}s`, duration: `${3 + Math.random() * 3}s`,
  })), []);
  return (
    <>
      <Canvas camera={{ position: [0, 0, 1], fov: 75 }} dpr={[1, 1.5]} gl={{ antialias: false, alpha: true, powerPreference: "low-power" }}
              style={{ position: "absolute", inset: 0 }}>
        <StarLayer count={1800} radius={60} size={0.12} speed={0.004} color="#9fb8ff" />
        <StarLayer count={700} radius={40} size={0.18} speed={0.008} color="#ffffff" />
        <StarLayer count={160} radius={25} size={0.32} speed={0.014} color="#7df9ff" />
      </Canvas>
      {!REDUCED && <div className="orbital-meteors">{meteors.map((m, i) => <span key={i} style={{ left: m.left, top: m.top, animationDelay: m.delay, animationDuration: m.duration }} />)}</div>}
    </>
  );
}

const theme: ThemeModule = { Background };
export default theme;

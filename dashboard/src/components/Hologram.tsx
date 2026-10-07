// Wall-E en 3D (React Three Fiber + Three.js), en couleurs réelles, piloté par l'état du module SENTINEL-X.
// Le robot tourne sur son socle ; l'état se lit sur l'anneau du socle et un léger reflet dans les yeux (noirs) :
//   nominal  : vert, regard qui balaie lentement
//   warning  : ambre, tête qui scrute vite (présence détectée)
//   critical : rouge, tête agitée
//   offline  : bleu acier, tête baissée, yeux éteints
// Sur un thème clair (<html data-holo="light">), l'anneau est dessiné en mélange normal (pas de lumière additive).
// Modèle : public/models/wall-e.glb (généré par scripts/convert-model.mjs) avec les nœuds body / neck > head, eyes.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type HoloMode = "nominal" | "warning" | "critical" | "offline";

const COLORS: Record<HoloMode, string> = {
  nominal: "#35f08a",
  warning: "#ffb000",
  critical: "#ff3b3b",
  offline: "#7091bb",
};
const COLORS_LIGHT: Record<HoloMode, string> = {
  nominal: "#139a4c",
  warning: "#d98200",
  critical: "#e0242b",
  offline: "#5e7393",
};
const palette = (light: boolean) => (light ? COLORS_LIGHT : COLORS);

/** Suit l'attribut data-holo posé par le thème actif. */
function useLightSurface(): boolean {
  const read = () => document.documentElement.dataset.holo === "light";
  const [light, setLight] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setLight(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-holo"] });
    return () => obs.disconnect();
  }, []);
  return light;
}

/** Bascule le mode de mélange des matériaux (additif sur fond sombre, normal sur fond clair). */
function useBlending(mats: THREE.Material[], light: boolean) {
  useEffect(() => {
    for (const m of mats) { m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; m.needsUpdate = true; }
  }, [mats, light]);
}

const MODEL_URL = `${import.meta.env.BASE_URL}models/wall-e.glb`;
const REDUCED_MOTION = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// --- Wall-E -------------------------------------------------------------------------------
function WallE({ model, mode, presence, light }: { model: THREE.Group; mode: HoloMode; presence: boolean; light: boolean }) {
  const { scene, neck, eyes, eyeScaleY, eyeMats } = useMemo(() => {
    const scene = model.clone(true);
    const eyeMats: THREE.MeshStandardMaterial[] = [];
    const eyes = scene.getObjectByName("eyes");
    // Verres (noirs) : matières propres (clonées) pour un léger reflet de la couleur d'état.
    eyes?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((mat) => {
        if (!mat.name.startsWith("wall_e1")) return mat;
        const c = (mat as THREE.MeshStandardMaterial).clone();
        eyeMats.push(c);
        return c;
      });
      m.material = Array.isArray(m.material) ? mats : mats[0];
    });
    // Le modèle est quantifié : ses nœuds portent une échelle propre (ex. 7,7), que le clignement doit multiplier.
    return { scene, neck: scene.getObjectByName("neck"), eyes, eyeScaleY: eyes?.scale.y ?? 1, eyeMats };
  }, [model]);

  useEffect(() => () => eyeMats.forEach((m) => m.dispose()), [eyeMats]);

  const target = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    target.set(palette(light)[mode]);
    for (const m of eyeMats) {
      m.emissive.lerp(target, Math.min(1, dt * 3));
      const pulse = mode === "critical" && !REDUCED_MOTION ? 0.55 + 0.45 * Math.sin(t * 8) : 1;
      m.emissiveIntensity = THREE.MathUtils.lerp(m.emissiveIntensity, mode === "offline" ? 0 : 0.3 * pulse, Math.min(1, dt * 4));
    }
    if (REDUCED_MOTION) return;
    if (neck) {
      const yaw = mode === "offline" ? 0 : mode === "critical" ? Math.sin(t * 9) * 0.25
        : presence || mode === "warning" ? Math.sin(t * 1.8) * 0.75 : Math.sin(t * 0.45) * 0.35;
      neck.rotation.y = THREE.MathUtils.lerp(neck.rotation.y, yaw, Math.min(1, dt * 4));
      neck.rotation.x = THREE.MathUtils.lerp(neck.rotation.x, mode === "offline" ? 0.38 : 0, Math.min(1, dt * 2));
    }
    if (eyes) {                                                                  // clignement toutes les ~4 s
      const blink = mode !== "offline" && t % 4.2 < 0.12;
      eyes.scale.y = THREE.MathUtils.lerp(eyes.scale.y, eyeScaleY * (blink ? 0.1 : 1), Math.min(1, dt * 30));
    }
  });

  return <primitive object={scene} />;
}

/** Éclairage « studio » : reflets doux de l'environnement + une lumière principale et un contre-jour. */
function Studio() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    return () => { scene.environment = null; env.dispose(); pmrem.dispose(); };
  }, [gl, scene]);
  return (
    <>
      <hemisphereLight args={["#ffffff", "#3a3a3a", 0.6]} />
      <directionalLight position={[60, 90, 50]} intensity={1.6} />
      <directionalLight position={[-60, 40, -50]} intensity={0.6} />
    </>
  );
}

// --- Socle : anneaux à la couleur de l'état -------------------------------------------------
function Projector({ mode, light }: { mode: HoloMode; light: boolean }) {
  const color = useMemo(() => new THREE.Color(), []);
  const rings = useRef<THREE.Group>(null);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide }), []);
  const discMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }), []);
  useBlending(useMemo(() => [ringMat], [ringMat]), light);
  useEffect(() => () => { ringMat.dispose(); discMat.dispose(); }, [ringMat, discMat]);

  useFrame(({ clock }, dt) => {
    color.set(palette(light)[mode]);
    ringMat.color.lerp(color, Math.min(1, dt * 3));
    discMat.color.set(light ? "#000000" : "#ffffff");
    discMat.opacity = light ? 0.06 : 0.05;
    ringMat.opacity = mode === "critical" && !REDUCED_MOTION ? 0.45 + 0.4 * Math.abs(Math.sin(clock.elapsedTime * 4)) : mode === "offline" ? 0.35 : 0.6;
    if (!REDUCED_MOTION && rings.current) rings.current.rotation.z = clock.elapsedTime * 0.3;
  });

  return (
    <group rotation-x={-Math.PI / 2} position-y={-0.2}>
      <mesh material={discMat}><circleGeometry args={[16.5, 96]} /></mesh>
      <group ref={rings}>
        {[[17, 17.4], [20, 20.25], [23.5, 23.6]].map(([a, b]) => (
          <mesh key={a} material={ringMat}><ringGeometry args={[a, b, 96]} /></mesh>
        ))}
        {Array.from({ length: 12 }, (_, i) => (
          <mesh key={i} material={ringMat} rotation-z={(i / 12) * Math.PI * 2}>
            <ringGeometry args={[21, 23, 1, 1, 0, 0.12]} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** Décale le cadrage (et recule légèrement) sans redimensionner le canvas : Wall-E glisse en continu
 *  vers le quart gauche quand la caméra IA est agrandie, puis revient au centre. */
function FramingShift({ shifted }: { shifted: boolean }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  useFrame((_, dt) => {
    const targetOffset = shifted ? camera.getFilmWidth() * 0.25 : 0;   // décalage de 25 % de la largeur
    const targetZoom = shifted ? 0.72 : 1;                                // recul : marge avec la vidéo, même en rotation
    const k = REDUCED_MOTION ? 1 : 1 - Math.exp(-dt * 7);                  // lissage exponentiel (~0,4 s)
    const offset = THREE.MathUtils.lerp(camera.filmOffset, targetOffset, k);
    const zoom = THREE.MathUtils.lerp(camera.zoom, targetZoom, k);
    if (Math.abs(offset - camera.filmOffset) > 1e-4 || Math.abs(zoom - camera.zoom) > 1e-4) {
      camera.filmOffset = offset;
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
    }
  });
  return null;
}

function Controls() {
  const { camera, gl } = useThree();
  const controls = useMemo(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.target.set(0, 21, 0);
    c.enablePan = false;
    c.enableDamping = true;
    c.minDistance = 55;
    c.maxDistance = 160;
    c.minPolarAngle = 0.35;
    c.maxPolarAngle = 1.75;
    c.autoRotate = !REDUCED_MOTION;
    c.autoRotateSpeed = 0.9;
    return c;
  }, [camera, gl]);
  useEffect(() => () => controls.dispose(), [controls]);
  useFrame(() => controls.update());
  return null;
}

class WebGLBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export default function Hologram({ mode, presence, shifted = false }: { mode: HoloMode; presence: boolean; shifted?: boolean }) {
  const [model, setModel] = useState<THREE.Group | null>(null);
  const [error, setError] = useState<string | null>(null);
  const light = useLightSurface();
  useEffect(() => {
    let alive = true;
    new GLTFLoader().loadAsync(MODEL_URL)
      .then((gltf) => { if (alive) setModel(gltf.scene); })
      .catch(() => { if (alive) setError("Modèle 3D absent\nGénérer avec « npm run model » (dossier dashboard), puis reconstruire l'image"); });
    return () => { alive = false; };
  }, []);

  const fallback = <div className="holo-fallback">Affichage 3D indisponible{"\n"}WebGL n'est pas pris en charge par ce navigateur</div>;
  if (error) return <div className="holo-fallback">{error}</div>;
  return (
    <WebGLBoundary fallback={fallback}>
      <Canvas camera={{ position: [62, 38, 70], fov: 38, near: 1, far: 600 }} dpr={[1, 1.75]}
              gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
              aria-label={`Wall-E en 3D, état ${mode}`}>
        <Studio />
        <Projector mode={mode} light={light} />
        {model && <WallE model={model} mode={mode} presence={presence} light={light} />}
        <FramingShift shifted={shifted} />
        <Controls />
      </Canvas>
      {!model && <div className="holo-fallback">Chargement de Wall-E…</div>}
    </WebGLBoundary>
  );
}

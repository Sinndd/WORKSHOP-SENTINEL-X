// Hologramme 3D de Wall-E (React Three Fiber + Three.js), piloté par l'état du module SENTINEL-X.
//   nominal  : vert, regard qui balaie lentement
//   warning  : ambre, tête qui scrute vite (présence détectée)
//   critical : rouge, tête agitée, projection instable
//   offline  : bleu acier clair, tête baissée, projection légèrement instable
// Sur un thème clair (<html data-holo="light">), mélange normal et teintes plus soutenues : la lumière additive
// disparaîtrait sur fond blanc.
// Modèle : public/models/wall-e.glb (généré par scripts/convert-model.mjs) avec les nœuds body / neck > head, eyes.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
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

// --- Shader hologramme ----------------------------------------------------------------
const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uGlitch;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // Décrochage horizontal de quelques bandes (instabilité de la projection)
    float band = step(0.975, fract(sin(floor(wp.y * 0.5) * 91.3 + floor(uTime * 9.0) * 17.1) * 437.5));
    wp.x += band * uGlitch * 2.2 * sin(uTime * 37.0);
    vY = wp.y;
    vec4 mv = viewMatrix * wp;
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uFlicker;
  uniform float uMotion;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  void main() {
    float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.2);
    float scan = 0.6 + 0.4 * step(0.45, fract(vY * 1.1 - uTime * 1.6 * uMotion));
    float sweepY = mod(uTime * 14.0 * uMotion, 70.0) - 10.0;
    float sweep = (1.0 - smoothstep(0.0, 2.2, abs(vY - sweepY))) * uMotion;
    float flick = 1.0 - uFlicker * step(0.93, fract(sin(floor(uTime * 24.0) * 12.9898) * 43758.5453)) * 0.7;
    float alpha = (0.07 + fresnel * 0.85 + sweep * 0.45) * scan * flick * uOpacity;
    gl_FragColor = vec4(uColor * (0.55 + fresnel * 1.2 + sweep), alpha);
  }
`;

function holoMaterial(color: string, opacity: number) {
  return new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uOpacity: { value: opacity },
      uFlicker: { value: 0 },
      uGlitch: { value: 0 },
      uMotion: { value: REDUCED_MOTION ? 0 : 1 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

// --- Wall-E -------------------------------------------------------------------------------
function WallE({ model, mode, presence, light }: { model: THREE.Group; mode: HoloMode; presence: boolean; light: boolean }) {
  const group = useRef<THREE.Group>(null);
  const { scene, mats, lines, neck, eyes } = useMemo(() => {
    const scene = model.clone(true);
    const body = holoMaterial(COLORS.nominal, 1);
    const eye = holoMaterial(COLORS.nominal, 2.2);
    const lineMat = new THREE.LineBasicMaterial({ color: COLORS.nominal, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false });
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    for (const m of meshes) {
      const isEye = m.name.startsWith("eyes");
      m.material = isEye ? eye : body;
      m.renderOrder = isEye ? 2 : 1;
      // Arêtes vives en filaire : renforce l'effet hologramme sans coût par image.
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 35), lineMat);
      edges.renderOrder = 0;
      m.add(edges);
    }
    return { scene, mats: [body, eye], lines: lineMat, neck: scene.getObjectByName("neck"),
             eyes: scene.getObjectByName("eyes") };
  }, [model]);

  useEffect(() => () => { mats.forEach((m) => m.dispose()); lines.dispose(); }, [mats, lines]);
  const allMats = useMemo(() => [...mats, lines], [mats, lines]);
  useBlending(allMats, light);

  // Couleur cible lissée pour des transitions d'état douces
  const target = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    target.set(palette(light)[mode]);
    const boost = light ? 1.5 : 1;
    for (const m of mats) {
      m.uniforms.uTime.value = t;
      (m.uniforms.uColor.value as THREE.Color).lerp(target, Math.min(1, dt * 3));
      m.uniforms.uFlicker.value = REDUCED_MOTION ? 0 : mode === "offline" ? 0.45 : mode === "critical" ? 0.8 : 0.25;
      m.uniforms.uGlitch.value = REDUCED_MOTION ? 0 : mode === "critical" ? 1 : mode === "offline" ? 0.25 : 0.08;
      // Hors ligne : projection un peu plus transparente (veille), sans disparaître.
      m.uniforms.uOpacity.value = THREE.MathUtils.lerp(m.uniforms.uOpacity.value, (m === mats[1] ? 2.2 : 1) * boost * (mode === "offline" ? 0.8 : 1), Math.min(1, dt * 3));
    }
    lines.color.lerp(target, Math.min(1, dt * 3));
    lines.opacity = (mode === "offline" ? 0.18 : 0.22) * (light ? 2.2 : 1);
    if (REDUCED_MOTION) return;
    if (group.current) group.current.position.y = Math.sin(t * 1.2) * 0.5;      // flottement
    if (neck) {
      const yaw = mode === "offline" ? 0 : mode === "critical" ? Math.sin(t * 9) * 0.25
        : presence || mode === "warning" ? Math.sin(t * 1.8) * 0.75 : Math.sin(t * 0.45) * 0.35;
      neck.rotation.y = THREE.MathUtils.lerp(neck.rotation.y, yaw, Math.min(1, dt * 4));
      neck.rotation.x = THREE.MathUtils.lerp(neck.rotation.x, mode === "offline" ? 0.38 : 0, Math.min(1, dt * 2));
    }
    if (eyes) {                                                                  // clignement toutes les ~4 s
      const blink = mode !== "offline" && t % 4.2 < 0.12;
      eyes.scale.y = THREE.MathUtils.lerp(eyes.scale.y, blink ? 0.1 : 1, Math.min(1, dt * 30));
    }
  });

  return <group ref={group}><primitive object={scene} /></group>;
}

// --- Socle projecteur : anneaux, cône de lumière, particules -------------------------------
function Projector({ mode, light }: { mode: HoloMode; light: boolean }) {
  const color = useMemo(() => new THREE.Color(), []);
  const rings = useRef<THREE.Group>(null);
  const cone = useRef<THREE.Mesh>(null);
  const points = useRef<THREE.Points>(null);
  const COUNT = 220;
  const { positions, speeds } = useMemo(() => {
    const positions = new Float32Array(COUNT * 3), speeds = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const r = Math.sqrt(Math.random()) * 19, a = Math.random() * Math.PI * 2;
      positions.set([Math.cos(a) * r, Math.random() * 50, Math.sin(a) * r], i * 3);
      speeds[i] = 2 + Math.random() * 6;
    }
    return { positions, speeds };
  }, []);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide }), []);
  const coneMat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() } },
    vertexShader: "varying float vH; void main(){ vH = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "uniform vec3 uColor; varying float vH; void main(){ gl_FragColor = vec4(uColor, 0.10 * (1.0 - vH)); }",
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }), []);
  const pointMat = useMemo(() => new THREE.PointsMaterial({ size: 0.35, transparent: true, opacity: 0.7,
    blending: THREE.AdditiveBlending, depthWrite: false }), []);

  useBlending(useMemo(() => [ringMat, coneMat, pointMat], [ringMat, coneMat, pointMat]), light);

  useFrame(({ clock }, dt) => {
    color.set(palette(light)[mode]);
    ringMat.color.lerp(color, Math.min(1, dt * 3));
    (coneMat.uniforms.uColor.value as THREE.Color).lerp(color, Math.min(1, dt * 3));
    pointMat.color.lerp(color, Math.min(1, dt * 3));
    pointMat.opacity = mode === "offline" ? 0.35 : 0.7;
    if (REDUCED_MOTION) return;
    if (rings.current) rings.current.rotation.z = clock.elapsedTime * 0.3;
    const attr = points.current?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (attr && mode !== "offline") {
      for (let i = 0; i < COUNT; i++) {
        let y = attr.getY(i) + speeds[i] * dt;
        if (y > 50) y = 0;
        attr.setY(i, y);
      }
      attr.needsUpdate = true;
    }
  });

  return (
    <group>
      <group ref={rings} rotation-x={-Math.PI / 2} position-y={-1.5}>
        {[[17, 17.4], [20, 20.25], [23.5, 23.6]].map(([a, b]) => (
          <mesh key={a} material={ringMat}><ringGeometry args={[a, b, 96]} /></mesh>
        ))}
        {Array.from({ length: 12 }, (_, i) => (
          <mesh key={i} material={ringMat} rotation-z={(i / 12) * Math.PI * 2} position={[0, 0, 0]}>
            <ringGeometry args={[21, 23, 1, 1, 0, 0.12]} />
          </mesh>
        ))}
      </group>
      <mesh ref={cone} material={coneMat} position-y={24}>
        <cylinderGeometry args={[24, 17, 52, 64, 1, true]} />
      </mesh>
      <points ref={points} material={pointMat}>
        <bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]} /></bufferGeometry>
      </points>
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

  const fallback = <div className="holo-fallback">Hologramme indisponible{"\n"}WebGL n'est pas pris en charge par ce navigateur</div>;
  if (error) return <div className="holo-fallback">{error}</div>;
  return (
    <WebGLBoundary fallback={fallback}>
      <Canvas camera={{ position: [62, 38, 70], fov: 38, near: 1, far: 600 }} dpr={[1, 1.75]}
              gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
              aria-label={`Hologramme de Wall-E, état ${mode}`}>
        <Projector mode={mode} light={light} />
        {model && <WallE model={model} mode={mode} presence={presence} light={light} />}
        <FramingShift shifted={shifted} />
        <Controls />
      </Canvas>
      {!model && <div className="holo-fallback">Initialisation de l'hologramme…</div>}
    </WebGLBoundary>
  );
}

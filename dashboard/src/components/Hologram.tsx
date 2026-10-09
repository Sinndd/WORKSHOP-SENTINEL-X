// Wall-E en 3D (React Three Fiber + Three.js), en couleurs réelles, piloté par l'état du module SENTINEL-X.
// Le robot tourne sur son socle, sa tête suit le curseur, ses bras bougent (coucou au clic) et la trappe du dos
// s'ouvre avec le sas (ou au clic, pour l'affichage). L'état se lit sur l'anneau du socle (yeux rouges en alerte) :
//   nominal  : vert, regard qui balaie lentement
//   warning  : ambre, tête qui scrute vite (présence détectée)
//   critical : rouge, tête agitée
//   offline  : bleu acier, tête baissée, yeux éteints
// Sur un thème clair (<html data-holo="light">), l'anneau est dessiné en mélange normal (pas de lumière additive).
// Modèle : public/models/wall-e.glb (généré par scripts/convert-model.mjs) avec les nœuds body / neck > head, eyes.
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Icon } from "./ui";

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

// --- Pointeur ------------------------------------------------------------------------------
/** Position du curseur sur toute la page, en coordonnées normalisées du canvas (-1..1 au bord, au-delà hors canvas),
 *  et instant du dernier mouvement : Wall-E suit le curseur tant qu'il bouge (puis reprend son comportement). */
function usePagePointer() {
  const gl = useThree((st) => st.gl);
  const ref = useRef({ ndc: new THREE.Vector2(), movedAt: -Infinity });
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = gl.domElement.getBoundingClientRect();
      if (!r.width || !r.height) return;
      ref.current.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ref.current.movedAt = performance.now();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [gl]);
  return ref;
}

const FOLLOW_MS = 5_000;
const HATCH_OPEN = -1.35;               // ~77° : la trappe pivote vers l'arrière autour de sa charnière basse
const WAVE_S = 2.2;

// --- Wall-E -------------------------------------------------------------------------------
interface WallEProps {
  model: THREE.Group; mode: HoloMode; presence: boolean; light: boolean;
  hatchOpen: boolean; onHatchClick: () => void;
}

function WallE({ model, mode, presence, light, hatchOpen, onHatchClick }: WallEProps) {
  const { scene, neck, eyes, eyeScaleY, eyeMats, armL, armR, hatch } = useMemo(() => {
    const scene = model.clone(true);
    const eyeMats: THREE.MeshStandardMaterial[] = [];
    const eyes = scene.getObjectByName("eyes");
    // Verres (noirs) : matières propres (clonées) pour la pulsation rouge en alerte.
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
    const neck = scene.getObjectByName("neck");
    if (neck) neck.rotation.order = "YXZ";                 // lacet (gauche/droite) puis tangage (haut/bas)
    // Le modèle est quantifié : ses nœuds de maillage portent une échelle propre (ex. 7,7), que le clignement
    // doit multiplier. Bras et trappe sont animés par leurs nœuds-pivots (sans échelle).
    return { scene, neck, eyes, eyeScaleY: eyes?.scale.y ?? 1, eyeMats,
             armL: scene.getObjectByName("armL"), armR: scene.getObjectByName("armR"), hatch: scene.getObjectByName("hatch") };
  }, [model]);

  useEffect(() => () => eyeMats.forEach((m) => m.dispose()), [eyeMats]);

  const pointer = usePagePointer();
  const camera = useThree((st) => st.camera);
  const clock = useThree((st) => st.clock);
  const tmp = useMemo(() => ({ ray: new THREE.Raycaster(), plane: new THREE.Plane(), hit: new THREE.Vector3(), head: new THREE.Vector3(),
                               n: new THREE.Vector3(), color: new THREE.Color() }), []);
  const waveAt = useRef(-Infinity);
  const [hoverHatch, setHoverHatch] = useState(false);
  useEffect(() => {
    document.body.style.cursor = hoverHatch ? "pointer" : "";
    return () => { document.body.style.cursor = ""; };
  }, [hoverHatch]);

  const isHatch = (o: THREE.Object3D | null) => { for (; o; o = o.parent) if (o === hatch) return true; return false; };

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const k = (speed: number) => Math.min(1, dt * speed);
    tmp.color.set(palette(light)[mode]);
    for (const m of eyeMats) {
      m.emissive.lerp(tmp.color, k(3));
      const pulse = mode === "critical" && !REDUCED_MOTION ? 0.55 + 0.45 * Math.sin(t * 8) : 1;
      // Yeux noirs ; seule l'alerte critique les fait pulser en rouge.
      m.emissiveIntensity = THREE.MathUtils.lerp(m.emissiveIntensity, mode === "critical" ? 0.35 * pulse : 0, k(4));
    }

    // Trappe : suit l'état (sas ouvert ou ouverture manuelle), même en mouvement réduit.
    if (hatch) hatch.rotation.x = THREE.MathUtils.lerp(hatch.rotation.x, hatchOpen ? HATCH_OPEN : 0, REDUCED_MOTION ? 1 : k(3));

    // Tête : suit le curseur (tant qu'il bouge), sinon comportement de l'état.
    if (neck) {
      let yaw: number, pitch: number;
      const following = mode !== "offline" && mode !== "critical" && performance.now() - pointer.current.movedAt < FOLLOW_MS;
      if (following) {
        // Point visé : intersection du rayon caméra -> curseur avec le plan face caméra passant par la tête.
        neck.getWorldPosition(tmp.head);
        tmp.n.copy(camera.position).sub(tmp.head).normalize();
        tmp.plane.setFromNormalAndCoplanarPoint(tmp.n, tmp.head);
        tmp.ray.setFromCamera(pointer.current.ndc, camera);
        if (tmp.ray.ray.intersectPlane(tmp.plane, tmp.hit)) {
          neck.parent!.worldToLocal(tmp.hit).sub(neck.position);
          yaw = THREE.MathUtils.clamp(Math.atan2(tmp.hit.x, tmp.hit.z), -1.3, 1.3);
          pitch = THREE.MathUtils.clamp(Math.atan2(-tmp.hit.y, Math.hypot(tmp.hit.x, tmp.hit.z)), -0.45, 0.5);
        } else { yaw = 0; pitch = 0; }
      } else if (REDUCED_MOTION) {
        yaw = 0; pitch = mode === "offline" ? 0.38 : 0;
      } else {
        yaw = mode === "offline" ? 0 : mode === "critical" ? Math.sin(t * 9) * 0.25
          : presence || mode === "warning" ? Math.sin(t * 1.8) * 0.75 : Math.sin(t * 0.45) * 0.35;
        pitch = mode === "offline" ? 0.38 : 0;
      }
      neck.rotation.y = THREE.MathUtils.lerp(neck.rotation.y, yaw, k(following ? 6 : 4));
      neck.rotation.x = THREE.MathUtils.lerp(neck.rotation.x, pitch, k(following ? 6 : 2));
    }

    // Bras : posture selon l'état ; coucou (bras droit) après un clic sur le robot.
    const waving = t - waveAt.current < WAVE_S;
    const still = REDUCED_MOTION;
    const pose = (side: 1 | -1): [number, number] => {          // [tangage, roulis]
      if (mode === "offline") return [0.35, 0];
      if (mode === "critical") return still ? [-0.5, 0] : [-0.45 + Math.sin(t * 7 + (side > 0 ? 0 : Math.PI)) * 0.4, 0];
      if (mode === "warning") return [-0.35 + (still ? 0 : Math.sin(t * 2 + side) * 0.08), 0];
      return [still ? 0 : Math.sin(t * 0.8 + (side > 0 ? 0 : Math.PI)) * 0.12, 0];
    };
    for (const [arm, side] of [[armL, -1], [armR, 1]] as const) {
      if (!arm) continue;
      let [px, pz] = pose(side);
      if (waving && side === 1 && mode !== "offline") { px = -1.1; pz = still ? 0 : Math.sin(t * 10) * 0.35; }
      arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, px, k(waving ? 8 : 4));
      arm.rotation.z = THREE.MathUtils.lerp(arm.rotation.z, pz, k(8));
    }

    if (REDUCED_MOTION) return;
    if (eyes) {                                                                  // clignement toutes les ~4 s
      const blink = mode !== "offline" && t % 4.2 < 0.12;
      eyes.scale.y = THREE.MathUtils.lerp(eyes.scale.y, eyeScaleY * (blink ? 0.1 : 1), k(30));
    }
  });

  return (
    <primitive object={scene}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        if (e.delta > 4) return;                               // c'était une rotation de la vue, pas un clic
        e.stopPropagation();
        if (isHatch(e.object)) onHatchClick();
        else waveAt.current = clock.elapsedTime;               // coucou
      }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => setHoverHatch(isHatch(e.object))}
      onPointerOut={() => setHoverHatch(false)} />
  );
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
    // La vidéo agrandie occupe la moitié droite : Wall-E se centre dans la moitié gauche (à 25 % de la largeur).
    // Décalage d'écran visé : 0,5 en coordonnées normalisées = un quart de la largeur. Pour un décalage de film s
    // (fraction de sa largeur), le déplacement à l'écran vaut s·zoom / (tan(fov/2)·aspect) : on l'inverse.
    const targetZoom = shifted ? 0.72 : 1;                                // recul : marge avec la vidéo, même en rotation
    const targetOffset = shifted
      ? camera.getFilmWidth() * 0.5 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect / targetZoom : 0;
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

interface HologramProps {
  mode: HoloMode;
  presence: boolean;
  shifted?: boolean;
  /** État réel du sas : la trappe du dos de Wall-E s'ouvre avec lui. */
  sasOpen?: boolean;
}

export default function Hologram({ mode, presence, shifted = false, sasOpen = false }: HologramProps) {
  const [model, setModel] = useState<THREE.Group | null>(null);
  // Ouverture manuelle (clic sur la trappe ou bouton) : affichage seulement, rien n'est envoyé au module.
  // Elle s'efface dès que l'état réel du sas change.
  const [manualHatch, setManualHatch] = useState<boolean | null>(null);
  useEffect(() => setManualHatch(null), [sasOpen]);
  const hatchOpen = manualHatch ?? sasOpen;
  const toggleHatch = () => setManualHatch(!hatchOpen);
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
        {model && <WallE model={model} mode={mode} presence={presence} light={light} hatchOpen={hatchOpen} onHatchClick={toggleHatch} />}
        <FramingShift shifted={shifted} />
        <Controls />
      </Canvas>
      {!model && <div className="holo-fallback">Chargement de Wall-E…</div>}
      {model && (
        <button type="button" className="holo-btn" onClick={toggleHatch} aria-pressed={hatchOpen}
                title={hatchOpen ? "Fermer la trappe (affichage)" : "Ouvrir la trappe (affichage)"}
                aria-label={hatchOpen ? "Fermer la trappe de Wall-E" : "Ouvrir la trappe de Wall-E"}>
          <Icon name={hatchOpen ? "unlock" : "lock"} size={15} />
        </button>
      )}
    </WebGLBoundary>
  );
}

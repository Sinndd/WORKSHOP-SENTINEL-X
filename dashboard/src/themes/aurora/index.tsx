// Thème « Aurora » — outils (tools.md) : Shader Gradient (fond animé, Three.js / React Three Fiber) et Motion.
// Dossier autonome : le supprimer retire le thème (cf. ../registry.ts).
import { ShaderGradient, ShaderGradientCanvas } from "@shadergradient/react";
import { animate, stagger } from "motion";
import type { ThemeModule } from "../registry";
import "./theme.css";

const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function Background() {
  return (
    <ShaderGradientCanvas style={{ position: "absolute", inset: 0 }} pixelDensity={1} fov={45} pointerEvents="none" lazyLoad={false}>
      {/* lightType « 3d » : éclairage calculé, aucune image d'environnement téléchargée (fonctionne hors ligne). */}
      <ShaderGradient
        type="waterPlane" animate={REDUCED ? "off" : "on"} uSpeed={0.1} uStrength={2.2} uDensity={1.2} uFrequency={5.5} uAmplitude={0}
        color1="#3a1a8c" color2="#b0306f" color3="#0c6a78" brightness={0.85} grain="off" lightType="3d" reflection={0.1}
        cAzimuthAngle={180} cPolarAngle={90} cDistance={3.6} cameraZoom={1}
        positionX={0} positionY={0} positionZ={0} rotationX={0} rotationY={10} rotationZ={50}
      />
    </ShaderGradientCanvas>
  );
}

/** Apparition des panneaux (fondu + flou) à l'activation et à chaque affichage de la supervision. */
function activate() {
  if (REDUCED) return;
  const reveal = () => animate(".card, .alarm-banner", { opacity: [0, 1], y: [14, 0], filter: ["blur(8px)", "blur(0px)"] },
    { delay: stagger(0.035), duration: 0.6, ease: [0.22, 1, 0.36, 1] });
  reveal();
  const root = document.getElementById("root");
  if (!root) return;
  const observer = new MutationObserver((mutations) => {
    const appeared = mutations.some((m) => [...m.addedNodes].some((n) =>
      n instanceof HTMLElement && (n.matches(".control-room, .login-card, .panels") || n.querySelector(".control-room, .login-card"))));
    if (appeared) reveal();
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}

const theme: ThemeModule = { Background, activate };
export default theme;

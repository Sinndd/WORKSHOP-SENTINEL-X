// Thème « Industriel » — outil (tools.md) : GSAP (apparition séquencée des panneaux, ligne de balayage).
// Dossier autonome : le supprimer retire le thème (cf. ../registry.ts).
import gsap from "gsap";
import { useEffect, useRef } from "react";
import type { ThemeModule } from "../registry";
import "./theme.css";

const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Trame de fond + ligne de balayage verticale qui parcourt l'écran en boucle. */
function Background() {
  const scan = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (REDUCED || !scan.current) return;
    const tween = gsap.fromTo(scan.current, { yPercent: -100 }, { yPercent: 100, duration: 7, ease: "none", repeat: -1, repeatDelay: 2.5 });
    return () => { tween.kill(); };
  }, []);
  return (
    <>
      <div className="indus-grid" />
      <div className="indus-scan-track"><div ref={scan} className="indus-scan" /></div>
    </>
  );
}

/** Panneaux dévoilés comme des volets, l'un après l'autre (activation et ouverture de la supervision). */
function activate() {
  if (REDUCED) return;
  const reveal = () => {
    const cards = gsap.utils.toArray<HTMLElement>(".card, .alarm-banner");
    if (!cards.length) return;
    gsap.fromTo(cards, { clipPath: "inset(0 100% 0 0)", opacity: 0.4 },
      { clipPath: "inset(0 0% 0 0)", opacity: 1, duration: 0.55, ease: "power3.out", stagger: 0.06, clearProps: "clipPath,opacity" });
  };
  reveal();
  const root = document.getElementById("root");
  if (!root) return;
  const observer = new MutationObserver((mutations) => {
    const appeared = mutations.some((m) => [...m.addedNodes].some((n) =>
      n instanceof HTMLElement && (n.matches(".control-room, .login-card, .panels") || n.querySelector(".control-room, .login-card"))));
    if (appeared) reveal();
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => { observer.disconnect(); gsap.killTweensOf(".card, .alarm-banner"); };
}

const theme: ThemeModule = { Background, activate };
export default theme;

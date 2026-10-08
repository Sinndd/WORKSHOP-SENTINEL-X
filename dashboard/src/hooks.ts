import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { mjpegFrames, Unauthorized } from "./api";

/** Exécute une action d'API en gérant message de succès, erreur et expiration de session. */
export function useAction(onExpired: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const result = await fn();
      setError(null);
      if (ok) {
        setNotice(ok);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setNotice(null), 5000);
      }
      return result;
    } catch (e) {
      if (e instanceof Unauthorized) onExpired();
      else setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [onExpired]);

  return { error, notice, busy, run, setError, setNotice };
}

/** Recharge périodique d'une ressource (arrêtée au démontage). */
export function usePolling(load: () => void, ms: number) {
  useEffect(() => {
    load();
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [load, ms]);
}

/** Flux vidéo en direct sur un <canvas> : décode chaque image et ne dessine que la plus récente à chaque rafraîchissement
 *  d'écran (aucun retard cumulé). Renvoie « live » (une image reçue il y a moins de 3 s) et le débit réel reçu en images/s. */
export function useLiveVideo(token: string, canvasRef: RefObject<HTMLCanvasElement | null>) {
  const [live, setLive] = useState(false);
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let stop = false;
    const ctrl = new AbortController();
    let latest: ImageBitmap | null = null;
    let count = 0, lastFrameAt = 0, raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const bmp = latest;
      if (!bmp) return;
      latest = null;
      const c = canvasRef.current;
      if (c) {
        if (c.width !== bmp.width || c.height !== bmp.height) { c.width = bmp.width; c.height = bmp.height; }
        c.getContext("2d")?.drawImage(bmp, 0, 0);
      }
      bmp.close();
    };
    raf = requestAnimationFrame(draw);
    const stats = setInterval(() => { setFps(count); count = 0; setLive(Date.now() - lastFrameAt < 3000); }, 1000);
    (async () => {
      while (!stop) {
        try {
          for await (const jpeg of mjpegFrames("/api/v1/vision/stream", token, ctrl.signal)) {
            const bmp = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
            latest?.close();
            latest = bmp; count++; lastFrameAt = Date.now();
          }
        } catch { /* flux coupé ou 401 : on retente */ }
        if (!stop) await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => { stop = true; ctrl.abort(); cancelAnimationFrame(raf); clearInterval(stats); latest?.close(); };
  }, [token, canvasRef]);
  return { live, fps };
}

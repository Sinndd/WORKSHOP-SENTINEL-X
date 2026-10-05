import { useCallback, useEffect, useRef, useState } from "react";
import { Unauthorized } from "./api";

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

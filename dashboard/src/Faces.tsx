import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { getJson, send, uploadImage } from "./api";
import { Card, StatusBadge } from "./components/ui";
import { dateTime } from "./format";
import { useAction, useLiveVideo, usePolling } from "./hooks";
import type { FaceEnrollment, FaceMember } from "./types";

const END_MESSAGES: Record<string, string> = {
  TIMEOUT: "Délai écoulé : le visage n'a pas été enregistré. Relancez l'ajout.",
  CANCELLED: "Ajout annulé.",
  FAILED: "L'ajout a échoué.",
};

/** Photo d'appareil/téléphone : réduite à 1600 px et recompressée (l'API accepte 2 Mio au maximum). */
async function shrink(file: File): Promise<Blob> {
  if (file.size < 1_500_000 && /jpeg|png/.test(file.type)) return file;
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return new Promise((ok, ko) => c.toBlob((b) => (b ? ok(b) : ko(new Error("image illisible"))), "image/jpeg", 0.9));
}

/** Suivi d'un ajout en cours : avancement, consignes, et direct de la caméra pour se cadrer. */
function Progress({ token, enrollment, onDone, onExpired }:
  { token: string; enrollment: FaceEnrollment; onDone: (e: FaceEnrollment) => void; onExpired: () => void }) {
  const [current, setCurrent] = useState(enrollment);
  const [now, setNow] = useState(Date.now());
  const canvas = useRef<HTMLCanvasElement>(null);
  const { busy, run } = useAction(onExpired);
  const camera = current.mode === "camera";

  useEffect(() => {
    if (current.status !== "PENDING") return;
    const id = setInterval(async () => {
      setNow(Date.now());
      try {
        const e = await getJson<FaceEnrollment>(`/api/v1/faces/enrollments/${current.id}`, token);
        setCurrent(e);
        if (e.status !== "PENDING") onDone(e);
      } catch { /* nouvelle tentative au prochain tour */ }
    }, 1000);
    return () => clearInterval(id);
  }, [current.id, current.status, token, onDone]);

  const left = Math.max(0, Math.ceil((Date.parse(current.expires_at) - now) / 1000));
  const cancel = () => run(async () => {
    const e = await send<FaceEnrollment>("DELETE", `/api/v1/faces/enrollments/${current.id}`, token);
    setCurrent(e); onDone(e);
  });

  return (
    <div className="alert-banner" role="status" style={{ display: "block" }}>
      {camera ? <>
        <strong>Placez {current.name} face à la caméra</strong> — regardez l'objectif, puis tournez très légèrement la tête
        entre les captures. <strong>{current.samples_done} / {current.samples_target}</strong> échantillons.
        <div style={{ height: 6, background: "rgba(127,127,127,.25)", borderRadius: 3, margin: "10px 0" }}>
          <div style={{ height: "100%", width: `${(100 * current.samples_done) / current.samples_target}%`, background: "currentColor",
                        borderRadius: 3, transition: "width .6s" }} />
        </div>
        <LiveCanvas token={token} canvas={canvas} />
      </> : <><strong>Analyse de la photo de {current.name}…</strong></>}
      <div className="muted">{current.error ?? (camera ? "Une seule personne devant la caméra." : "Un seul visage visible, de face.")} Il reste {left} s.</div>
      <div style={{ marginTop: 10 }}><button className="btn btn-sm" onClick={cancel} disabled={busy}>Annuler</button></div>
    </div>
  );
}

function LiveCanvas({ token, canvas }: { token: string; canvas: React.RefObject<HTMLCanvasElement | null> }) {
  const { live } = useLiveVideo(token, canvas);
  return (
    <div style={{ maxWidth: 360, margin: "8px 0" }}>
      <canvas ref={canvas} style={{ width: "100%", borderRadius: 6, background: "#111", aspectRatio: "4 / 3" }} />
      {!live && <div className="muted">Pas de flux caméra : le script de vision (scripts/run-vision.sh) est-il lancé ?</div>}
    </div>
  );
}

function AddForm({ token, disabled, members, onStarted, onExpired }:
  { token: string; disabled: boolean; members: FaceMember[]; onStarted: (e: FaceEnrollment) => void; onExpired: () => void }) {
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [mode, setMode] = useState<"camera" | "photo">("camera");
  const [file, setFile] = useState<File | null>(null);
  const { error, busy, run } = useAction(onExpired);
  const existing = members.find((m) => m.name.toLowerCase() === name.trim().toLowerCase());

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const started = await run(async () => {
      const who = existing ? { member_id: existing.id } : { name: name.trim(), consent };
      if (mode === "camera") return send<FaceEnrollment>("POST", "/api/v1/faces/enrollments", token, { ...who, mode, consent: true, samples: 5 });
      const q = new URLSearchParams(existing ? { member_id: String(existing.id), consent: "true" }
        : { name: name.trim(), consent: String(consent) });
      return uploadImage<FaceEnrollment>(`/api/v1/faces/enrollments/photo?${q}`, token, await shrink(file!));
    });
    if (started) { setFile(null); onStarted(started); }
  };

  return (
    <Card title="Ajouter un visage" icon="face"
          sub="Les photos ne sont jamais conservées : seul un vecteur numérique de 128 valeurs est enregistré.">
      <form onSubmit={submit} className="form-grid">
        {error && <div className="alert-banner error-banner" role="alert" style={{ gridColumn: "1 / -1" }}>{error}</div>}
        <div className="field-group">
          <label htmlFor="fc-name">Nom de la personne</label>
          <input id="fc-name" list="face-names" value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} autoComplete="off" />
          <datalist id="face-names">{members.map((m) => <option key={m.id} value={m.name} />)}</datalist>
          {existing && <span className="muted">Personne déjà enregistrée : de nouveaux échantillons seront ajoutés (meilleure fiabilité).</span>}
        </div>
        <div className="field-group">
          <label>Méthode</label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="radio" name="fc-mode" checked={mode === "camera"} onChange={() => setMode("camera")} />
            Caméra — la personne se place devant (recommandé)
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="radio" name="fc-mode" checked={mode === "photo"} onChange={() => setMode("photo")} />
            Photo — envoyer une image (de face, un seul visage)
          </label>
        </div>
        {mode === "photo" && <div className="field-group">
          <label htmlFor="fc-file">Photo</label>
          <input id="fc-file" type="file" accept="image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </div>}
        {!existing && <div className="field-group" style={{ gridColumn: "1 / -1" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            Cette personne a donné son accord pour l'enregistrement de son visage (donnée biométrique).
          </label>
        </div>}
        <div style={{ gridColumn: "1 / -1" }}>
          <button className="btn btn-primary" disabled={busy || disabled || !name.trim() || (!existing && !consent) || (mode === "photo" && !file)}>
            {busy ? "Envoi…" : mode === "camera" ? "Lancer la capture" : "Envoyer la photo"}
          </button>
          {disabled && <span className="muted" style={{ marginLeft: 12 }}>Un ajout est déjà en cours.</span>}
        </div>
      </form>
    </Card>
  );
}

export default function FacesView({ token, onExpired }: { token: string; onExpired: () => void }) {
  const [members, setMembers] = useState<FaceMember[]>([]);
  const [active, setActive] = useState<FaceEnrollment | null>(null);
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const { error, notice, busy, run, setNotice } = useAction(onExpired);

  const load = useCallback(() => { run(async () => { setMembers(await getJson<FaceMember[]>("/api/v1/faces", token)); }); }, [token, run]);
  usePolling(load, 10_000);

  const onDone = useCallback((e: FaceEnrollment) => {
    setActive(null);
    setNotice(e.status === "SUCCESS" ? `${e.name} est enregistré(e) (${e.samples_done} échantillon(s)). La reconnaissance est à jour dans quelques secondes.`
      : `${END_MESSAGES[e.status] ?? "Terminé."}${e.error ? ` ${e.error}.` : ""}`);
    load();
  }, [load, setNotice]);


  const toggle = async (m: FaceMember) => {
    if (m.active && !window.confirm(`Désactiver ${m.name} ? Son visage ne sera plus reconnu comme autorisé.`)) return;
    await run(() => send("PATCH", `/api/v1/faces/${m.id}`, token, { active: !m.active }), m.active ? "Visage désactivé." : "Visage réactivé.");
    load();
  };
  const remove = async (m: FaceMember) => {
    if (!window.confirm(`Supprimer définitivement ${m.name} et ses ${m.samples} échantillon(s) ? Cette action est irréversible.`)) return;
    await run(() => send("DELETE", `/api/v1/faces/${m.id}`, token), "Visage supprimé.");
    load();
  };
  const rename = async () => {
    if (!editing) return;
    await run(() => send("PATCH", `/api/v1/faces/${editing.id}`, token, { name: editing.name.trim() }), "Nom modifié.");
    setEditing(null);
    load();
  };

  return (
    <div>
      {error && <div className="alert-banner error-banner" role="alert">{error}</div>}
      {notice && <div className="alert-banner success-banner" role="status">{notice}</div>}
      {active && <Progress token={token} enrollment={active} onDone={onDone} onExpired={onExpired} />}
      <AddForm token={token} members={members} disabled={!!active} onExpired={onExpired} onStarted={(e) => { setNotice(null); setActive(e); }} />

      <div style={{ marginTop: 12 }}>
        <Card title={`Visages autorisés (${members.length})`}>
          <div className="table-wrap tall">
            <table>
              <thead><tr><th>Nom</th><th>Échantillons</th><th>État</th><th>Ajouté</th><th>Actions</th></tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>{editing?.id === m.id
                      ? <input value={editing.name} maxLength={64} aria-label="Nom" onChange={(e) => setEditing({ id: m.id, name: e.target.value })} />
                      : m.name}</td>
                    <td>{m.samples}{m.samples < 3 && <span className="muted"> — peu fiable, ajoutez-en</span>}</td>
                    <td>{m.active ? <StatusBadge status="good">Actif</StatusBadge> : <StatusBadge status="neutral">Désactivé</StatusBadge>}</td>
                    <td>{dateTime(m.created_at)}{m.created_by ? ` · ${m.created_by}` : ""}</td>
                    <td className="actions-cell">
                      {editing?.id === m.id ? (<>
                        <button className="btn btn-sm btn-primary" disabled={busy || !editing.name.trim()} onClick={rename}>Enregistrer</button>
                        <button className="btn btn-sm" onClick={() => setEditing(null)}>Annuler</button>
                      </>) : (<>
                        <button className="btn btn-sm" onClick={() => setEditing({ id: m.id, name: m.name })}>Renommer</button>
                        <button className="btn btn-sm" onClick={() => toggle(m)} disabled={busy}>{m.active ? "Désactiver" : "Réactiver"}</button>
                        <button className="btn btn-sm btn-danger" onClick={() => remove(m)} disabled={busy}>Supprimer</button>
                      </>)}
                    </td>
                  </tr>
                ))}
                {!members.length && <tr><td colSpan={5} className="muted">Aucun visage enregistré : personne n'est reconnu comme autorisé.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

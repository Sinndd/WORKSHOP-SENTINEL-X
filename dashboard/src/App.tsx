import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import AccountView, { PasswordForm, ROLE_LABELS } from "./Account";
import { getJson, loginApi, OtpRequired, send, Unauthorized, type Session } from "./api";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { Icon } from "./components/ui";
import SecurityView from "./Security";
import Supervision from "./Supervision";
import type { Me } from "./types";
import UsersView from "./Users";

const SESSION_KEY = "sentinel.apiToken";   // sessionStorage : effacé à la fermeture de l'onglet
type View = "supervision" | "users" | "security" | "account";

const BANNER = String.raw`
███████╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗██╗          ██╗  ██╗
██╔════╝██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝██║          ╚██╗██╔╝
███████╗█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║█████╗  ██║    █████╗ ╚███╔╝
╚════██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══╝  ██║    ╚════╝ ██╔██╗
███████║███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████╗███████╗     ██╔╝ ██╗
╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝     ╚═╝  ╚═╝`.slice(1);

function readToken(): string {
  try { return sessionStorage.getItem(SESSION_KEY) ?? ""; } catch { return ""; }
}
function storeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* stockage indisponible */ }
}
const typingInField = (e: KeyboardEvent) =>
  e.target instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable);

export default function App() {
  const [token, setToken] = useState(readToken);
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>("supervision");
  const [notice, setNotice] = useState<string | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [viewCommands, setViewCommands] = useState<PaletteCommand[]>([]);

  const expire = useCallback((message = "Session expirée : veuillez vous reconnecter.") => {
    storeToken(null);
    setToken("");
    setMe(null);
    setView("supervision");
    setNotice(message);
  }, []);
  const onExpired = useCallback(() => expire(), [expire]);

  const loadMe = useCallback(async () => {
    if (!token) return;
    try {
      setMe(await getJson<Me>("/api/v1/auth/me", token));
      setMeError(null);
    } catch (e) {
      if (e instanceof Unauthorized) expire();
      else setMeError((e as Error).message);
    }
  }, [token, expire]);
  useEffect(() => { loadMe(); }, [loadMe]);

  const onLogin = (s: Session) => {
    storeToken(s.token);
    setNotice(null);
    setToken(s.token);
  };

  const logout = useCallback(async () => {
    try { await send("POST", "/api/v1/auth/logout", token); } catch { /* session déjà invalide */ }
    expire("Vous êtes déconnecté.");
  }, [token, expire]);

  const isAdmin = me?.role === "admin";
  const tabs = useMemo(() => ([
    { id: "supervision" as View, label: "Supervision", show: true },
    { id: "security" as View, label: "Sécurité", show: isAdmin },
    { id: "users" as View, label: "Utilisateurs", show: isAdmin },
    { id: "account" as View, label: "Mon compte", show: true },
  ]).filter((t) => t.show), [isAdmin]);

  const ready = Boolean(token && me && !me.must_change_password);

  // Raccourcis : 1-4 = sections, Ctrl/⌘-K = palette de commandes.
  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); return; }
      if (paletteOpen || typingInField(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= tabs.length) setView(tabs[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, tabs, paletteOpen]);

  const commands = useMemo<PaletteCommand[]>(() => [
    ...tabs.map((t, i) => ({ id: `view-${t.id}`, group: "Navigation", label: `[${i + 1}] Aller à : ${t.label}`, run: () => setView(t.id) })),
    ...(view === "supervision" ? viewCommands : []),
    { id: "logout", group: "Session", label: "Se déconnecter", run: logout },
  ], [tabs, view, viewCommands, logout]);

  if (!token) return <LoginGate notice={notice} onLogin={onLogin} />;

  if (!me) {
    return (
      <div className="login-wrapper">
        <div className="card gate login-card">
          <div className="body" style={{ paddingTop: 16 }}>
            {meError ? <>
              <div className="alert-banner error-banner" role="alert">{meError}</div>
              <button className="btn btn-block" onClick={loadMe}>Réessayer</button>
            </> : <p className="muted cursor">Chargement de la session</p>}
          </div>
        </div>
      </div>
    );
  }

  if (me.must_change_password) {
    return (
      <div className="login-wrapper">
        <div className="card gate login-card">
          <header className="card-head"><h2>Première connexion</h2></header>
          <div className="login-header">
            <h2>CHOISISSEZ VOTRE MOT DE PASSE</h2>
            <p className="sub">Le mot de passe temporaire doit être remplacé avant d'accéder au système.</p>
          </div>
          <div className="body">
            <PasswordForm token={token} username={me.username} onDone={loadMe} onExpired={onExpired} />
            <div className="login-toggle"><button className="link-button" onClick={logout}>Se déconnecter</button></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="logo" aria-hidden><Icon name="shield" size={16} /></span>
            <div className="brand-text"><strong className="glow">SENTINEL-X</strong><span>AetherCorp // centre de supervision</span></div>
          </div>
          <nav className="tabs" aria-label="Sections">
            {tabs.map((t, i) => (
              <button key={t.id} aria-current={view === t.id ? "page" : undefined} onClick={() => setView(t.id)}
                      aria-keyshortcuts={String(i + 1)}>
                <kbd>{i + 1}</kbd>{t.label}
              </button>
            ))}
          </nav>
          <span className="spacer" />
          <Clock />
          <button className="kbd-hint" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K Meta+K">Ctrl-K commandes</button>
          <div className="user-badge" title={`${me.username} — ${ROLE_LABELS[me.role]}`}>
            <span className="user-name">{me.username}</span>
            <span className="role-tag">{me.service ? "service" : ROLE_LABELS[me.role]}</span>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={logout}>Déconnexion</button>
        </div>
      </header>

      {view === "supervision" && <Supervision token={token} canOperate={me.role !== "viewer"} onExpired={onExpired}
                                              onCommands={setViewCommands} />}
      <main className="page" hidden={view === "supervision"}>
        {view === "security" && isAdmin && <SecurityView token={token} onExpired={onExpired} />}
        {view === "users" && isAdmin && <UsersView token={token} me={me} onExpired={onExpired} />}
        {view === "account" && <AccountView token={token} me={me} onChanged={loadMe} onExpired={onExpired} />}
      </main>

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
    </>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  const local = now.toLocaleTimeString("fr-FR");
  const utc = now.toISOString().slice(11, 19);
  return <span className="clock" role="timer" aria-label={`Heure locale ${local}, UTC ${utc}`}><b>{local}</b> LOC · {utc} UTC</span>;
}

const BOOT_LINES: { text: string; tone?: "ok" | "warn" }[] = [
  { text: "AETHERCORP BIOS v4.2 — module SENTINEL-X" },
  { text: "[ OK ] liaison MQTTS 8883 (TLS 1.2, CA interne)", tone: "ok" },
  { text: "[ OK ] base de télémétrie montée", tone: "ok" },
  { text: "[ OK ] holo-projecteur WALL-E MK2 en veille", tone: "ok" },
  { text: "[WARN] accès restreint — chaque connexion est journalisée", tone: "warn" },
];

function LoginGate({ notice, onLogin }: { notice: string | null; onLogin: (s: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [needOtp, setNeedOtp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      onLogin(await loginApi(username.trim(), password, needOtp ? otp : undefined));
    } catch (err) {
      if (err instanceof OtpRequired) setNeedOtp(true);
      else {
        setError((err as Error).message || "Connexion impossible");
        if (needOtp) setOtp("");
        else setPassword("");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrapper">
      <motion.form className="card gate login-card" onSubmit={submit}
                   initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
        <header className="card-head"><h2>Terminal d'accès</h2><span className="card-actions">tty1 · session sécurisée</span></header>
        <h1 style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", margin: 0 }}>SENTINEL-X</h1>
        <pre className="ascii glow" aria-hidden>{BANNER}</pre>
        <div className="boot">
          {BOOT_LINES.map((l, i) => (
            <motion.div key={l.text} className={l.tone} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        transition={{ delay: 0.15 + i * 0.18, duration: 0.01 }}>{l.text}</motion.div>
          ))}
        </div>

        <div className="body">
          {notice && !error && <div className="alert-banner warn-banner" role="status">{notice}</div>}
          {error && <div className="alert-banner error-banner" role="alert">{error}</div>}

          {!needOtp ? (
            <>
              <div className="field-group">
                <label htmlFor="login-user">login</label>
                <input id="login-user" type="text" autoComplete="username" value={username} autoFocus required spellCheck={false}
                       onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="field-group">
                <label htmlFor="login-pass">password</label>
                <input id="login-pass" type="password" autoComplete="current-password" value={password} required
                       onChange={(e) => setPassword(e.target.value)} />
              </div>
            </>
          ) : (
            <div className="field-group">
              <label htmlFor="login-otp">code de double authentification</label>
              <input id="login-otp" inputMode="numeric" autoComplete="one-time-code" placeholder="6 chiffres" value={otp}
                     autoFocus required onChange={(e) => setOtp(e.target.value)} />
            </div>
          )}

          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
            {loading ? "Vérification…" : needOtp ? "Valider le code" : "Connexion"}
          </button>
          {needOtp && (
            <div className="login-toggle">
              <button type="button" className="link-button" onClick={() => { setNeedOtp(false); setOtp(""); setPassword(""); setError(null); }}>
                ← Changer de compte
              </button>
            </div>
          )}
        </div>
      </motion.form>
    </div>
  );
}

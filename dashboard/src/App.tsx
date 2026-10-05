import { useCallback, useEffect, useState, type FormEvent } from "react";
import AccountView, { PasswordForm, ROLE_LABELS } from "./Account";
import { getJson, loginApi, OtpRequired, send, Unauthorized, type Session } from "./api";
import { Icon } from "./components/ui";
import SecurityView from "./Security";
import Supervision from "./Supervision";
import type { Me } from "./types";
import UsersView from "./Users";

const SESSION_KEY = "sentinel.apiToken";   // sessionStorage : effacé à la fermeture de l'onglet
type View = "supervision" | "users" | "security" | "account";

function readToken(): string {
  try { return sessionStorage.getItem(SESSION_KEY) ?? ""; } catch { return ""; }
}
function storeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* stockage indisponible */ }
}

export default function App() {
  const [token, setToken] = useState(readToken);
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>("supervision");
  const [notice, setNotice] = useState<string | null>(null);
  const [meError, setMeError] = useState<string | null>(null);

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

  const logout = async () => {
    try { await send("POST", "/api/v1/auth/logout", token); } catch { /* session déjà invalide */ }
    expire("Vous êtes déconnecté.");
  };

  if (!token) return <LoginGate notice={notice} onLogin={onLogin} />;

  if (!me) {
    return (
      <div className="login-wrapper">
        <div className="card gate login-card">
          {meError ? <>
            <div className="alert-banner error-banner" role="alert">{meError}</div>
            <button className="btn btn-block" onClick={loadMe}>Réessayer</button>
          </> : <p className="muted">Chargement de la session…</p>}
        </div>
      </div>
    );
  }

  if (me.must_change_password) {
    return (
      <div className="login-wrapper">
        <div className="card gate login-card">
          <div className="login-header">
            <span className="corp-tag">PREMIÈRE CONNEXION</span>
            <h2>Choisissez votre mot de passe</h2>
            <p className="sub">Le mot de passe temporaire doit être remplacé avant d'accéder au système.</p>
          </div>
          <PasswordForm token={token} username={me.username} onDone={loadMe} onExpired={onExpired} />
          <div className="login-toggle"><button className="link-button" onClick={logout}>Se déconnecter</button></div>
        </div>
      </div>
    );
  }

  const isAdmin = me.role === "admin";
  const tabs: { id: View; label: string; show: boolean }[] = [
    { id: "supervision", label: "Supervision", show: true },
    { id: "security", label: "Sécurité", show: isAdmin },
    { id: "users", label: "Utilisateurs", show: isAdmin },
    { id: "account", label: "Mon compte", show: true },
  ];

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="logo" aria-hidden><Icon name="shield" size={18} /></span>
            <div className="brand-text"><strong>SENTINEL-X</strong><span>AetherCorp · Centre de supervision</span></div>
          </div>
          <nav className="tabs" aria-label="Sections">
            {tabs.filter((t) => t.show).map((t) => (
              <button key={t.id} aria-current={view === t.id ? "page" : undefined} onClick={() => setView(t.id)}>{t.label}</button>
            ))}
          </nav>
          <span className="spacer" />
          <div className="user-badge" title={`${me.username} — ${ROLE_LABELS[me.role]}`}>
            <span className="avatar" aria-hidden>{me.full_name.slice(0, 1).toUpperCase()}</span>
            <span className="user-name">{me.full_name}</span>
            <span className="role-tag">{me.service ? "service" : ROLE_LABELS[me.role]}</span>
          </div>
          <button className="btn btn-ghost" onClick={logout}>Déconnexion</button>
        </div>
      </header>

      <main className="page">
      {view === "supervision" && <Supervision token={token} canOperate={me.role !== "viewer"} onExpired={onExpired} />}
      {view === "security" && isAdmin && <SecurityView token={token} onExpired={onExpired} />}
      {view === "users" && isAdmin && <UsersView token={token} me={me} onExpired={onExpired} />}
      {view === "account" && <AccountView token={token} me={me} onChanged={loadMe} onExpired={onExpired} />}
      </main>
    </>
  );
}

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
      <form className="card gate login-card" onSubmit={submit}>
        <div className="login-header">
          <span className="logo big" aria-hidden><Icon name="shield" size={26} /></span>
          <span className="corp-tag">AETHERCORP INDUSTRIAL SOLUTIONS</span>
          <h2>SENTINEL-X</h2>
          <p className="sub">Accès réservé aux personnes autorisées. Chaque connexion est journalisée.</p>
        </div>

        {notice && !error && <div className="alert-banner warn-banner" role="status">{notice}</div>}
        {error && <div className="alert-banner error-banner" role="alert">{error}</div>}

        {!needOtp ? (
          <>
            <div className="field-group">
              <label htmlFor="login-user">Identifiant</label>
              <input id="login-user" type="text" autoComplete="username" value={username} autoFocus required
                     onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="field-group">
              <label htmlFor="login-pass">Mot de passe</label>
              <input id="login-pass" type="password" autoComplete="current-password" value={password} required
                     onChange={(e) => setPassword(e.target.value)} />
            </div>
          </>
        ) : (
          <div className="field-group">
            <label htmlFor="login-otp">Code de double authentification</label>
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
      </form>
    </div>
  );
}

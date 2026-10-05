"""Audit défensif de l'API SENTINEL-X : vérifie que chaque protection tient sur l'instance qui tourne.

Exécuté DANS le conteneur api (il y trouve API_TOKEN) par scripts/audit-security.sh :
    docker compose exec -T api python - < scripts/audit_api.py
Aucune attaque destructive : ce sont des requêtes isolées, comparées au comportement attendu.
"""
import http.client
import json
import os
import re

HOST, PORT = "127.0.0.1", 8000
OP = {"Authorization": f"Bearer {os.environ['API_TOKEN']}"}
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""), flush=True)


def call(method, path, headers=None, body=None, raw_headers=None):
    conn = http.client.HTTPConnection(HOST, PORT, timeout=10)
    try:
        h = dict(headers or {})
        if body is not None and "Content-Type" not in h:
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=body, headers=h)
        res = conn.getresponse()
        data = res.read()
        return res.status, dict((k.lower(), v) for k, v in res.getheaders()), data
    except Exception as e:  # connexion refusée / coupée par le serveur
        return 0, {}, str(e).encode()
    finally:
        conn.close()


# --- 1. Toute route de données exige une authentification -------------------------------------------
spec = json.loads(call("GET", "/openapi.json")[2])
PUBLIC = {("GET", "/health"), ("GET", "/ready"), ("POST", "/api/v1/auth/login")}
unprotected = []
total = 0
for path, methods in spec["paths"].items():
    for method in methods:
        if (method.upper(), path) in PUBLIC:
            continue
        url = re.sub(r"\{[^}]+\}", "1", path)
        if "card_uid" in path:
            url = path.replace("{card_uid}", "A3:5F:B2:1C")
        total += 1
        status, _, _ = call(method.upper(), url, body="{}" if method.upper() != "GET" else None)
        if status != 401:
            unprotected.append(f"{method.upper()} {path} -> {status}")
check(f"{total} routes API refusent l'accès sans jeton (401)", not unprotected, "; ".join(unprotected))

# --- 2. Séparation des rôles : le jeton de service n'administre pas ---------------------------------
admin_paths = [("GET", "/api/v1/users"), ("GET", "/api/v1/security/events"), ("GET", "/api/v1/security/summary"),
               ("GET", "/api/v1/security/sessions"), ("GET", "/api/v1/security/blocked-ips"),
               ("POST", "/api/v1/users/1/reset-password"), ("PATCH", "/api/v1/users/1")]
bad = [f"{m} {p}" for m, p in admin_paths if call(m, p, OP, "{}" if m != "GET" else None)[0] != 403]
check("jeton de service : administration des comptes et journal de sécurité refusés (403)", not bad, ", ".join(bad))

# --- 3. En-têtes de sécurité ------------------------------------------------------------------------------
_, h, _ = call("GET", "/api/v1/devices", OP)
needed = {"x-content-type-options": "nosniff", "x-frame-options": "DENY", "cache-control": "no-store",
          "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin"}
missing = [k for k, v in needed.items() if h.get(k) != v]
check("en-têtes de sécurité de l'API", not missing, ", ".join(missing))
_, h, _ = call("GET", "/dashboard/")
check("CSP stricte sur le dashboard (pas de script inline/externe)", "script-src 'self'" in h.get("content-security-policy", "")
      and "frame-ancestors 'none'" in h.get("content-security-policy", ""))
check("bannière de version masquée (en-tête Server absent)", "server" not in h, h.get("server", ""))

# --- 4. Entrées malveillantes : jamais de 500, jamais d'erreur SQL exposée ------------------------------
payloads = ["' OR '1'='1", "1; DROP TABLE users;--", "\" UNION SELECT password_hash FROM users--", "../../../etc/passwd",
            "%00", "A" * 5000, "${jndi:ldap://x/a}", "<script>alert(1)</script>"]
leaks = []
for p in payloads:
    q = http.client.urllib.parse.quote(p, safe="") if hasattr(http.client, "urllib") else p
    import urllib.parse
    q = urllib.parse.quote(p, safe="")
    for path in (f"/api/v1/telemetry/latest?node_id={q}", f"/api/v1/alerts?node_id={q}&limit={q}",
                 f"/api/v1/telemetry?since={q}", f"/api/v1/security/events?event_type={q}", f"/api/v1/badges/{q}"):
        status, _, body = call("GET" if "badges" not in path else "DELETE", path, OP)
        if status >= 500 or re.search(rb"psycopg|syntax error|traceback|postgres", body, re.I):
            leaks.append(f"{path[:50]} -> {status}")
check("charges d'injection (SQL, traversée, XSS, log4shell) : aucune erreur 500 ni fuite", not leaks, "; ".join(leaks[:3]))
for p in ["' OR 1=1--", "admin'--", "admin\" OR \"1\"=\"1"]:
    status, _, body = call("POST", "/api/v1/auth/login", body=json.dumps({"username": p, "password": p}))
    if status != 401 or b"Identifiants incorrects" not in body:
        check("injection SQL sur la connexion : toujours 401 générique", False, f"{p} -> {status}")
        break
else:
    check("injection SQL sur la connexion : toujours 401 générique", True)

# --- 5. Limites de taille et de forme ------------------------------------------------------------------------
check("corps JSON > 64 Kio refusé (413)", call("POST", "/api/v1/alerts", OP, "x" * 70000)[0] == 413)
check("snapshot > 2 Mio refusé (413)", call("POST", "/api/v1/vision/snapshot", OP, b"\xff\xd8\xff" + b"0" * 2200000)[0] == 413)
check("snapshot non-JPEG refusé (415)", call("POST", "/api/v1/vision/snapshot", OP, b"<svg onload=alert(1)>")[0] == 415)
check("methode TRACE refusée", call("TRACE", "/api/v1/devices", OP)[0] in (405, 501))
status, _, _ = call("GET", "/api/v1/alerts?limit=1000000", OP)
check("paramètre limit borné (422)", status == 422)

# --- 6. Contournements classiques d'authentification ---------------------------------------------------------
check("jeton passé en paramètre d'URL ignoré", call("GET", f"/api/v1/devices?token={OP['Authorization'][7:]}")[0] == 401)
check("schéma d'autorisation Basic refusé", call("GET", "/api/v1/devices", {"Authorization": "Basic YWRtaW46YWRtaW4="})[0] == 401)
check("jeton vide / 'null' / 'undefined' refusés", all(call("GET", "/api/v1/devices", {"Authorization": f"Bearer {t}"})[0] == 401
                                                      for t in ("", "null", "undefined", "sx_", "sx_AAAA")))
status, h, _ = call("OPTIONS", "/api/v1/devices", {"Origin": "https://evil.example", "Access-Control-Request-Method": "GET",
                                                    "Access-Control-Request-Headers": "authorization"})
check("CORS : aucune origine tierce autorisée", "access-control-allow-origin" not in h)
status, _, body = call("GET", "/dashboard/..%2f..%2fapp/auth.py")
check("traversée de chemin sur /dashboard bloquée", b"hash_password" not in body)
status, _, body = call("GET", "/dashboard/%2e%2e/%2e%2e/etc/passwd")
check("traversée de chemin (encodée) bloquée", b"root:" not in body)

# --- 7. Connexion : pas d'énumération de comptes -----------------------------------------------------------------
a = call("POST", "/api/v1/auth/login", body=json.dumps({"username": "nexiste.pas.1", "password": "x"}))
b = call("POST", "/api/v1/auth/login", body=json.dumps({"username": "admin", "password": "x" * 20}))
check("compte inconnu / mauvais mot de passe : même réponse", a[0] == b[0] == 401 and a[2] == b[2], f"{a[2]!r} vs {b[2]!r}")
status, _, body = call("POST", "/api/v1/auth/login", body=json.dumps({"username": "a", "password": "x", "extra": 1, "otp": 5}))
check("connexion : types stricts (otp numérique refusé, 422)", status == 422)

# --- 8. Rien de sensible dans les réponses publiques ----------------------------------------------------------------
_, _, body = call("GET", "/ready")
check("/ready n'expose aucun secret", not re.search(rb"password|token|secret|@", body, re.I))
js = b""
for name in re.findall(rb'/dashboard/assets/[^"\']+\.js', call("GET", "/dashboard/")[2]):
    js += call("GET", name.decode())[2]
secrets_in_js = [m for m in (os.environ["API_TOKEN"], os.environ.get("API_DEVICE_TOKEN", "")) if m and m.encode() in js]
check("aucun jeton dans le JavaScript du dashboard", not secrets_in_js)

print(f"\n{sum(results)}/{len(results)} contrôles API réussis")
raise SystemExit(0 if all(results) else 1)

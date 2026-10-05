"""Authentification par jeton (en-tête « Authorization: Bearer <jeton> »)."""
import secrets

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import config

_bearer = HTTPBearer(auto_error=False)


def _check(creds: HTTPAuthorizationCredentials | None, *tokens: str) -> None:
    given = creds.credentials.encode() if creds else b""
    # compare_digest : comparaison en temps constant (pas de fuite par mesure de temps).
    if not any(secrets.compare_digest(given, t.encode()) for t in tokens):
        raise HTTPException(401, "jeton absent ou invalide", headers={"WWW-Authenticate": "Bearer"})


def require_operator(creds: HTTPAuthorizationCredentials | None = Security(_bearer)) -> None:
    _check(creds, config.API_TOKEN)


def require_device_or_operator(creds: HTTPAuthorizationCredentials | None = Security(_bearer)) -> None:
    _check(creds, config.API_DEVICE_TOKEN, config.API_TOKEN)

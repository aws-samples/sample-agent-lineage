"""Cognito JWT authentication (enabled when COGNITO_USER_POOL_ID is set).

Locally (no env vars) auth is disabled and the API behaves as before.
In the deployed stack, every /api/* request except PUBLIC_PATHS requires a
Bearer token issued by the stack's Cognito user pool.
"""
import os

import jwt
from jwt import PyJWKClient

REGION = os.environ.get("COGNITO_REGION") or os.environ.get("AWS_REGION", "us-east-1")
USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", "")
CLIENT_ID = os.environ.get("COGNITO_CLIENT_ID", "")
DOMAIN = os.environ.get("COGNITO_DOMAIN", "")
ENABLED = bool(USER_POOL_ID and CLIENT_ID)
ISSUER = f"https://cognito-idp.{REGION}.amazonaws.com/{USER_POOL_ID}"

PUBLIC_PATHS = {"/api/v1/health", "/api/v1/auth/config"}

_jwks: PyJWKClient | None = None


def _jwks_client() -> PyJWKClient:
    global _jwks
    if _jwks is None:
        _jwks = PyJWKClient(f"{ISSUER}/.well-known/jwks.json")
    return _jwks


def auth_config() -> dict:
    """Public endpoint payload: what the frontend needs for the login flow."""
    return {"enabled": ENABLED, "domain": DOMAIN, "client_id": CLIENT_ID, "region": REGION}


def verify_token(token: str) -> dict:
    """Validate signature, issuer, expiry and client binding. Raises on failure."""
    key = _jwks_client().get_signing_key_from_jwt(token).key
    claims = jwt.decode(
        token, key, algorithms=["RS256"], issuer=ISSUER, options={"verify_aud": False}
    )
    token_use = claims.get("token_use")
    if token_use == "id":
        if claims.get("aud") != CLIENT_ID:
            raise jwt.InvalidAudienceError("id token audience mismatch")
    elif token_use == "access":
        if claims.get("client_id") != CLIENT_ID:
            raise jwt.InvalidTokenError("access token client mismatch")
    else:
        raise jwt.InvalidTokenError("unexpected token_use")
    return claims

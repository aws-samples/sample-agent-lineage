"""Role-based access control on top of Cognito.

Roles come from Cognito user-pool groups (claim `cognito:groups` in the access
token): members of ADMIN_GROUP are admins, everyone else is a viewer.

Viewer account scope comes from the Cognito custom attribute
`custom:allowed_namespaces` — a comma-separated list where each entry is either
a full namespace ("123456789012/us-east-1"), a bare 12-digit account id
(grants every region of that account), or "default" (demo seed data).
Custom attributes are not present in access tokens, so we look them up with
AdminGetUser and cache briefly.

When auth is disabled (local dev), everyone is an unrestricted admin --
matching how authentication itself already behaves.
"""
import os
import threading
import time
from typing import Optional

import boto3
from fastapi import HTTPException, Request

from . import auth

ADMIN_GROUP = os.environ.get("ADMIN_GROUP", "admin")
SES_SENDER = os.environ.get("SES_SENDER", "")
NS_ATTR = "custom:allowed_namespaces"

_CACHE_TTL_SECONDS = 60.0
_user_cache: dict[str, tuple[float, dict]] = {}
_admin_emails_cache: Optional[tuple[float, list[str]]] = None
_cache_lock = threading.Lock()


def _idp():
    return boto3.client("cognito-idp", region_name=auth.REGION)


# ---------- Claims helpers ----------

def groups_of(claims: Optional[dict]) -> list[str]:
    if not claims:
        return []
    groups = claims.get("cognito:groups") or []
    return list(groups) if isinstance(groups, (list, tuple)) else [str(groups)]


def is_admin(claims: Optional[dict]) -> bool:
    if not auth.ENABLED:
        return True  # local dev: auth off, everyone is admin
    return ADMIN_GROUP in groups_of(claims)


def username_of(claims: Optional[dict]) -> str:
    if not claims:
        return "local"
    return str(claims.get("username") or claims.get("cognito:username") or claims.get("sub") or "")


def sub_of(claims: Optional[dict]) -> str:
    return str(claims.get("sub", "local")) if claims else "local"


# ---------- Cognito user attribute lookups (cached) ----------

def _fetch_user_attributes(username: str) -> dict:
    resp = _idp().admin_get_user(UserPoolId=auth.USER_POOL_ID, Username=username)
    return {a["Name"]: a["Value"] for a in resp.get("UserAttributes", [])}


def user_attributes(username: str) -> dict:
    now = time.monotonic()
    with _cache_lock:
        hit = _user_cache.get(username)
        if hit and now - hit[0] < _CACHE_TTL_SECONDS:
            return hit[1]
    attrs = _fetch_user_attributes(username)
    with _cache_lock:
        _user_cache[username] = (now, attrs)
    return attrs


def invalidate_user(username: str) -> None:
    with _cache_lock:
        _user_cache.pop(username, None)


def email_of(claims: Optional[dict]) -> str:
    if not claims:
        return "local@dev"
    if claims.get("email"):
        return str(claims["email"])
    try:
        return user_attributes(username_of(claims)).get("email", "")
    except Exception:
        return ""


# ---------- Namespace scope ----------

def allowed_entries(claims: Optional[dict]) -> Optional[set[str]]:
    """Scope entries for this caller. None means unrestricted (admin/local)."""
    if is_admin(claims):
        return None
    try:
        raw = user_attributes(username_of(claims)).get(NS_ATTR, "")
    except Exception:
        raw = ""  # fail closed: viewer with no resolvable grants sees nothing
    return {e.strip() for e in raw.split(",") if e.strip()}


def ns_allowed(namespace: str, entries: Optional[set[str]]) -> bool:
    """An entry matches a namespace exactly, or by account prefix
    ("123456789012" grants "123456789012/us-east-1", "123456789012/eu-west-1"...)."""
    if entries is None:
        return True
    return namespace in entries or namespace.split("/")[0] in entries


# ---------- FastAPI dependencies ----------

def require_admin(request: Request) -> None:
    if not is_admin(getattr(request.state, "claims", None)):
        raise HTTPException(403, "admin role required")


def scope(request: Request) -> Optional[set[str]]:
    """Dependency: the caller's namespace scope entries (None = unrestricted)."""
    return allowed_entries(getattr(request.state, "claims", None))


def check_ns(namespace: str, entries: Optional[set[str]]) -> None:
    if not ns_allowed(namespace, entries):
        raise HTTPException(403, "namespace not in your access scope")


# ---------- Grants (admin approval writes back to Cognito) ----------

def grant_account(username: str, account_id: str) -> None:
    """Append an account id to the user's custom:allowed_namespaces attribute."""
    if not auth.ENABLED:
        return  # local dev: nothing to write
    current_raw = _fetch_user_attributes(username).get(NS_ATTR, "")
    entries = {e.strip() for e in current_raw.split(",") if e.strip()}
    entries.add(account_id)
    _idp().admin_update_user_attributes(
        UserPoolId=auth.USER_POOL_ID,
        Username=username,
        UserAttributes=[{"Name": NS_ATTR, "Value": ",".join(sorted(entries))}],
    )
    invalidate_user(username)


# ---------- Admin email notification (SES, best-effort) ----------

def admin_emails() -> list[str]:
    global _admin_emails_cache
    if not auth.ENABLED:
        return []
    now = time.monotonic()
    with _cache_lock:
        if _admin_emails_cache and now - _admin_emails_cache[0] < _CACHE_TTL_SECONDS:
            return _admin_emails_cache[1]
    emails: list[str] = []
    paginator = _idp().get_paginator("list_users_in_group")
    for page in paginator.paginate(UserPoolId=auth.USER_POOL_ID, GroupName=ADMIN_GROUP):
        for user in page.get("Users", []):
            attrs = {a["Name"]: a["Value"] for a in user.get("Attributes", [])}
            if attrs.get("email"):
                emails.append(attrs["email"])
    with _cache_lock:
        _admin_emails_cache = (now, emails)
    return emails


def notify_admins(subject: str, body: str) -> bool:
    """Email every member of the admin group. Never raises; returns success."""
    if not SES_SENDER:
        return False
    try:
        recipients = admin_emails()
        if not recipients:
            return False
        boto3.client("ses", region_name=auth.REGION).send_email(
            Source=SES_SENDER,
            Destination={"ToAddresses": recipients},
            Message={
                "Subject": {"Data": subject},
                "Body": {"Text": {"Data": body}},
            },
        )
        return True
    except Exception:
        return False  # notification is best-effort; the request is still stored

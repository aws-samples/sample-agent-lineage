/** Cognito hosted-UI login with PKCE. No-op when the backend reports auth
 *  disabled (local dev). Tokens live in localStorage; api.ts attaches them. */

const TOKEN_KEY = "al_access_token";
const EXPIRY_KEY = "al_token_expiry";
const VERIFIER_KEY = "al_pkce_verifier";

interface AuthConfig {
  enabled: boolean;
  domain: string;
  client_id: string;
  region: string;
}

export function getToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = Number(localStorage.getItem(EXPIRY_KEY) ?? 0);
  if (!token || Date.now() / 1000 > expiry - 60) return null;
  return token;
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}

/** End the session. Clears the local token AND the Cognito hosted-UI
 *  session cookie via the /logout endpoint — without the second step the
 *  hosted UI would silently log the user straight back in. Cognito then
 *  redirects to logout_uri (registered in the client's LogoutURLs), which is
 *  the landing page. */
export async function signOut(): Promise<void> {
  clearToken();
  let cfg: AuthConfig | null = null;
  try {
    cfg = await (await fetch("/api/v1/auth/config")).json();
  } catch {
    /* fall through to a plain reload */
  }
  if (cfg?.enabled) {
    const params = new URLSearchParams({ client_id: cfg.client_id, logout_uri: redirectUri() });
    window.location.assign(`https://${cfg.domain}/logout?${params}`);
    return;
  }
  window.location.assign(redirectUri());
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

function redirectUri(): string {
  return `${window.location.origin}/`;
}

async function redirectToLogin(cfg: AuthConfig): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = await pkceChallenge(verifier);
  const params = new URLSearchParams({
    client_id: cfg.client_id,
    response_type: "code",
    scope: "openid email",
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  window.location.assign(`https://${cfg.domain}/oauth2/authorize?${params}`);
}

async function exchangeCode(cfg: AuthConfig, code: string): Promise<boolean> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) return false;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.client_id,
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  const res = await fetch(`https://${cfg.domain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return false;
  const tokens = (await res.json()) as { access_token: string; expires_in: number };
  localStorage.setItem(TOKEN_KEY, tokens.access_token);
  localStorage.setItem(EXPIRY_KEY, String(Date.now() / 1000 + tokens.expires_in));
  sessionStorage.removeItem(VERIFIER_KEY);
  return true;
}

export type AuthState =
  /** Auth disabled (local dev) or a valid session exists: render the app. */
  | { kind: "ready"; enabled: boolean }
  /** No session: show the landing page; `signIn` starts the hosted-UI flow. */
  | { kind: "signed-out"; signIn: () => Promise<void> }
  /** Backend unreachable: render the app so it can show its error state. */
  | { kind: "unreachable" };

/** Resolve the initial auth state. Completes a PKCE code exchange when the
 *  hosted UI redirected back with ?code=, but never redirects on its own —
 *  the landing page's Sign-in action does that. Credentials are only ever
 *  entered on the Cognito hosted UI. */
export async function initAuth(): Promise<AuthState> {
  let cfg: AuthConfig;
  try {
    cfg = await (await fetch("/api/v1/auth/config")).json();
  } catch {
    return { kind: "unreachable" };
  }
  if (!cfg.enabled) return { kind: "ready", enabled: false };

  const query = new URLSearchParams(window.location.search);
  const code = query.get("code");
  if (code) {
    const ok = await exchangeCode(cfg, code);
    window.history.replaceState({}, "", window.location.pathname);
    if (ok) return { kind: "ready", enabled: true };
  }
  if (getToken()) return { kind: "ready", enabled: true };
  return { kind: "signed-out", signIn: () => redirectToLogin(cfg) };
}

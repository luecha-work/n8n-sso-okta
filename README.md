# n8n Trusted Header SSO hook

This repo contains an external hook for [n8n](https://n8n.io) that trusts an authentication header (for example one set by [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) in front of Okta).
When the header is present and matches an existing n8n user, the hook issues the regular JWT cookie so the native login form is bypassed.

## How it works

- The hook runs as soon as n8n finishes booting (`n8n.ready`).
- It injects a middleware right after the cookie parser in the Express stack.
- Requests to static assets, health checks, webhooks or OAuth credential callbacks are ignored.
- If the forward-auth header is set and matches an invited user, the normal `n8n-auth` cookie is generated via `issueCookie`.
- Errors (missing header, unknown users) fall back to the standard n8n authentication flow.

## Authentication flow

- **oauth2-proxy** performs an OIDC login against Okta and sets the `_oauth2_proxy` cookie scoped to `.localtest.me`.
- **Nginx** terminates TLS, calls oauth2-proxy through `auth_request`, and forwards trusted headers (`Remote-Email`, `Remote-User`, `Remote-Groups`, `Remote-Name`) to n8n.
- **n8n (hook)** reads the trusted header, looks up the user by email, and issues the usual `n8n-auth` cookie so the native login screen is bypassed.

- **Login sequence**
  1. A browser accesses `https://n8n.localtest.me:8443/`; Nginx checks with oauth2-proxy at `/oauth2/auth`.
  2. If the visitor lacks an oauth2-proxy session, they are redirected to `/oauth2/start`, which in turn loads the Okta hosted login.
  3. Okta completes the authentication flow → oauth2-proxy sets `_oauth2_proxy` and redirects back.
  4. Nginx repeats the original request, now including the trusted headers.
  5. The hook matches `Remote-Email` to an n8n user and calls `issueCookie` to set `n8n-auth`.
  6. n8n serves the requested page as that user.

- **Logout sequence**
  - Calling `https://n8n.localtest.me:8443/rest/logout` (triggered by n8n’s “Sign out”) clears both `n8n-auth` and `_oauth2_proxy`, so the next request is forced back through Okta.

- **Multi-user requirement**
  - Every Okta account that needs access must already exist in n8n with the same email. Invite additional users via `Settings → Users → Invite user` or `docker exec n8n n8n user-management:invite --email alice@example.com --role member`.

## Usage

1. Copy `hooks.js` into the directory that is mounted at `/home/node/.n8n/` inside your n8n container.
2. Expose the file to n8n via the environment variable:
   ```bash
   EXTERNAL_HOOK_FILES=/home/node/.n8n/hooks.js
   ```
3. Edit `oauth2-proxy.cfg` with your Okta issuer, client credentials, and cookie secret (use a random 32-character string, e.g. `openssl rand -hex 16`). The sample file contains placeholders you must replace before starting the stack.
4. Tell the hook which header your reverse proxy forwards. With oauth2-proxy this is typically `X-Auth-Request-Email`:
   ```bash
   N8N_FORWARD_AUTH_HEADER=X-Auth-Request-Email
   ```
5. (Recommended) Provide the cookie metadata so the logout middleware can clear the oauth2-proxy session:
   ```bash
   N8N_FORWARD_AUTH_COOKIE_NAME=_oauth2_proxy
   N8N_FORWARD_AUTH_COOKIE_DOMAIN=localtest.me
   ```
6. Ensure that oauth2-proxy protects the n8n endpoint and forwards the header only for authenticated users.
7. Invite the same users in n8n (email must match exactly). The hook will refuse unknown users with HTTP 401.
8. Re-create or restart your n8n container so the hook is loaded.

## Version compatibility

- Works with n8n `>= 1.87.0` (uses `app.router`).
- Falls back to `app._router` for older `1.x` builds that still exposed Express directly.
- Automatically tries both `router/lib/layer` and `express/lib/router/layer` so you can reuse a single file across versions.

## Safety notes

- Do **not** expose n8n directly to the internet when this hook is enabled. Any client that can spoof the trusted header would be able to log in as any user.
- Keep oauth2-proxy (or your chosen IdP) in front of n8n and restrict network access accordingly.

## Troubleshooting

- Set `LOG_LEVEL=debug` in n8n to observe hook registration messages.
- Use a reverse proxy trace (e.g. `curl -v`) to confirm that the trusted header reaches n8n.
- Check `Settings → Users` in n8n to ensure the target email exists and has a role assigned; the hook adds an empty role object if missing.

## Local all-in-one stack (n8n + oauth2-proxy + Okta + Nginx)

The repository ships with a `docker-compose.yml` that boots a complete demo environment on `https://n8n.localtest.me:8443` (a wildcard DNS entry that always resolves to `127.0.0.1`):

1. In Okta, create an OIDC Web application and record the **client ID** and **client secret**. Set the login redirect URI to `https://n8n.localtest.me:8443/oauth2/callback` and allow the scopes `openid`, `email`, and `profile`.
2. (Optional, recommended) Replace the placeholder secrets in `docker-compose.yml`: `N8N_ENCRYPTION_KEY` and Postgres credentials (`DB_POSTGRESDB_*`, `POSTGRES_*`).
3. Update `oauth2-proxy.cfg` with the issuer URL, client ID, client secret, and a random 32-character cookie secret (for example, run `openssl rand -hex 16`).
4. Start the stack:
   ```bash
   docker compose pull
   docker compose up -d
   ```
5. Browse to `https://n8n.localtest.me:8443` (accept the self-signed certificate warning). You’ll be redirected through `/oauth2/start` to Okta. After signing in, oauth2-proxy will forward the trusted header and the hook issues the n8n session cookie.
6. During n8n’s onboarding flow, set the instance owner email to the same Okta account used for login. Subsequent visits to the HTTPS URL will log in automatically.
7. Stop the environment when finished:
   ```bash
   docker compose down
   ```

> **Note:** For production make sure oauth2-proxy (and Okta) terminate TLS appropriately, restrict public access, and rotate all placeholder secrets.

# n8n Trusted Header SSO hook

This repo contains an external hook for [n8n](https://n8n.io) that trusts an authentication header (for example one set by [Authelia](https://www.authelia.com/)).
When the header is present and matches an existing n8n user, the hook issues the regular JWT cookie so the native login form is bypassed.

## How it works

- The hook runs as soon as n8n finishes booting (`n8n.ready`).
- It injects a middleware right after the cookie parser in the Express stack.
- Requests to static assets, health checks, webhooks or OAuth credential callbacks are ignored.
- If the forward-auth header is set and matches an invited user, the normal `n8n-auth` cookie is generated via `issueCookie`.
- Errors (missing header, unknown users) fall back to the standard n8n authentication flow.

## Authentication flow

- **Authelia** verifies credentials and sets the `authelia_session` cookie scoped to `*.localtest.me`.
- **Nginx** terminates TLS, calls Authelia through `auth_request`, and forwards the trusted headers (`Remote-Email`, `Remote-User`, `Remote-Groups`, `Remote-Name`) to n8n.
- **n8n (hook)** reads the trusted header, looks up the user by email, and issues the usual `n8n-auth` cookie so the native login screen is bypassed.

- **Login sequence**
  1. A browser accesses `https://n8n.localtest.me:8443/`; Nginx checks with Authelia.
  2. If the visitor lacks an Authelia session, Authelia redirects to `/authelia/` for first-factor authentication.
  3. `POST /api/firstfactor` succeeds → Authelia sets `authelia_session` and redirects back.
  4. Nginx repeats the original request, now including the trusted headers.
  5. The hook matches `Remote-Email` to an n8n user and calls `issueCookie` to set `n8n-auth`.
  6. n8n serves the requested page as that user.

- **Logout sequence**
  - Calling `https://n8n.localtest.me:8443/rest/logout` (triggered by n8n’s “Sign out”) clears both `n8n-auth` and `authelia_session`, so the next request is forced back through Authelia.

- **Multi-user requirement**
  - Every Authelia account must exist in n8n with the same email. Invite additional users via `Settings → Users → Invite user` or `docker exec n8n n8n user-management:invite --email alice@example.com --role member`.

## Usage

1. Copy `hooks.js` into the directory that is mounted at `/home/node/.n8n/` inside your n8n container.
2. Expose the file to n8n via the environment variable:
   ```bash
   EXTERNAL_HOOK_FILES=/home/node/.n8n/hooks.js
   ```
3. Tell the hook which header your reverse proxy forwards. With Authelia this is typically `Remote-Email`:
   ```bash
   N8N_FORWARD_AUTH_HEADER=Remote-Email
   ```
4. Ensure that Authelia protects the n8n endpoint and forwards the header only for authenticated users.
5. Invite the same users in n8n (email must match exactly). The hook will refuse unknown users with HTTP 401.
6. Re-create or restart your n8n container so the hook is loaded.

## Version compatibility

- Works with n8n `>= 1.87.0` (uses `app.router`).
- Falls back to `app._router` for older `1.x` builds that still exposed Express directly.
- Automatically tries both `router/lib/layer` and `express/lib/router/layer` so you can reuse a single file across versions.

## Safety notes

- Do **not** expose n8n directly to the internet when this hook is enabled. Any client that can spoof the trusted header would be able to log in as any user.
- Keep Authelia (or your chosen IdP) in front of n8n and restrict network access accordingly.

## Troubleshooting

- Set `LOG_LEVEL=debug` in n8n to observe hook registration messages.
- Use a reverse proxy trace (e.g. `curl -v`) to confirm that the trusted header reaches n8n.
- Check `Settings → Users` in n8n to ensure the target email exists and has a role assigned; the hook adds an empty role object if missing.

## Local all-in-one stack (n8n + Authelia + Nginx)

The repository ships with a `docker-compose.yml` that boots a complete demo environment on `https://n8n.localtest.me:8443` (a wildcard DNS entry that always resolves to `127.0.0.1`):

1. Create or adjust the users in `authelia/users_database.yml`. The sample user is `admin` with the password `authelia` and the email `owner@example.com`.
2. (Optional, recommended) Replace the placeholder secrets in:
   - `docker-compose.yml`: `N8N_ENCRYPTION_KEY`, `AUTHELIA_COOKIE_DOMAIN`, Postgres credentials (`DB_POSTGRESDB_*`, `POSTGRES_*`)
   - `authelia/configuration.yml`: `identity_validation.reset_password.jwt_secret`, `session.secret`, `storage.encryption_key`
3. Start the stack:
   ```bash
   docker compose pull
   docker compose up -d
   ```
4. Browse to `https://n8n.localtest.me:8443` (accept the self-signed certificate warning). You’ll be redirected to Authelia at `/authelia/`; sign in with `admin` / `authelia`. Authelia then forwards the trusted header and the hook issues the n8n session cookie.
5. During n8n’s onboarding flow, set the instance owner email to `owner@example.com`. Subsequent visits to the HTTPS URL will log in automatically. When you click the built-in n8n “Sign out” action, the hook also clears the `authelia_session` cookie so both sessions end together.
6. Stop the environment when finished:
   ```bash
   docker compose down
   ```

> **Note:** For production make sure Authelia and the reverse proxy terminate TLS, restrict public access, and rotate all of the placeholder secrets.

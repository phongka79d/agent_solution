# Live-provider suite

The live suite uses real LLM credentials and the local Compose demo stack. It is limited to synthetic NovaMart data and a dedicated PostgreSQL database whose name contains `live` or `test`. Never point it at a production database, production tenant, or the ordinary demo database.

## Prepare `.env`

Copy `.env.example` to an untracked `.env`, then replace every placeholder. Keep the normal Compose secrets and demo credentials in that file; never pass credential values on command lines.

The live preflight requires:

- `APP_ENV=local`, `DEMO_MODE=true`, `DEMO_PROVIDER_MODE=live`, and the seeded NovaMart `DEMO_TENANT_ID` (`99999999-9999-4999-8999-999999999999`).
- `DATABASE_URL` for a dedicated live/test database on a loopback PostgreSQL host. Its `agentos_app` password must match `APP_ROLE_PASSWORD`, and `POSTGRES_DB` / `POSTGRES_PORT` must match that URL.
- Loopback HTTP origins in `API_BASE_URL` and `WEB_BASE_URL`.
- `DEMO_COMPANY_ADMIN_EMAIL`, `DEMO_COMPANY_ADMIN_PASSWORD`, `DEMO_PLATFORM_ADMIN_EMAIL`, and `DEMO_PLATFORM_ADMIN_PASSWORD`.
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `PRIMARY_REASONING_MODEL`, a positive `LIVE_MAX_LLM_CALLS`, and `LIVE_ALLOWED_LLM_HOSTS` (comma-separated exact provider hosts, including a non-default port).

Use a dedicated low-limit provider key. Preflight refuses placeholders, non-local app profiles, remote or non-isolated databases, remote API/UI origins, invalid call limits, and provider hosts not explicitly allowlisted; it requires HTTPS for non-loopback provider URLs. It reports variable names only, never values.

## Run locally

From the repository root, run these commands in order:

```sh
pnpm live:preflight
pnpm live:up
pnpm test:live
pnpm live:scan
pnpm live:reset
pnpm demo:down
```

`live:up` preflights again before starting the `live` profile. `test:live` preflights before requests, runs the serial API scenarios, then starts Playwright; its global setup preflights again before API-authenticating the company user. API scenarios cover a completed Sales intent turn, a Care answer matching the approved 14-day unopened-return FAQ, a campaign draft that reaches `awaiting_human`, and usage increments in `/platform/usage`. The browser scenarios exercise the company Try assistant and approve a real-provider campaign draft.

Playwright uses `test-results/live/`, writes API-authenticated storage state there with mode `0600`, captures screenshots only on failure, and keeps traces, video, and HAR disabled. `live:scan` checks every file under that directory against secrets from `.env`; it reports matching paths without printing secret values.

`live:reset` is an explicit cleanup for TEST-class customer data only. It refuses a non-local profile, a non-loopback API, a login bound to another tenant, and any tenant whose API data class is `PRODUCTION`; it obtains a fresh dry-run token and confirms through `/testing/reset`. It does not delete DEMO seed rows, campaigns, runs, usage, or production data.

## GitHub Actions

The manually dispatched `.github/workflows/live-e2e.yml` uses the protected `live` environment. Configure `LIVE_DATABASE_URL`, `LIVE_DEMO_TENANT_ID`, `LIVE_DEMO_COMPANY_ADMIN_EMAIL`, `LIVE_DEMO_COMPANY_ADMIN_PASSWORD`, `LIVE_DEMO_PLATFORM_ADMIN_EMAIL`, `LIVE_DEMO_PLATFORM_ADMIN_PASSWORD`, `LIVE_OPENAI_API_KEY`, `LIVE_OPENAI_BASE_URL`, `LIVE_PRIMARY_REASONING_MODEL`, `LIVE_MAX_LLM_CALLS`, and `LIVE_ALLOWED_LLM_HOSTS` as protected secrets.

`LIVE_DATABASE_URL` must be a loopback PostgreSQL URL for an isolated `live`/`test` database, use the `agentos_app` user, and have a URL-safe password of at least 16 characters. The workflow uses that database name, port, and app-role password to provision its isolated Compose database. Set the NovaMart demo tenant ID above. The workflow masks every value, writes a mode-`0600` environment file under the runner temp directory with `umask 077`, runs preflight → `demo:up -- --env-file "$LIVE_ENV_FILE" --profile live` → `test:live` → `live:scan`, tears down only its uniquely named Compose project, and removes the environment file in an `always()` step. It grants read-only repository permissions and is not triggered on forks or pull requests.

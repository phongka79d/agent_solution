# Authentication operations

M2 demo authentication is account-based and audience-bound. It is a local/CI demonstration
boundary, not a production identity system.

## Permission bundles

The API keeps the internal bundles below:

| Bundle | Permissions |
| --- | --- |
| Tenant operator bundle | `campaign:draft`, `conversation:takeover`, `customer:read`, `run:read`, `telemetry:read` |
| Approver bundle | `approval:read`, `approval:decide`, `run:read` |
| Platform bundle | `platform:admin`, `run:read`, `run:retry`, `run:reconcile`, `telemetry:read` |

`company_admin` is the union of the first two bundles, exactly seven permissions:
`campaign:draft`, `conversation:takeover`, `customer:read`, `run:read`, `telemetry:read`,
`approval:read`, and `approval:decide`. The company account uses `audience=company` and has
`scope=company`. The platform account uses `audience=platform` and has `scope=platform`.

## Environment migration

The old split role-password setup is replaced by two explicit account identities. The platform
password variable remains, and its email variable is now required as well. The two console
framework secrets are separate and are not cookie-signing keys.

| Previous configuration | Replacement |
| --- | --- |
| Separate tenant-operator password | `DEMO_COMPANY_ADMIN_EMAIL` + `DEMO_COMPANY_ADMIN_PASSWORD` |
| Separate marketing-approver password | `DEMO_COMPANY_ADMIN_EMAIL` + `DEMO_COMPANY_ADMIN_PASSWORD` |
| Platform password without an explicit email | `DEMO_PLATFORM_ADMIN_EMAIL` + `DEMO_PLATFORM_ADMIN_PASSWORD` |
| One shared console cookie signing key | `TENANT_COOKIE_HMAC_KEY` and `PLATFORM_COOKIE_HMAC_KEY` |

With `DEMO_MODE=true`, the API requires all four account variables. If legacy role-password
configuration is present while the new account variables are missing, boot fails closed with an
error beginning:

```text
DEMO_AUTH_ENV_MIGRATION_REQUIRED: DEMO_COMPANY_ADMIN_EMAIL, DEMO_COMPANY_ADMIN_PASSWORD, DEMO_PLATFORM_ADMIN_EMAIL, DEMO_PLATFORM_ADMIN_PASSWORD are required
```

Emails are trimmed and compared case-insensitively. Unknown email, wrong password, and audience
mismatch return the same generic authentication failure; no secret is logged or returned.

## BFF cookies and upstream responses

The tenant and platform BFFs use separate keys and cookie names:

- `TENANT_COOKIE_HMAC_KEY` signs `agentos_tenant_session`.
- `PLATFORM_COOKIE_HMAC_KEY` signs `agentos_platform_session`.

Each cookie key is required only when `DEMO_MODE=true` and must contain at least 32 bytes.
`TENANT_NEXTAUTH_SECRET` supplies the tenant console's `NEXTAUTH_SECRET`, while
`PLATFORM_NEXTAUTH_SECRET` supplies the platform console's `NEXTAUTH_SECRET`; keep both
framework secrets separate from both cookie HMAC keys. The API uses its dedicated `SESSION_SECRET`
for signed session tokens; `JWT_SECRET` is never used as a session-signing fallback.

Cookie values use versioned format:

```text
v1.<sessionId>.<expEpochSec>.<hmac>
```

The HMAC is HMAC-SHA256 over `v1.<sessionId>.<expEpochSec>`, encoded as base64url and verified
with a timing-safe comparison. Cookies are HttpOnly, `SameSite=Lax`, `Path=/`, and `Secure` on
HTTPS. The existing double-submit CSRF cookie and `x-csrf-token` header remain required for
mutating browser requests.

BFF handling of the upstream API is deliberately asymmetric:

- Upstream **401** destroys the BFF session, clears its cookies, and returns `401` with
  `{ "reason": "expired" }`.
- Upstream **403** passes through as forbidden and keeps the BFF session. A valid session does
  not become logged out merely because it lacks a permission.

## Platform scope and database role

The platform account must authenticate with `audience=platform`, `scope=platform`, and
`platform:admin`; a company-scoped principal cannot use platform control-plane routes. Migration
`0016_platform_directory.sql` creates the `agentos_platform` database role as `NOLOGIN
NOBYPASSRLS` and grants it non-inheriting membership for explicit transaction-local platform
projections. Migration `0017_restrict_tenant_shell_provisioning.sql` revokes tenant application
and public execute access to tenant-shell provisioning functions and grants it only to
`agentos_platform`; provisioning therefore requires the platform scope and role.


## Governance setting D2

`require_distinct_approver` defaults to `false` in the tenant governance settings table. The UI
may display the setting but is read-only in this pass; it must not offer a client-side toggle.
Seed or operations SQL is the authority for changing it. When enabled, the API refuses a decision
by the same operator who drafted the run with `403 APPROVER_MUST_DIFFER`. The comparison is made
against the run's recorded drafter, and a missing setting row is treated as disabled. A settings
lookup failure fails closed rather than approving the action.

## What demo auth is not

- It is **not** production identity, federation, MFA, account recovery, or a directory.
- Sessions are **in-memory** and are intentionally unsuitable for horizontal production use.
- It is available only for `APP_ENV=local|ci` with `DEMO_MODE=true`; production deployments must
  use a real identity provider and production session infrastructure.

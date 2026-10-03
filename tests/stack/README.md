# Real-stack tests

Run the isolated offline stack suite from the repository root with `pnpm test:stack`. It requires Docker with Compose v2.24 or later and builds the API, worker, and mock ERP images.

The setup uses Compose project `agentos_stacktest`, separate named volumes, and loopback-only host ports: API `14000`, mock ERP `18081`, PostgreSQL `15433`, Redis `16379`, and Qdrant `16333`/`16334`. The ordinary stack suite excludes the consoles. PostgreSQL runs its checked-in init scripts, migrations run using the bootstrap `postgres` role, and API/worker use `agentos_app`. Demo data is seeded in `APP_ENV=ci` with the offline provider; the host LLM stub is exposed to containers as `host.docker.internal`.

Use `pnpm test:stack:db` to run the suite with `AUTH_PROVIDER=db`; its Node runner sets `STACK_AUTH_PROVIDER=db` portably on Windows and POSIX. The default remains `demo`. Global setup bootstraps a platform admin, then creates the NovaMart company admin and second company admin through the existing invitation and acceptance routes with fresh credentials each run. The DB-mode login helper reads these credentials from the private state file. Invitation links are written by the local/CI-only `EMAIL_TRANSPORT=file` transport to `tests/stack/.state/outbox`; keep that ignored directory private because it contains single-use credentials.

`pnpm test:ui:stack` opts in to the tenant and platform consoles on loopback ports `13000` and `13001`. The ordinary `pnpm test:stack` command continues to exclude them.

Global setup writes `.state/stack.json` for test helpers. It contains the local bootstrap database URL and, in DB-auth mode, generated login credentials; the file is ignored by Git and must not be shared. `readStackState()` in `lib/stack.mjs` loads it. Demo-auth tests use the seeded, verified and unverified NovaMart chat personas; DB-auth widget helpers provision per-persona TEST customers through Test Customer Lab.

Global teardown removes only the `agentos_stacktest` Compose project and its volumes. Set `STACK_KEEP=1` to retain those Docker services and volumes for debugging; the in-process LLM stub is still closed when the test runner exits.

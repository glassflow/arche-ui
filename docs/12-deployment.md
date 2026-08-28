# Deployment

> **Extracted / proven — deployment profile: k8s-helm.** The *image* half of
> this doc (three-stage Dockerfile, one image for every environment,
> `startup.sh` runtime env injection per [doc 01](./01-runtime-env-injection.md))
> applies to any container host. The *orchestration* half (Helm chart,
> ConfigMap checksum rollouts, init-container migrations, GHCR promotion flow)
> assumes Kubernetes at fleet scale. Simpler projects keep the image half and
> take orchestration from a lighter recipe — see the profile note in the
> [README](../README.md).

## What & why

The app ships as exactly one container image, and that same image runs
unmodified in local Docker Compose, every PR preview, staging, and
production. Nothing about "which environment is this" gets decided at build
time — it's decided at container start, by whatever environment variables the
orchestrator injects. That's the entire reason [runtime env
injection](./01-runtime-env-injection.md) exists: a build step that froze
per-environment values into the bundle would force a rebuild for every
promotion, and a rebuild means a new image, a new set of test runs, and a new
window where staging and production aren't running provably-identical code.

The build/test/publish pipeline mirrors that one-image principle. CI builds
one multi-arch image per push — to a PR, to `main`, or to a version tag — runs
the test suite against it, and publishes it to a single registry path
(`ghcr.io/glassflow/glassflow-etl-ui`) under a tag that encodes where it came
from. The image that passes review on a PR is bit-for-bit the same image
(same layers, same digest per architecture) that gets re-tagged `main` and
later `stable` — promotion is a tag operation, not a rebuild.

Kubernetes deployment (via the Helm chart) closes the loop: it supplies the
runtime env vars the image expects, runs a one-shot migration container
before the app container starts, and mounts everything through a ConfigMap so
that changing a deployed value is a `helm upgrade`, not a new image.

## The shape

**Image — three-stage Dockerfile, `node:22-alpine` throughout:**

```
deps      → installs dependencies only (pnpm, frozen lockfile)
              cached separately from source; invalidated only by
              package.json / pnpm-lock.yaml changes
    │
    ▼
builder   → copies deps' node_modules + full source, runs `pnpm run build`
              with Next.js standalone output:
                .next/standalone/  — traced server + only the deps it needs
                .next/static/      — static assets (copied separately)
                public/            — static public assets
              also hand-copies `postgres` and `drizzle-orm` into
              .next/standalone/node_modules — @vercel/nft's dependency
              tracer misses packages reached only through a dynamic
              require() or only used by migrate.js, which lives outside
              the Next.js build graph entirely
    │
    ▼
runner    → node:22-alpine + non-root `nextjs` user (uid 1001, gid 1001)
              copies in: standalone output, static assets, public/,
              DB migration SQL, migrate.js, startup.sh
              chgrp -R 0 + chmod -R g=u on public/ and .next/server/app —
              OpenShift's restricted-v2 SCC runs the container as an
              arbitrary high UID with GID 0, not as uid 1001, so the
              paths startup.sh writes to at boot must be group-writable
              USER 1001   (numeric, so OpenShift's runAsNonRoot check
                            can verify it without resolving a username)
              CMD ["/app/startup.sh"]
```

Only three `NEXT_PUBLIC_*` vars are ever baked in as build `ARG`s
(`NEXT_PUBLIC_PROFILE_ROUTE`, `NEXT_PUBLIC_AUTH0_ENABLED`,
`NEXT_PUBLIC_FILTERS_ENABLED`) — feature flags and a fixed route path that
are the same in every deployment of a given build. Everything that varies
per environment, including `NEXT_PUBLIC_API_URL`, is deliberately left unset
at build time. See [Rules & gotchas](#rules--gotchas).

**Entrypoint — `startup.sh`, the container's `CMD`:**

```
Container boots → startup.sh runs (before the Next.js server does)
    │
    ├─ exports every runtime var with a shell default: ${VAR:-default}
    ├─ derives NEXT_PUBLIC_AUTH0_ENABLED from AUTH0_ENABLED (single
    │    source of truth — client and server auth state can't disagree)
    ├─ writes public/env.js   → window.__ENV__ = { NEXT_PUBLIC_*: "..." }
    ├─ writes .next/server/app/{api,ui-api}/config.js → runtimeConfig
    │    (server-side twin: apiUrl, previewMode, analyticsEnabled)
    └─ exec node server.js   → hands off to the standalone server
```

**Migration — `migrate.js`, a standalone Node script (no Next.js runtime):**

Run only as a Kubernetes init container, before the `ui` container starts.
Reads `DATABASE_URL`, creates the `ui_library` schema if missing, and runs
Drizzle migrations from `src/lib/db/migrations`. Exits `0` immediately (no
error) if `DATABASE_URL` is unset — migration is opt-in per deployment.

**CI — GitHub Actions call graph:**

```
pull_request.yaml  (PR opened/synced)  ─┐
main.yaml          (push to main)      ─┴─► test.yaml (reusable: lint + pnpm test:run)
                                                    │  needs: test
                                                    ▼
tag.yaml           (push tag v*)      ────────► build_image.yaml (reusable, workflow_call)
                                                   ├─ matrix: linux/amd64, linux/arm64
                                                   │    each: buildx build, push-by-digest
                                                   │    to ghcr.io/glassflow/glassflow-etl-ui
                                                   ├─ merge job: docker buildx imagetools create
                                                   │    → one multi-arch manifest per tag rule
                                                   └─ tag.yaml also creates a GitHub Release
                                                        after the image is published
```

Each caller passes its own `tags` input to `build_image.yaml` — PRs get
`rc-PR-<number>`, `main` gets `main`, a version tag gets the tag name plus
`stable`. Every tag rule also gets a `sha-<short-sha>` tag, so any build is
addressable by commit regardless of which branch triggered it. `tag.yaml`
skips the `test` job — a tag is only pushed after a commit has already gone
through `main.yaml`'s test gate, so re-running it would just re-verify a
commit that's already green.

**Kubernetes — Helm chart (`glassflow-etl` in `charts-ee`):**

```
values.yaml (ui.* block)
    │  helm template / helm upgrade
    ▼
templates/ui-configmap.yaml   → ConfigMap "glassflow-ui-config"
    │  data: HOSTNAME, NEXT_PUBLIC_API_URL, NEXT_PUBLIC_AUTH0_ENABLED, ...
    │        (also plaintext AUTH0_SECRET / AUTH0_CLIENT_SECRET — see gotchas)
    ▼
templates/deployment.yaml
    ├─ initContainer "run-ui-migration": same image, command
    │    ["node", "/app/migrate.js"], env: DATABASE_URL from a Secret
    │    (postgresql.enabled subchart, a direct URL, or an external Secret ref)
    └─ container "ui": envFrom: configMapRef: glassflow-ui-config
         + explicit env: entries from ui.env and DATABASE_URL
```

The Deployment template sha256-sums the rendered ConfigMap into a pod
annotation (`checksum/ui-config`), so a `helm upgrade` that only changes a
ConfigMap value still rolls the pods — without that checksum, Kubernetes
wouldn't see any Deployment spec change and would leave stale pods running
with the old ConfigMap mounted.

## Build it

Worked example: the telemetry/OTLP ingest URL, end-to-end from a Helm value
to a value the browser can read. In this codebase's lineage the same wiring
carries `NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT`; treat it as the concrete
precedent for wiring up this pack's `NEXT_PUBLIC_TELEMETRY_INGEST_URL` (see
[runtime env injection](./01-runtime-env-injection.md) for the client-read
half of this same var).

1. **Helm value.** Nothing needs to be set in `values.yaml` for this one — the
   chart derives the URL from the release's own otel-collector Service rather
   than taking it as a user-supplied value:

   ```yaml
   # templates/ui-configmap.yaml
   NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT: >-
     http://{{ .Release.Name }}-otel-collector.{{ .Release.Namespace }}.svc.cluster.local:4318
   ```

   A value that *should* be user-overridable (say, an external SaaS ingest
   endpoint instead of the in-cluster collector) would instead read from
   `.Values.ui.telemetry.ingestUrl` with a default pointing at the in-cluster
   Service — the pattern to copy is `NEXT_PUBLIC_API_URL`'s sibling entries in
   the same ConfigMap, not this one, if the new app needs the override path.

2. **ConfigMap.** `helm template`/`helm upgrade` renders that into the
   `glassflow-ui-config` ConfigMap's `data` map — a plain key-value pair, one
   entry among ~20 others in the same object.

3. **Pod env.** `templates/deployment.yaml`'s `ui` container mounts the whole
   ConfigMap in one shot:

   ```yaml
   envFrom:
     - configMapRef:
         name: glassflow-ui-config
   ```

   Every key in the ConfigMap becomes an env var in the container — no
   per-var wiring needed in the Deployment template itself.

4. **`startup.sh`'s env-gen step.** At container boot, before `node
   server.js` runs, the entrypoint exports the var with a local-dev default
   and writes it into `public/env.js`:

   ```sh
   export NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT=${NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}
   ...
   echo "  NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT: \"$NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT\"," >> /app/public/env.js
   ```

5. **Browser.** The root layout loads `/env.js` with `<Script
   strategy="beforeInteractive">` before hydration, populating
   `window.__ENV__`. Client code reads it exclusively through
   `getRuntimeEnv()`, never `window.__ENV__` or `process.env` directly — see
   [runtime env injection](./01-runtime-env-injection.md) for that helper and
   why the read order (`window.__ENV__` → `process.env` → hardcoded default)
   matters.

6. **Server config, if a route handler also needs it.** `startup.sh` writes
   the same style of value into `.next/server/app/{api,ui-api}/config.js` as
   `runtimeConfig.apiUrl` for the `API_URL` case; a telemetry-ingest server
   route would follow the same non-prefixed-twin pattern
   (`OTEL_EXPORTER_OTLP_ENDPOINT`, no `NEXT_PUBLIC_` prefix) rather than
   reading the `NEXT_PUBLIC_*` var server-side.

That's the full vertical slice for one var: Helm template expression → Helm
release's ConfigMap → `envFrom` on the pod → `startup.sh` export + `env.js`
line → `getRuntimeEnv()` on the client (and, if needed, a non-prefixed twin
read straight from `process.env` on the server).

## Rules & gotchas

- **The `NEXT_PUBLIC_*` build-time inlining trap is the whole reason this
  runtime split exists.** `next build` inlines every `NEXT_PUBLIC_*` value it
  can see into the compiled JS bundle at build time. Bake a per-deploy value
  in as a Dockerfile `ARG`/`ENV` at the builder stage, and the value is frozen
  in that image forever — a Kubernetes ConfigMap or Secret set on the running
  container has zero effect on it, because the bundle never reads
  `process.env` again after the build finishes. This Dockerfile only bakes
  three `NEXT_PUBLIC_*` ARGs (`NEXT_PUBLIC_PROFILE_ROUTE`,
  `NEXT_PUBLIC_AUTH0_ENABLED`, `NEXT_PUBLIC_FILTERS_ENABLED`) — pick build-time
  ARGs the same way: only values that are genuinely identical across every
  deployment of a given image, never anything an operator might reasonably
  want to change without rebuilding. Everything else, especially any ingest
  URL or API endpoint, stays unset at build time and gets its real value from
  `startup.sh` at boot. Full mechanism and the client-side read path:
  [`./01-runtime-env-injection.md`](./01-runtime-env-injection.md).
- **Secrets belong in Kubernetes Secrets, not the ConfigMap — the sample
  chart doesn't fully follow its own advice.** `templates/ui-configmap.yaml`
  writes `AUTH0_SECRET` and `AUTH0_CLIENT_SECRET` straight from
  `values.yaml` plaintext strings into a ConfigMap, which is not encrypted at
  rest by default and is readable by anyone with `get configmap` RBAC in the
  namespace. `DATABASE_URL`, by contrast, gets it right — it's wired as a
  `secretKeyRef` against either the bundled `postgresql` subchart's Secret or
  an operator-supplied Secret name. Treat the `DATABASE_URL` wiring as the
  template to copy for any credential this pack introduces, and don't
  reproduce the Auth0 pattern. For a new deployment, prefer a sealed-secrets
  or external-secrets operator (External Secrets Operator, Sealed Secrets,
  or the cloud provider's native secret sync) over checking plaintext into
  `values.yaml` at all — even a `values.yaml` that never gets committed to
  git is still one `helm get values` away from leaking the secret to anyone
  with cluster read access.
- **`startup.sh` runs on every container start, not just the first.** A pod
  restart, a rolling update, a crash loop — every one of them re-runs
  `startup.sh` and regenerates `env.js` and the server config files from
  whatever env the orchestrator currently injects. If a ConfigMap value
  changed but the running pods weren't restarted, they're still serving the
  old `env.js` — this is exactly why the Deployment template's
  `checksum/ui-config` pod annotation exists: it forces a rollout whenever
  the ConfigMap's rendered content changes, even though nothing in the
  container image or the Deployment spec's own fields changed.
- **The migration init container uses the exact same image as the app
  container**, just with a different `command`. Don't stand up a separate
  "migrator" image — one image, two roles (`node server.js` vs. `node
  /app/migrate.js`), keeps the migration logic guaranteed to match the
  schema the running app expects, since they're literally the same build.
- **`@vercel/nft`'s dependency tracer misses anything reached only through a
  dynamic `require()` or only used outside the Next.js build graph.** The
  builder stage's explicit `cp -rL node_modules/postgres` /
  `drizzle-orm` step exists because `migrate.js` needs both packages and
  Next.js's tracer never sees `migrate.js` at all (it isn't imported from any
  route or page). If a future standalone script needs a package the app
  itself doesn't import, add the same explicit copy — don't assume the
  standalone build's `node_modules` is complete.
- **Numeric `USER 1001`, not a username, and `chgrp -R 0` / `chmod -R g=u` on
  every path `startup.sh` writes.** OpenShift's `restricted-v2` SCC assigns
  an arbitrary high UID at runtime (not the image's build-time `nextjs` uid)
  but keeps GID 0, and its `runAsNonRoot` check inspects the numeric UID, not
  `/etc/passwd`. Skipping either — using a username in `USER`, or missing a
  path `startup.sh` writes to from the `chgrp`/`chmod` pass — reproduces as a
  permission-denied crash loop only on OpenShift, not on vanilla Kubernetes,
  which makes it easy to miss in a non-OpenShift dev cluster.

## Source lineage

- glassflow-etl-ui/Dockerfile
- glassflow-etl-ui/startup.sh
- glassflow-etl-ui/migrate.js
- glassflow-etl-ui/.github/workflows/test.yaml
- glassflow-etl-ui/.github/workflows/pull_request.yaml
- glassflow-etl-ui/.github/workflows/main.yaml
- glassflow-etl-ui/.github/workflows/tag.yaml
- glassflow-etl-ui/.github/workflows/build_image.yaml
- charts-ee/charts/glassflow-etl/Chart.yaml
- charts-ee/charts/glassflow-etl/values.yaml
- charts-ee/charts/glassflow-etl/templates/deployment.yaml
- charts-ee/charts/glassflow-etl/templates/ui-configmap.yaml

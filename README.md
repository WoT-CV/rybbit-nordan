<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/rybbit/horizontal_white.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/public/rybbit/horizontal_black.svg">
    <img src="docs/public/rybbit/horizontal_black.svg" height="70" alt="Rybbit">
  </picture>
    <p align="center">Open Source Web & Product Analytics</p>

<p align="center">
    <a href="https://rybbit.com" target="_blank">Website</a> |
    <a href="https://demo.rybbit.com/81" target="_blank">Demo</a> |
    <a href="https://rybbit.com/docs" target="_blank">Documentation</a> |
    <a href="https://discord.gg/DEhGb4hYBj" target="_blank">Discord</a> |
    <a href="https://github.com/rybbit-io/rybbit?tab=AGPL-3.0-1-ov-file" target="_blank">License (AGPL-3)</a> |
    <a href="https://github.com/rybbit-io/rybbit/blob/master/CONTRIBUTE.md" target="_blank">Contribute</a>
</p>

<a href="https://rybbit.com/" target="_blank">Rybbit</a> is the modern open source and privacy friendly alternative to Google Analytics. It takes only a couple minutes to setup and is super intuitive to use.

<p align="center">
  <a href="https://www.producthunt.com/products/rybbit?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_source=badge-rybbit" target="_blank">
    <img src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1028220&theme=standard&period=daily" alt="Rybbit - Open Source Google Analytics Replacement | Product Hunt" width="250" height="54" />
  </a>
</p>

<p align="center">
  <strong><a href="https://demo.rybbit.com/81">🔍 View Live Demo</a></strong> - See Rybbit running on a real-life production site.
</p>

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 25 20 PM" src="https://github.com/user-attachments/assets/7988ba04-64ee-4410-9972-847d278efa2f" />

<hr>

## 🚀 Getting Started

There are two ways to start using Rybbit:

| Option                                                   | Description                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| **[Hosted Service](https://rybbit.com)**                 | The fastest way to get started                                |
| **[Self-Hosting](https://rybbit.com/docs/self-hosting)** | Deploy and manage Rybbit on your own VPS for complete control |

📚 Explore our [documentation](https://rybbit.com/docs) to learn more about installation, configuration, and usage.

To work on the client and backend locally, see the [pnpm workspace setup](CONTRIBUTE.md#local-development).

## WoT-CV fork

This repository is the [WoT-CV fork of Rybbit](https://github.com/WoT-CV/rybbit-wotcv).
It retains the upstream applications and adds integration between activity in
[wot-cv-fe](https://github.com/WoT-CV/wot-cv-fe), native session replay, and
observability for [wot-cv-be](https://github.com/WoT-CV/wot-cv-be).
The feature list and screenshots below describe Rybbit; available features also
depend on the deployment configuration.

The application is a pnpm workspace: `client/` is the Next.js dashboard,
`server/` is the Fastify API and browser tracker, and `shared/` contains shared
contracts. PostgreSQL stores application and authentication data; in self-hosted
mode, ClickHouse stores analytics and recordings, and Redis supports session
tracking and shared caches. The documentation site in `docs/` and the React Native SDK in
`react-native/` have separate tooling.

| WoT-CV integration | Source |
| --- | --- |
| Observe response metadata from allowed API origins during replay, including method, path, status, duration, correlation ID and trace ID. This observer excludes query strings, fragments and request/response bodies. | [Tracker observer](server/src/analytics-script/requestCorrelation.ts), [shared event contract](shared/src/requestCorrelation.ts) |
| Show request events beside a recording and open matching Loki logs or Tempo traces in Grafana, using the site's configured profile. | [Replay request panel](client/src/components/replay/correlation/ReplayRequestCorrelation.tsx), [Grafana links](client/src/components/replay/correlation/observabilityLinks.ts) |
| Configure self-hosted service URLs, optional email/Search Console integration and a link to the published source revision. | [Service configuration](server/src/lib/serviceConfiguration.ts), [source URL](server/src/lib/sourceCodeUrl.ts) |

### Local development and checks

Use Node.js 24 from [.nvmrc](.nvmrc) and the pnpm version pinned in
[package.json](package.json). Follow [Local development](CONTRIBUTE.md#local-development)
to prepare the local PostgreSQL, ClickHouse and Redis instances, `server/.env`
from its example, `client/.env.local`, and the explicit initial database migration.
The API listens on port 3001 and the dashboard on port 3002.

Run these commands from the repository root after preparing that environment:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds shared code and starts its watcher alongside both applications.
The backend compiles once when started; restart it after backend changes.
The root also provides `pnpm dev:client` and `pnpm dev:server`.

```bash
pnpm typecheck
pnpm test
pnpm build
node --test scripts/*.test.mjs
```

The root test command builds shared code and runs the application suites one
package at a time with four workers. `pnpm build:client` and `pnpm build:server`
build individual applications with their shared dependency; the backend build
also regenerates the browser tracker. Builds and tests do not apply database
migrations. `pnpm lint` currently has no configured client rules; CI checks new
lint errors with `node scripts/lint-minimal-delta.cjs` against its pinned baseline.
See [the test workflow](.github/workflows/test.yml) for package-level CI commands.

### Configuration and deployment boundaries

Use [.env.example](.env.example) for the root Compose configuration and
[server/.env.example](server/.env.example) for local backend development.
Additional fork settings are read by the source files linked above:

| Setting | Purpose |
| --- | --- |
| `CLOUD=false`, `NEXT_PUBLIC_CLOUD=false` | Select self-hosted behavior in the API and dashboard. |
| `BASE_URL`, `SERVER_URL` | Public dashboard and API origins. `SERVER_URL` defaults to `BASE_URL` when omitted. |
| `NEXT_PUBLIC_BACKEND_URL` | API URL compiled into the dashboard. Set it when building the client image. |
| `DISABLE_SIGNUP` | Server-side signup policy, also returned by `/api/config` for the dashboard UI. |
| `WOTCV_REPLAY_CORRELATION_JSON` | Per-site API origins and Grafana profiles; an empty array disables correlation. See the [configuration parser](server/src/lib/replayCorrelation.ts). |
| `SOURCE_CODE_URL` | Public source revision linked from the dashboard. |

For containers, ensure the selected Compose configuration passes each setting
into the service; the base file does not pass all fork settings.

A correlation profile includes `siteIds`, `requestOrigin`, `grafanaUrl`, `orgId`,
`lokiDatasourceUid`, `serviceName`, `environment` and `timePaddingMs`;
`tempoDatasourceUid` is optional. Request observation requires session replay to
be enabled for the site. Grafana links require matching response identifiers and
access to the configured Grafana instance. Profiles are served through the
authenticated replay API; the public tracking configuration exposes only allowed
API origins. The WoT-CV frontend owns its tracker loading and privacy controls.

Both [client/Dockerfile](client/Dockerfile) and [server/Dockerfile](server/Dockerfile)
use the repository root as their build context. Client `NEXT_PUBLIC_*` settings
must be supplied at build time; changing container environment variables alone
does not rewrite the compiled bundle.

The [candidate overlay](docker-compose.wotcv-minimal.yml) and
[fresh native overlay](ops/minimal/compose.fresh.yml) are separate configurations
applied after the base Compose file; do not combine them. They require Compose
2.24.4 or newer for `!override`. The native backend's entrypoint applies database
migrations on startup, so use an isolated, explicitly prepared environment.
The [native updater](scripts/wotcv-native-update.py) is tied to an existing
installation and accepts only frontend/static-asset updates under its source
guards. The [legacy updater bridge](scripts/wotcv-branch-build-deploy.sh) refuses
deployment with exit code 78. These scripts are not a general fresh-install guide.
Proxy examples for private noindex responses and public tracker caching are in
[ops/nginx/](ops/nginx/).

<hr>

## ✨ Key Features

- All key web analytics metrics including sessions, unique users, pageviews, bounce rate, session duration
- Session replays
- No cookies & privacy friendly
- Customizable goals. retention, user journeys, and funnels dashboards
- Advanced filtering across 15+ dimensions
- Custom events with JSON properties
- 3 level location tracking (country -> region -> city) + advanced map visualizations
- Real time dashboard
- Support for organizations and unlimited number of sites

<hr>

## 📊 Comparison

See how Rybbit compares to other analytics solutions:

| Feature                           | Rybbit | GA4        | Plausible  | Cloudflare |
| --------------------------------- | ------ | ---------- | ---------- | ---------- |
| **Open Source**                   | ✅     | ❌         | ✅         | ❌         |
| **Self-Hosting**                  | ✅     | ❌         | ✅\*       | ❌         |
| **Cookieless & Privacy friendly** | ✅     | ❌         | ✅         | ✅         |
| **Advanced Maps**                 | ✅     | ❌         | ❌         | ❌         |
| **Advanced Filters**              | ✅     | ⚠️ Limited | ⚠️ Limited | ❌         |
| **Web Vitals**                    | ✅\*\* | ❌         | ❌         | ❌         |
| **Session Details**               | ✅     | ❌         | ❌         | ❌         |
| **User Profiles**                 | ✅     | ❌         | ❌         | ❌         |
| **Session Replays**               | ✅     | ❌         | ❌         | ❌         |
| **Funnels**                       | ✅     | ✅         | ✅\*\*     | ❌         |
| **User Journeys**                 | ✅     | ✅         | ❌         | ❌         |
| **Retention Analysis**            | ✅     | ✅         | ❌         | ❌         |
| **Goals & Events**                | ✅     | ✅         | ✅         | ❌         |
| **Real-time Dashboard**           | ✅     | ✅         | ✅         | ✅         |
| **Custom Events (JSON)**          | ✅     | ✅         | ⚠️ Limited | ❌         |
| **Error Tracking**                | ✅     | ❌         | ❌         | ❌         |
| **Public Dashboards**             | ✅     | ❌         | ✅         | ❌         |
| **Organizations**                 | ✅     | ✅         | ✅         | ✅         |
| **Frog 🐸**                       | ✅     | ❌         | ❌         | ❌         |

\* Plausible's Community Edition has very limited features compared to their cloud version

\*\* Only available on paid tiers

<hr>

## 📊 Dashboard Preview

### Map

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 27 12 PM" src="https://github.com/user-attachments/assets/52643121-4f4d-4bbe-9910-2516226bf421" />
<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 30 39 PM" src="https://github.com/user-attachments/assets/153585d5-7ff6-43bb-8bf6-fecfbe240ef8" />
<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 30 00 PM" src="https://github.com/user-attachments/assets/3873bc6b-9f79-4e9a-b083-0676a7d52b1d" />
<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 30 23 PM" src="https://github.com/user-attachments/assets/04ceca1d-a4af-4f52-856c-f054deeb1023" />

## Session Replay

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 29 18 PM" src="https://github.com/user-attachments/assets/6906aef0-8ce0-41f9-9bbb-b175ef158df3" />

### Journeys

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 34 13 PM" src="https://github.com/user-attachments/assets/4cd465df-8f91-43bf-a121-647ae2c9e8e1" />

### Funnels

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 34 05 PM" src="https://github.com/user-attachments/assets/e3b083c2-4f18-4c8c-bc97-9491a6402439" />

### Goals

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 28 26 PM" src="https://github.com/user-attachments/assets/d34c5c00-1dec-4864-9115-bfa9e9811d60" />

### Users

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 28 54 PM" src="https://github.com/user-attachments/assets/f10c1bba-6658-4b6a-94a6-dcba351e4eea" />

### Errors

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 40 56 PM" src="https://github.com/user-attachments/assets/efd60f04-c203-45ea-981d-14f34ec2b1e1" />

### Retention

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 34 20 PM" src="https://github.com/user-attachments/assets/c56a31ac-7af5-419b-82a5-d3aedb68debc" />

### Web Vitals (Cloud only)

<img width="1299" height="797" alt="Screenshot 2025-10-16 at 7 28 01 PM" src="https://github.com/user-attachments/assets/d88b8be0-cd30-4dd6-a0e5-5446c890c0f9" />

<hr>

## ⭐ Star History

[![Star History Chart](https://star-history.dera.page/svg?repos=rybbit-io/rybbit&type=Date)](https://star-history.dera.page/#rybbit-io/rybbit&Date)

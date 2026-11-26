# ⚔️ Round Table Dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)](#)

Comprehensive observability and control dashboard for the [Round Table](https://github.com/roundtable-k8s/roundtable) Kubernetes-native multi-agent orchestration system.

<!-- screenshot -->

The Round Table Dashboard provides real-time visibility into your AI agent fleet, mission execution, chain orchestration, and system architecture. Built for production deployments, it offers deep introspection, interactive debugging, and comprehensive cost tracking across your entire Round Table deployment.

## Features

### 🎯 Command Center (Dashboard)
The main control hub providing at-a-glance overview of your Round Table deployment:
- **Fleet health summary** — active knights, phase distribution, ready/suspended counts
- **Cost tracking dashboard** — real-time budget utilization across all missions and knights
- **Active missions panel** — current mission statuses with progress indicators
- **Chain execution monitor** — running chains with step-by-step progress
- **Activity feed** — live event stream showing task dispatches, completions, and system events
- **Quick actions** — dispatch new missions, navigate to critical resources

### 🛡️ Fleet Management
Complete knight lifecycle management and monitoring:
- **Knight status cards** — visual health indicators (online/offline/starting)
- **Phase tracking** — Running, Ready, Suspended, Failed states with color coding
- **Model information** — AI model configurations (GPT-4, Claude, Llama, etc.)
- **Runtime details** — pi-agent version, container status, uptime
- **Performance metrics** — tasks completed/failed, total cost, concurrency settings
- **Skill inventory** — installed skills and Nix packages per knight
- **Pod introspection** — container states, restart counts, node placement
- **Live logs** — streaming pod logs with auto-refresh
- **Session debugging** — knight session introspection (stats, recent tasks, session tree)

### 🎯 Missions
Mission lifecycle management from creation to completion:
- **Mission wizard** — step-by-step mission creation with validation
  - Basic configuration (name, objective, round table reference)
  - Knight assignment with roles
  - Advanced options (success criteria, briefing, cleanup policy)
  - Planner configuration for meta-missions
  - Budget and timeout controls
- **Mission list** — all active and completed missions with status badges
- **Mission details** — deep dive into mission execution:
  - Knight statuses (ready/ephemeral/tasks completed)
  - Chain execution progress with phase indicators
  - Planning results for meta-missions (generated chains/knights/skills)
  - Cost tracking against budget
  - Results ConfigMap references
- **Mission deletion** — cleanup of completed or failed missions

### 👑 Round Tables
Fleet-level configuration and warm pool management:
- **Round table list** — all configured fleets with health indicators
- **NATS prefix configuration** — subject routing setup
- **Warm pool status** — available/provisioning/claimed knight counts
- **Policy enforcement** — max concurrent tasks, cost budgets, capacity limits
- **Cost aggregation** — total spending across all knights in the table
- **Mission tracking** — active mission counts per round table
- **Suspension controls** — fleet-wide suspend/resume capabilities
- **Ephemeral mode** — temporary round table lifecycle management

### 📥 Queues
Work that is waiting, per knight (`/queues`):
- **Queues table** — pending, ack-pending, redelivered, oldest wait, free slots and replicas (current/max) from each knight's JetStream consumer (`GET /api/queues`)
- **Scaling sparkline** — the last hour of pending tasks and replicas on a shared time axis, with KEDA/HPA scale events marked ▲/▼ (`GET /api/queues/history`)
- **Warning badges** — oldest wait over 5 minutes, or tasks pending with no free slots while replicas are at max
- **Grafana link** for long-term history when the API sets `GRAFANA_QUEUE_URL`

### 📜 Dispatch (Tasks)
Direct task execution and history:
- **Quick dispatch interface** — send tasks to any knight instantly
- **Knight/domain selection** — dropdown selectors with validation
- **Task history viewer** — recent task executions with results
- **NATS subject monitoring** — raw subject paths for debugging
- **Response streaming** — real-time result display
- **Timeout configuration** — per-task timeout overrides
- **Dispatch confirmation** — task ID and subject tracking

### 📊 Message Flow (Live)
Real-time NATS event visualization:
- **Animated message graph** — visual representation of NATS message flow
- **Subject-based routing** — tasks, results, missions, chains tracked separately
- **Live event stream** — WebSocket-based real-time updates
- **Color-coded events** — task (blue), result (green), mission (purple), chain (orange)
- **Event details** — click events to inspect full payload
- **Throughput monitoring** — messages per second, total counts
- **Graph auto-layout** — force-directed graph with drag-and-drop nodes

### 🔗 Chains
Declarative pipeline execution with DAG visualization:
- **Chain list** — all defined chains with execution status
- **Phase indicators** — Pending, Running, Succeeded, Failed, Paused
- **Step-by-step progress** — individual step statuses with timing
- **DAG visualization** — interactive directed acyclic graph of chain dependencies
- **Step details** — knight assignments, domain routing, retry counts
- **Output inspection** — step results with NATS KV integration
- **Schedule display** — cron-based recurring chains
- **Dependency tracking** — dependsOn relationships visualized

### 🌲 Sessions
Knight session introspection and debugging:
- **Session statistics** — active sessions, total tasks, memory usage
- **Recent tasks** — last N tasks executed with timing
- **Session tree** — hierarchical view of session state
- **State inspection** — variables, context, execution history
- **Performance metrics** — task duration, success/failure rates
- **Real-time updates** — live session data via NATS introspection API

### 🏛️ Architecture
Live system topology visualization:
- **Component graph** — visual representation of Round Table architecture
- **Node types** — Knights, Round Tables, NATS, Kubernetes, Missions, Chains
- **Relationship mapping** — connections between components
- **Interactive exploration** — zoom, pan, drag nodes
- **Health indicators** — component status reflected in graph
- **Export capabilities** — save topology diagrams

### 📖 Chronicles (Briefings)
Daily briefing viewer and historical record:
- **Briefing list** — all available daily briefings by date
- **Markdown rendering** — rich formatting with syntax highlighting
- **Date navigation** — jump to specific dates or browse chronologically
- **Full-text display** — complete briefing content with proper formatting
- **Vault integration** — reads from mounted Obsidian vault

### 💰 Cost Details
Expanded cost breakdown and budget tracking:
- **Per-knight costs** — detailed spending by individual knight
- **Mission budget tracking** — cost vs. budget for active missions
- **Model cost breakdown** — spending by AI model (GPT-4, Claude, etc.)
- **Time-series graphs** — cost trends over time
- **Budget alerts** — warnings when approaching limits
- **Export capabilities** — cost reports for accounting

## CRD Integration

The dashboard provides full CRUD operations for Round Table Custom Resource Definitions:

### Knight CRD (`knights.ai.roundtable.io/v1alpha1`)
- View knight specifications (model, domain, runtime, skills)
- Monitor knight status (phase, tasks completed/failed, total cost)
- Inspect pod lifecycle (container states, restart counts)
- Access knight logs and session data

### Chain CRD (`chains.ai.roundtable.io/v1alpha1`)
- List all chains with execution status
- View chain specifications (steps, dependencies, schedule)
- Monitor step execution (phase, timing, output)
- Visualize DAG structure

### Mission CRD (`missions.ai.roundtable.io/v1alpha1`)
- Create missions via wizard (all spec fields supported)
- List missions with status and cost tracking
- View mission details (knights, chains, planning results)
- Delete completed missions

### RoundTable CRD (`roundtables.ai.roundtable.io/v1alpha1`)
- List all round tables with health metrics
- View warm pool status (available/provisioning/claimed)
- Monitor policies (max tasks, cost budgets, capacity limits)
- Track aggregate metrics (total cost, active missions)

## Tech Stack

### Frontend
- **React 18** — UI framework with hooks and concurrent rendering
- **TypeScript 5.9** — type-safe JavaScript with strict mode
- **Vite 6** — lightning-fast build tool and dev server
- **Tailwind CSS 3** — utility-first styling framework
- **React Router 7** — client-side routing with SPA navigation
- **@xyflow/react** — interactive graph visualization for chains and architecture
- **react-markdown** — markdown rendering for briefings
- **lucide-react** — icon library (450+ icons)
- **date-fns** — date formatting and manipulation
- **Vitest** — unit testing framework
- **Storybook 8** — component development and documentation

### Backend
- **Go 1.23** — API server and orchestration logic
- **gorilla/mux** — HTTP routing and middleware
- **gorilla/websocket** — WebSocket support for real-time events
- **NATS Go Client** — NATS/JetStream integration
- **Kubernetes Client-Go** — in-cluster API access
- **rs/cors** — CORS middleware for cross-origin requests

### Infrastructure
- **NATS JetStream** — event streaming, task queue, result storage
- **Kubernetes API** — pod status, CRD management, resource watching
- **NATS KV Store** — chain step outputs, mission results
- **Obsidian Vault** — daily briefing storage (optional)

## Prerequisites

- **Kubernetes cluster** (1.27+) with Round Table operator installed
- **NATS JetStream** deployed and accessible
- **Round Table operator** (installs Knight, Chain, Mission, RoundTable CRDs)
- **Namespace**: `roundtable` (or custom via `NAMESPACE` env var)

## Quick Start

### Development Mode

```bash
# Clone repository
git clone https://github.com/roundtable-k8s/roundtable-ui.git
cd roundtable-ui

# Terminal 1: Start backend API server
cd api
go run . &

# Terminal 2: Start frontend dev server
cd ui
npm install
npm run dev

# Open browser to http://localhost:5173
```

### Nix Development Shell

`flake.nix` pins the toolchain CI uses (Node 22 and Go, plus git, gh and jq), so a
local shell matches the build:

```bash
nix develop        # shell with node, npm, go, git, gh, jq on PATH
nix build .#knight-tools   # the same tools as one environment (<result>/bin/*)
nix flake check    # verifies the tool versions and that knight-tools contains the tools
```

### Production Deployment

The dashboard is deployed as part of the Round Table operator chart. The chart is published only as an OCI artifact (there is no classic Helm repository, so no repository needs to be added). The dashboard is enabled by default.

```bash
# Install/upgrade Round Table with the dashboard exposed through an ingress
helm upgrade --install roundtable-operator oci://ghcr.io/roundtable-k8s/charts/roundtable-operator \
  --namespace roundtable \
  --create-namespace \
  --set dashboard.enabled=true \
  --set dashboard.ingress.enabled=true \
  --set dashboard.ingress.host=roundtable.example.com

# Port-forward for local access. The Service name follows the Helm release name
# (<release>-dashboard) and listens on port 80.
kubectl port-forward -n roundtable svc/roundtable-operator-dashboard 8080:80

# Open browser to http://localhost:8080
```

For NATS prerequisites, Flux `OCIRepository`/`HelmRelease` installs and a kind quickstart, see [`docs/install.md`](https://github.com/roundtable-k8s/roundtable/blob/main/docs/install.md) and [`docs/getting-started.md`](https://github.com/roundtable-k8s/roundtable/blob/main/docs/getting-started.md) in the roundtable repo.

## Configuration

### Environment Variables

The dashboard API server is configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `NATS_URL` | NATS server URL | `nats://nats.database.svc:4222` |
| `NAMESPACE` | Kubernetes namespace for Round Table resources | `roundtable` |
| `PORT` | HTTP server port | `8080` |
| `FLEET_PREFIX` | Optional filter: only cover the RoundTable on this NATS prefix. Unset = every RoundTable in `NAMESPACE` (prefix and streams read from `spec.nats`); used as the only table when none can be discovered | unset (`fleet-a` fallback) |
| `FLEET_STREAM` | Results stream for the `FLEET_PREFIX` table (overrides its `spec.nats.resultsStream`) | unset (`fleet_a_results` fallback) |
| `CARDS_KV_BUCKET` | NATS KV bucket holding the knight agent cards (key `<table>.<knight>`). Read only: the dashboard never creates it, a missing bucket means no cards | `roundtable-cards` |
| `GRAFANA_QUEUE_URL` | Optional long-term queue history link returned by the queue history endpoints; `{knight}` is replaced by the knight name | _(unset)_ |
| `VAULT_PATH` | Path to mounted Obsidian vault | `/vault` |
| `BRIEFINGS_DIRS` | Comma-separated vault-relative directories scanned for briefings (absolute and `..` entries are ignored; missing directories are skipped) | `Briefings/Daily,Agents/Briefings` |
| `GATEWAY_URL` | Base URL of the roundtable gateway; dispatch, run-now and the Failed & lost page (dead letters, retry) go through it (unset = those endpoints return 503) | _(unset)_ |
| `GATEWAY_TOKEN_FILE` | File whose first line is the gateway bearer token; re-read when the gateway answers 401 (token rotation). Takes precedence over `GATEWAY_TOKEN` | _(none)_ |
| `GATEWAY_TOKEN` | Optional bearer token sent to the gateway | _(none)_ |
| `DISPATCH_RATE` / `DISPATCH_BURST` | Rate limit (requests/sec, bucket size) of dispatch and run-now; rate <= 0 disables it | `2` / `10` |
| `DASHBOARD_API_KEY` | Optional API key for authentication. The `?api_key=` query form is accepted on `/api/ws` only; use the `Authorization` header elsewhere | _(none)_ |
| `ALLOWED_ORIGINS` | CORS allowed origins (comma-separated) | _(same-origin only)_ |
| `LOG_LEVEL` | Only `debug` is special (debug logging); any other value, or unset, logs at info | _(unset = info)_ |
| `TRACE_URL_TEMPLATE` | Trace viewer URL for the "View trace" links: an http(s) URL containing `{traceId}`. Anything else is ignored with a warning. Returned as `traceUrlTemplate` by `GET /api/config`. See [Tracing](#tracing) | _(unset)_ |
| `ACTIVITY_PREFIXES` | Comma-separated NATS prefixes whose `<prefix>.activity.>` events feed the running-tasks view | the prefix of every discovered table |
| `ACTIVITY_HEARTBEAT_INTERVAL` | The knights' heartbeat interval as a Go duration (e.g. `10s`); running entries go stale after 3x this. Invalid or <= 0 values fall back to the default | `10s` |
| `WS_MAX_CONNECTIONS` | Maximum concurrent WebSocket connections; further upgrades get 503 with `Retry-After: 5`. `0` = unlimited. Exposed as the `roundtable_ui_ws_connections` gauge and `roundtable_ui_ws_rejected_total` counter | `200` |
| `OTEL_SDK_DISABLED` | `true` (case-insensitive) turns trace export off | _(unset)_ |
| `OTEL_TRACES_EXPORTER` | `none` turns trace export off | _(unset)_ |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector endpoint; setting it (or the traces one below) enables trace export | _(unset: no export)_ |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Traces-specific OTLP/HTTP endpoint (same effect as above) | _(unset)_ |
| `OTEL_SERVICE_NAME` | `service.name` of the exported spans | `roundtable-ui` |

### Tracing

The API server exports OpenTelemetry traces (OTLP over HTTP) only when
`OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set;
without one no exporter is created and no collector connection is attempted.
`OTEL_SDK_DISABLED=true` or `OTEL_TRACES_EXPORTER=none` switches export off
even with an endpoint. Each request gets a server span named after its route
template, and gateway calls are client spans carrying the W3C `traceparent`.
`/api/ws`, `/metrics`, `/healthz` and `/readyz` produce no spans. Log lines
written inside a traced request carry `trace_id` and `span_id`.

The "View trace" links on chain and mission cards use the `traceId` (32 hex
characters, from `status.traceID` of the Chain or Mission). The dashboard
fetches `traceUrlTemplate` from `GET /api/config` and replaces `{traceId}`
with it, e.g. `TRACE_URL_TEMPLATE=https://tempo.example.com/trace/{traceId}`.
With no template, or no trace ID, no link is shown.

### Authentication

The web UI never handles credentials — authentication is expected to happen
upstream (e.g. Authentik/Traefik forward auth at the ingress). The API's
bearer check remains for direct (non-browser) access. Two supported modes:

1. **Open mode** — leave `DASHBOARD_API_KEY` unset. No auth anywhere;
   suitable for local dev and trusted networks.
2. **Forward auth** — set `DASHBOARD_API_KEY` on the API and have the
   ingress/proxy inject `Authorization: Bearer <key>` into proxied requests
   (including WebSocket upgrades). Direct API calls without the header get
   401; scripts can pass the header themselves, and WebSocket clients may
   use the `?api_key=` query parameter (on `/api/ws` only).

> ⚠️ If `DASHBOARD_API_KEY` is set but no proxy injects the header, the UI
> will show 401 errors everywhere — there is no in-browser login.

```bash
# Enable bearer enforcement on the API
export DASHBOARD_API_KEY=your-secret-key-here
```

### CORS Configuration

For production deployments with separate frontend hosting:

```bash
export ALLOWED_ORIGINS="https://dashboard.example.com,https://admin.example.com"
```

## API Endpoints

The dashboard exposes a comprehensive REST API:

### Authentication
- `POST /api/auth/login` — Validate API key

### Fleet Management
- `GET /api/fleet` — List all knights
- `GET /api/fleet/{knight}` — Get knight details
- `GET /api/fleet/{knight}/logs` — Stream knight pod logs
- `GET /api/fleet/{knight}/pods` — Pods of the knight with container state and last activity: `{pods: [...], default}` (`default` is the pod to show first, absent when there are none). 503 when Kubernetes is unavailable
- `GET /api/running` — Tasks running now (from live `<prefix>.activity.>` events): `{tasks, count, generatedAt, heartbeatIntervalMs, staleAfterMs}`. Optional `?table=<name>` (`none` = knights without a RoundTable)
- `GET /api/fleet/{knight}/session?type={stats|recent|tree}` — Knight session introspection
- `GET /api/fleet/{knight}/queue` — Knight's JetStream task queue (pending, ack-pending, redelivered, oldest wait, free slots)
- `GET /api/queues` — Task queues of all knights
- `GET /api/fleet/{knight}/queue/history?since=1h` — Sampled queue backlog and replicas (every 15 s, last 6 h, in memory) plus KEDA/HPA scale events with reasons
- `GET /api/queues/history?since=1h` — The same history for every knight

### Agent Cards
- `GET /api/cards` — Every knight's agent card for the covered tables (optional `?table=<name>`; 400 for an unknown table), read from `CARDS_KV_BUCKET`, plus whether the knight is live and its load. Cards exist while a knight is scaled to zero. A missing bucket returns `{"cards": []}`.
  ```json
  {"cards": [
    {"table": "personal", "knight": "galahad",
     "card": {"schemaVersion": 1, "name": "galahad", "description": "…", "skills": […], "roundtable": {…}},
     "live": true,
     "stats": {"name": "roundtable-knight", "id": "…", "metadata": {"table": "personal", "knight": "galahad", …},
               "started": "…", "endpoints": [{"name": "…", "data": {"activeTasks": 1, "maxConcurrentTasks": 2, …}}]}}
  ]}
  ```
  `card` is the raw card JSON (schema: roundtable `docs/agent-cards.md`). `live`/`stats` come from `$SRV.STATS.roundtable-knight` (all replies within 500 ms, matched on the service's `table` and `knight` metadata, cached 10 s); `stats` is the latest STATS reply, `null` when the knight is not live. With several pods the most recently started one is used.

### Task Dispatch
- `GET /api/tables` — Tables covered by the dashboard (`{"tables": [{name, prefix, tasksStream, resultsStream}]}`)
- `GET /api/tasks` — List recent tasks from JetStream
- `POST /api/tasks/dispatch` — Dispatch a task through the invoke gateway (`POST /v1/knights/{knight}/invoke`, `timeoutSeconds: 0`). Body `{knight, task, model?, runId?}`; returns the gateway task record (`taskId`, `runId`, `status`). 503 when `GATEWAY_URL` is unset; rate limited (429)
- `GET /api/tasks/dispatch/{taskId}` — Task status and output (`GET /v1/tasks/{taskId}`)

### Chat
Gateway-backed: all answer 503 when `GATEWAY_URL` is unset.
- `GET /api/chat/knights` — Knights the gateway can reach (`GET /v1/knights`)
- `POST /api/chat/{knight}` — Send a chat turn (`POST /v1/knights/{knight}/invoke`, `timeoutSeconds: 0`). Body `{message, runId?, model?, namespace?}`; `message` is 1-10000 characters, pass an earlier turn's `runId` to continue its session. Returns the gateway task record at once; rate limited (429)
- `GET /api/chat/tasks/{taskId}` — Task status and output (same as `GET /api/tasks/dispatch/{taskId}`)
- `GET /api/chat/tasks/{taskId}/events` — Server-sent events of the task, streamed from the gateway; a non-200 answer (404 when the gateway has no events endpoint, message `Task events not available`) is relayed as JSON so the client can fall back to polling

### Failed & Lost
Gateway-backed: all answer 503 when `GATEWAY_URL` is unset.
- `GET /api/dead-letters` — List dead letters. Query (forwarded as is): `knight`, `reason`, `state`, `limit`
- `GET /api/dead-letters/{taskId}` — One dead letter including the original task payload, which the list omits. Optional `?table=`
- `POST /api/dead-letters/{taskId}/retry` — Retry a dead letter. Optional body `{force?, table?}` (only these two are forwarded); the gateway's status codes (409, 422, …) pass through. The dashboard never sends a `namespace`, so the retry relies on the gateway's default namespace

### Chain Orchestration
- `GET /api/chains` — List chains: slim (chain-level phase, timings, cost and tokens; steps carry only `name` and `phase`), running first then newest first. Query: `limit` (default 100, max 500), `offset`, `phase` (comma-separated), `template` (run copies of a template, from the `ai.roundtable.io/run-template` annotation, exposed as `runTemplate`), `copies` (`include` | `exclude` | `only`), `full=true` (the full payload; every chain in list order unless `limit`/`offset` is given). `X-Total-Count` is the number of matching chains
- `GET /api/chain-groups` — Run copies per template: `{template, runs, phases, lastStartTime, templateExists}`
- `GET /api/chains/{name}` — Get chain details (step results, fan-out items, loop rounds; same shape as the `chain` WebSocket push)
- `POST /api/chains/{name}/run` — Run now through the gateway (`POST /v1/chains/{name}/runs`, `waitSeconds: 0`). Optional body `{input}`; only Chains labelled `ai.roundtable.io/invokable: "true"` can be run (chain summaries carry `invokable`). 503 when `GATEWAY_URL` is unset; rate limited (429)
- `GET /api/chains/runs/{namespace}/{run}` — Run status (`GET /v1/runs/{namespace}/{run}`)
- `POST /api/chains/runs/{namespace}/{run}/cancel` — Cancel a run (`POST /v1/runs/{namespace}/{run}/cancel`). Optional body `{reason}` (at most 500 characters, else 400); the gateway's 404/409 for runs it cannot cancel pass through. 503 when `GATEWAY_URL` is unset; rate limited (429)
- `GET /api/chains/{name}/steps/{step}/output` — Get step output from NATS KV

### Schedules
Proxied to the gateway (`/v1/schedules`); all answer 503 when `GATEWAY_URL` is unset and pass the gateway's status codes and JSON body through (e.g. 409 with `managedBy` for a Git-managed schedule). `{namespace}` and `{name}` must be Kubernetes names (else 400); bodies are limited to 1 MiB and must be valid JSON (400 otherwise, 413 when too large) — the gateway validates the schedule itself.
- `GET /api/schedules` — List schedules. Optional `?namespace=` and `?table=` (`none` is the dashboard's own filter value and is not forwarded)
- `POST /api/schedules` — Create a schedule (body forwarded as is)
- `GET /api/schedules/{namespace}/{name}` — Get a schedule
- `PUT /api/schedules/{namespace}/{name}` — Replace a schedule (body forwarded as is)
- `DELETE /api/schedules/{namespace}/{name}` — Delete a schedule
- `GET /api/schedules/{namespace}/{name}/manifest` — The schedule as a manifest, `application/yaml` by default; `?format=json` converts it to JSON, `?format=yaml` is the default, any other value is 400
- `POST /api/schedules/{namespace}/{name}/suspend` — Suspend (no body)
- `POST /api/schedules/{namespace}/{name}/resume` — Resume (no body)
- `POST /api/schedules/{namespace}/{name}/run` — Run now (no body); rate limited (429) like dispatch
- `GET /api/schedules/{namespace}/{name}/runs` — Recent runs. Optional `?limit=` (1-200, else 400)
- `GET /api/schedules/{namespace}/{name}/runs/{run}` — Result of one run

### Triggers
Read-only view of the Trigger resource (source, target, recent firings). 503 when Kubernetes is unavailable.
- `GET /api/triggers` — List triggers in `NAMESPACE`. Optional `?table=<name>` (`none` = no RoundTable)
- `GET /api/triggers/{namespace}/{name}` — Trigger detail; 404 when `{namespace}` is not the dashboard's `NAMESPACE` or the trigger does not exist

### Mission Management
- `GET /api/missions` — List all missions
- `GET /api/missions/{name}` — Get mission details
- `POST /api/missions` — Create new mission
- `DELETE /api/missions/{name}` — Delete mission
- `GET /api/missions/{name}/results` — Get mission results from NATS KV

### Round Table Management
- `GET /api/roundtables` — List all round tables
- `GET /api/roundtables/{name}` — Get round table details

### Briefings
- `GET /api/briefings` — List available briefings across all `BRIEFINGS_DIRS` as `[{name, dir}]` (only `YYYY-MM-DD.md` files; missing directories are skipped, so the result may be `[]`)
- `GET /api/briefings/{date}` — Get briefing for specific date (YYYY-MM-DD). Optional `?dir=` selects one configured directory (403 if it is not configured); otherwise directories are searched in order. The `X-Briefing-Dir` response header names the directory the briefing came from

### Real-time Events
- `GET /api/ws` — WebSocket connection for live NATS events
  - Agent cards: `{type:"cards", op:"upsert", table, data: <entry as in /api/cards>}` when a card is written, `{type:"cards", op:"delete", table, data: {table, knight, deleted: true}}` when it is removed (KV watch on `<table>.*` for each covered table).
  - Task activity: send `{"subscribe":"activity","taskId":"…"}` (and `{"unsubscribe":"activity","taskId":"…"}`) to watch up to 10 tasks per connection. The server replies with an `activity` event `{op:"backlog"}` holding the task's last 200 events (kept 15 minutes after `task.finished`), then `{op:"event"}` for each live event of that task only. Live events are droppable; `{op:"gap", fromSeq, toSeq}` marks events dropped for this client, and clients should also treat a `seq` jump as a gap.

### System
- `GET /api/config` — Get dashboard configuration (`fleetPrefix`, `namespace`, and `traceUrlTemplate` when `TRACE_URL_TEMPLATE` is valid)
- `GET /api/health` — Health check endpoint
- `GET /metrics` — Prometheus metrics. Served at the root, outside `/api`, so it is not subject to the `DASHBOARD_API_KEY` check

## Security

### Input Validation
- All knight/domain names validated with regex to prevent NATS subject injection
- Kubernetes resource names validated against K8s naming rules
- Request body size limits enforced (1MB max)
- Path traversal protection for briefing file access

### Rate Limiting
- Simple sliding-window rate limiter (100 req/s default)
- Applied to all API endpoints

### Authentication
- Optional API key authentication via `DASHBOARD_API_KEY`
- Bearer token in `Authorization` header or `api_key` query param (WebSocket)
- Health endpoint always accessible

### CORS
- Same-origin policy by default
- Explicit origin whitelist via `ALLOWED_ORIGINS`

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup instructions
- Code style guidelines
- Testing requirements
- Pull request process
- Issue reporting

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    Browser (React SPA)                     │
│  ┌──────────┐ ┌─────────┐ ┌─────────┐ ┌────────────────┐  │
│  │Dashboard │ │ Fleet   │ │Missions │ │  Message Flow  │  │
│  │  (Home)  │ │ Status  │ │ Wizard  │ │  (Live Graph)  │  │
│  └────┬─────┘ └────┬────┘ └────┬────┘ └───────┬────────┘  │
│       │            │           │               │            │
│  ┌────┴────────────┴───────────┴───────────────┴────────┐  │
│  │          React Router + REST API Client              │  │
│  │      (fetch + WebSocket for real-time events)        │  │
│  └────────────────────────┬─────────────────────────────┘  │
└───────────────────────────┼────────────────────────────────┘
                            │ HTTP/WebSocket
┌───────────────────────────┼────────────────────────────────┐
│                  API Server (Go)                           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐   │
│  │ Fleet Handler│ │Task Dispatcher│ │  NATS WS Bridge │   │
│  │ (K8s CRDs)   │ │ (NATS Pub)    │ │ (Sub streaming) │   │
│  └──────┬───────┘ └──────┬────────┘ └────────┬─────────┘   │
│         │                │                   │              │
│  ┌──────┴────────────────┴───────────────────┴──────────┐  │
│  │         Middleware (Auth, CORS, Rate Limit)          │  │
│  └──────┬────────────────────────────────────────┬──────┘  │
│         │                                        │          │
│  ┌──────┴──────────┐                    ┌───────┴───────┐  │
│  │ Kubernetes      │                    │ NATS Client   │  │
│  │ Client (CRDs)   │                    │ (JetStream)   │  │
│  └─────────────────┘                    └───────────────┘  │
└───────────────┬────────────────────────────────┬───────────┘
                │                                │
         ┌──────┴─────────┐             ┌───────┴────────┐
         │  Kubernetes    │             │  NATS Server   │
         │  API Server    │             │  (JetStream)   │
         │                │             │                │
         │ - Knight CRDs  │             │ - Task Queue   │
         │ - Chain CRDs   │             │ - Results KV   │
         │ - Mission CRDs │             │ - Event Stream │
         │ - RoundTable   │             │                │
         └────────────────┘             └────────────────┘
```

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**Built with ⚔️ by the Round Table team**

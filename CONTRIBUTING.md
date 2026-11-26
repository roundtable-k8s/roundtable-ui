# Contributing to Round Table UI

Thanks for your interest in contributing! 🏰

This repository is the Round Table dashboard: a Go API server and a React
frontend. (The operator lives in [roundtable-k8s/roundtable](https://github.com/roundtable-k8s/roundtable).)

## Layout

| Path | What it is |
|------|------------|
| `api/` | Go API server: REST and WebSocket endpoints, serves the built frontend from `api/static` |
| `ui/` | React + TypeScript + Vite + Tailwind frontend (tests with Vitest, components in Storybook) |
| `Dockerfile` | Builds the UI, then the API image that embeds it |
| `flake.nix` | Optional Nix dev shell with Go, Node and the other tools |

## Prerequisites

- Go (version in `api/go.mod`)
- Node.js 22+ and npm
- Optional: a Kubernetes cluster for real fleet data, or `nix develop` for a ready-made shell

## Getting Started

1. **Fork** the repository and clone your fork
2. **Create a branch**: `git checkout -b feat/your-feature`
3. **Make changes** and write tests
4. **Run the checks** below, then submit a PR against `main`

## Running Locally

Run the API and the frontend dev server in two terminals:

```bash
# Terminal 1: API on :8080 (PORT overrides it)
cd api && go run .

# Terminal 2: frontend on http://localhost:5173
cd ui && npm install && npm run dev
```

The Vite dev server proxies `/api` to `http://localhost:8080`. Without cluster
access the API starts but fleet data is empty. `npm run storybook` starts
Storybook on port 6006 for component work.

## Checks

Run both before pushing:

```bash
# API
cd api && gofmt -l . && go vet ./... && go test ./...

# UI
cd ui && npm test && npm run build
```

`gofmt -l .` must print nothing. `npm run build` also type-checks (`tsc -b`)
and writes the bundle to `api/static`.

## Code Style

- Add a dependency to `ui/package.json` only when code imports it, and commit the updated `ui/package-lock.json` with it

- Go: standard conventions (`gofmt`, `go vet`); structured logging with `log/slog`
- TypeScript: follow the existing patterns in `ui/src` (pages, components, hooks, `lib`)
- Write tests for new functionality: `*_test.go` next to the Go code, `*.test.ts(x)` next to the frontend code
- Lists the API cuts short (pages, caps) must say so in the UI rather than silently dropping items

## What to Work On

- Check [open issues](https://github.com/roundtable-k8s/roundtable-ui/issues), especially `good first issue`
- Bug fixes are always welcome
- Feature ideas? Open an issue first to discuss

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(ui): schedule detail view with run history
fix(api): running registry follows RoundTables created or removed
docs(readme): install the dashboard from the OCI chart
```

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Include tests
- Update documentation if behavior changes
- Link related issues

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.

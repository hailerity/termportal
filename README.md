# Termportal

A reusable TypeScript terminal runtime: a server that owns real PTY-backed shell sessions and
exposes them over REST (lifecycle) and WebSocket (interactive I/O), plus an xterm.js reference
client.

> REST manages terminal sessions; WebSocket carries terminal streams; PTY executes the shell;
> xterm.js renders the terminal.

- Sessions are first-class: they outlive the browser that created them.
- Several browsers can attach to one session; each new attachment is shown recent output.
- The core is framework-independent and unit-tested against a fake PTY.

## ⚠️ Security: trusted/internal deployment only

**Termportal V1 has no authentication and no isolation.** Anyone who can reach the server can
run commands **with the operating-system privileges of the server process**. Treat network
access to it as equivalent to shell access to the host.

- It binds to `127.0.0.1` by default. Do not bind it to a public interface.
- Browsers are restricted by an `Origin` allowlist (`ALLOWED_ORIGINS`), enforced on every HTTP
  request and WebSocket upgrade. This stops hostile web pages from driving a server reachable
  from a visitor's browser. It is **not** authentication: non-browser clients send no `Origin`.
- Before exposing it to users you do not fully trust, you need at least authentication,
  authorization, container (or VM) isolation, resource and process limits, filesystem and
  network-egress restrictions, and audit logging. See [docs/operations.md](docs/operations.md).

## Quickstart

Requirements: Node.js ≥ 22, macOS or Linux, and a C/C++ toolchain on Linux (node-pty compiles
there; macOS uses a prebuild).

```bash
npm install
npx nx serve server   # API on http://127.0.0.1:24001
npx nx serve web      # client on http://localhost:24002
```

Open <http://localhost:24002>, press **+ New**, and type. Open the same URL (it carries the
session id in its hash) in a second tab to share the session, or refresh to see replay.

With curl:

```bash
curl -X POST localhost:24001/api/v1/sessions -H 'content-type: application/json' \
     -d '{"shell":"bash","cols":120,"rows":40}'
curl localhost:24001/api/v1/sessions
curl localhost:24001/api/v1/sessions/<id>
curl -X DELETE localhost:24001/api/v1/sessions/<id>
```

## Repository layout

```text
apps/server                 composition root: Fastify REST, ws gateway, config, shutdown
apps/web                    reference client: React + xterm.js
apps/web-e2e                Playwright end-to-end suite
packages/terminal-core      TerminalSession, SessionManager, output buffer, PTY port
packages/terminal-pty       node-pty implementation of the PTY port
packages/terminal-protocol  WebSocket messages + validating codec
packages/api-contract       REST DTOs, error codes, validation rules
```

Dependency rules (enforced by ESLint): `terminal-core` imports no transport, rendering or PTY
library; `web` imports only `api-contract` and `terminal-protocol`. Packages are linked by name
through npm workspaces and TypeScript project references. In development and tests they
resolve to their sources through the `@termportal/source` export condition, so nothing needs
building first.

## Documentation

- [docs/design.md](docs/design.md) — architecture and design decisions
- [docs/api.md](docs/api.md) — REST API and WebSocket protocol reference
- [docs/operations.md](docs/operations.md) — configuration, deployment, observability,
  troubleshooting
- [docs/implementation-plan.md](docs/implementation-plan.md) — the phased plan this was built from

## Development

```bash
npx nx run-many -t lint typecheck test build   # everything
npx nx test @termportal/terminal-core          # one project
npm run e2e                                    # browser suite (starts its own servers)
npm run format                                 # prettier
npm run ci                                     # what CI runs, minus e2e
npx nx graph                                   # project graph
```

`nx serve server` restarts on change (tsx watch); `nx serve web` proxies `/api`, including
WebSocket upgrades, to the server. Point it elsewhere with `TERMPORTAL_SERVER_URL`. To make
the client call a server on another origin directly, build it with `VITE_API_BASE_URL` and add
the client's origin to the server's `ALLOWED_ORIGINS`.

### Testing

| Layer       | Where                                             | What it uses                    |
| ----------- | ------------------------------------------------- | ------------------------------- |
| Unit        | `packages/terminal-core`                          | `FakePty`, fake timers          |
| Contract    | `packages/api-contract`, `terminal-protocol`      | Zod schemas                     |
| REST        | `apps/server/src/http/*.test.ts`                  | `fastify.inject`, fake PTY      |
| WebSocket   | `apps/server/src/websocket/*.test.ts`             | real sockets, fake PTY          |
| Integration | `*.integration.test.ts` (terminal-pty and server) | a real PTY and shell            |
| End-to-end  | `apps/web-e2e`                                    | Chromium, real server, real PTY |

Tests assert on computed output (`echo hello-$((40+2))` → `hello-42`) so that the terminal's
echo of the typed command can never satisfy them.

## Known limitations of V1

- Replay is a bounded **byte history**, not a terminal-state snapshot. Once a full-screen
  program's setup sequences have been trimmed from the buffer, a newly attached client can look
  wrong until the program redraws (press `Ctrl+L`, or resize).
- One PTY has one size: with several clients attached, the most recent resize wins.
- Sessions live in memory and do not survive a server restart.
- POSIX hosts only (bash, zsh, sh); Windows is refused at startup.

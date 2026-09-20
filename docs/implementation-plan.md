# Remote Terminal Server — Implementation Plan

## 0. Delivery strategy

Implement vertically rather than building all infrastructure first.

The preferred progression is:

```text
Repository
  ↓
Core terminal abstraction
  ↓
Real PTY
  ↓
REST session API
  ↓
WebSocket protocol
  ↓
xterm.js client
  ↓
Replay/multi-client
  ↓
Hardening
```

Every phase should leave the system runnable.

---

# Phase 1 — Bootstrap the Nx monorepo

## Goal

Create a clean TypeScript Nx workspace with the project boundaries established.

## Tasks

- [x] Create Nx workspace.
- [x] Configure TypeScript.
- [x] Configure package-manager workspaces.
- [x] Create `apps/server`.
- [x] Create `apps/web`.
- [x] Create `packages/terminal-core`.
- [x] Create `packages/terminal-pty`.
- [x] Create `packages/terminal-protocol`.
- [x] Create `packages/api-contract`.
- [x] Configure project references.
- [x] Configure linting.
- [x] Configure unit testing.
- [x] Configure formatting.
- [x] Verify `nx graph`.
- [x] Verify all projects are recognized.
- [x] Add basic CI command.

## Acceptance criteria

```bash
nx graph
nx run-many -t typecheck
nx run-many -t lint
nx run-many -t test
```

all succeed.

Nx supports workspace/package linking and TypeScript project references; use those mechanisms instead of coupling packages with relative imports. citeturn0search0turn0search7

---

# Phase 2 — Define shared contracts

## Goal

Define stable types before implementing transport.

## Tasks

- [x] Define `SessionId`.
- [x] Define `TerminalSessionStatus`.
- [x] Define `CreateSessionRequest`.
- [x] Define `TerminalSessionResponse`.
- [x] Define `ListSessionsResponse`.
- [x] Define API error shape.
- [x] Define WebSocket client messages.
- [x] Define WebSocket server messages.
- [x] Add Zod schemas.
- [x] Add protocol tests.
- [x] Define protocol versioning strategy.

## WebSocket types

```ts
type ClientMessage =
  | {
      type: "input";
      data: string;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    }
  | {
      type: "ping";
    };
```

```ts
type ServerMessage =
  | {
      type: "output";
      data: string;
    }
  | {
      type: "status";
      status: TerminalSessionStatus;
    }
  | {
      type: "exit";
      exitCode: number;
    }
  | {
      type: "error";
      code: string;
      message: string;
    }
  | {
      type: "pong";
    };
```

## Acceptance criteria

- No transport package defines duplicate message structures.
- Invalid messages are rejected by schema validation.
- All public DTOs have tests.

---

# Phase 3 — Build the PTY abstraction

## Goal

Create an infrastructure-independent PTY interface.

## Tasks

- [x] Define `PtyProcess`.
- [x] Define `PtyFactory`.
- [x] Define PTY events.
- [x] Define spawn options.
- [x] Define fake PTY for tests.
- [x] Add unit tests around the fake.
- [x] Document PTY ownership and lifecycle.

## Acceptance criteria

`terminal-core` compiles and tests without importing `node-pty`.

---

# Phase 4 — Implement node-pty adapter

## Goal

Connect the abstraction to a real operating-system PTY.

## Tasks

- [x] Add `node-pty`.
- [x] Implement `NodePtyFactory`.
- [x] Map shell names to executables.
- [x] Spawn PTY with configured dimensions.
- [x] Forward PTY output.
- [x] Forward input.
- [x] Implement resize.
- [x] Implement kill.
- [x] Forward exit event.
- [x] Validate working directory.
- [x] Add platform handling.
- [x] Add integration test.

`node-pty` provides the required pseudoterminal bindings and is specifically intended for use cases such as terminal emulators. citeturn0search12

## Acceptance test

A test can effectively perform:

```text
spawn bash
write "echo hello\n"
receive "hello"
resize
kill
receive exit
```

---

# Phase 5 — Implement TerminalSession

## Goal

Build the central domain object.

## Tasks

- [x] Create session ID generator.
- [x] Implement session state.
- [x] Connect PTY output to session.
- [x] Implement `write`.
- [x] Implement `resize`.
- [x] Implement `terminate`.
- [x] Track PID.
- [x] Track timestamps.
- [x] Track exit code.
- [x] Track exit state.
- [x] Add lifecycle events.
- [x] Reject writes after exit.
- [x] Make termination idempotent.

## Unit tests

- [x] starts in `starting`.
- [x] becomes `running`.
- [x] writes input.
- [x] resizes PTY.
- [x] receives output.
- [x] exits.
- [x] records exit code.
- [x] termination kills PTY.
- [x] repeated termination is safe.

---

# Phase 6 — Implement SessionManager

## Goal

Manage all active sessions.

## Tasks

- [x] Add in-memory session map.
- [x] Implement `create`.
- [x] Implement `get`.
- [x] Implement `list`.
- [x] Implement `terminate`.
- [x] Implement max-session limit.
- [x] Remove exited sessions according to lifecycle policy.
- [x] Implement shutdown.
- [x] Add manager tests.

## Acceptance criteria

```text
create()
list()
get()
terminate()
shutdown()
```

all behave deterministically.

---

# Phase 7 — Implement REST API

## Goal

Expose session lifecycle over HTTP.

## Tasks

- [x] Bootstrap Fastify.
- [x] Add `/health`.
- [x] Add `POST /api/v1/sessions`.
- [x] Add `GET /api/v1/sessions`.
- [x] Add `GET /api/v1/sessions/:id`.
- [x] Add `DELETE /api/v1/sessions/:id`.
- [x] Validate request bodies.
- [x] Map domain errors to HTTP errors.
- [x] Add response serialization.
- [x] Add API tests.
- [x] Add CORS configuration appropriate for development.

## Acceptance criteria

The complete lifecycle works using curl:

```bash
curl POST /api/v1/sessions
curl GET /api/v1/sessions
curl GET /api/v1/sessions/:id
curl DELETE /api/v1/sessions/:id
```

---

# Phase 8 — Implement WebSocket gateway

## Goal

Expose interactive terminal I/O.

## Tasks

- [x] Add WebSocket server.
- [x] Implement session route.
- [x] Validate session ID.
- [x] Validate incoming messages.
- [x] Attach clients.
- [x] Route input to PTY.
- [x] Route resize to PTY.
- [x] Broadcast output.
- [x] Send status.
- [x] Send exit.
- [x] Handle malformed messages.
- [x] Handle disconnect.
- [x] Add heartbeat/ping handling.
- [x] Add WebSocket tests.

## Acceptance test

A WebSocket test client can:

```text
connect
  ↓
receive status
  ↓
send input
  ↓
receive output
  ↓
send resize
  ↓
terminate
  ↓
receive exit
```

---

# Phase 9 — Implement output replay

## Goal

Allow a new browser to attach to an already-running terminal without losing recent output.

## Tasks

- [x] Implement bounded ring buffer.
- [x] Configure byte limit.
- [x] Append PTY output.
- [x] Replay snapshot on attach.
- [x] Handle snapshot/live ordering safely.
- [x] Add tests around buffer truncation.
- [x] Add reconnect test.

## Important concurrency requirement

Avoid this race:

```text
snapshot
   ↓
PTY output happens
   ↓
live subscription starts
```

because that loses output.

The attach operation must establish the live subscription and obtain a consistent replay boundary before sending data.

---

# Phase 10 — Support multiple clients

## Goal

Allow several browsers to observe and interact with one session.

## Tasks

- [x] Create client registry per session.
- [x] Broadcast output.
- [x] Broadcast status/exit.
- [x] Route input from any client.
- [x] Remove disconnected clients.
- [x] Ensure one client failure doesn't affect others.
- [x] Add multi-client integration test.

## Acceptance test

```text
Browser A ─┐
           ├── Session ── PTY
Browser B ─┘
```

Typing in A produces output visible in B.

---

# Phase 11 — Build the xterm.js browser application

## Goal

Create the reference client.

## Tasks

- [x] Add xterm.js.
- [x] Add terminal component.
- [x] Create session API client.
- [x] Create WebSocket client.
- [x] Render output.
- [x] Forward keyboard input.
- [x] Handle terminal resize.
- [x] Use `FitAddon`.
- [x] Display connection state.
- [x] Display session exit state.
- [x] Add reconnect action.
- [x] Add session list.
- [x] Add create-session action.
- [x] Add terminate-session action.

## Initial UI

```text
┌───────────────────────────────────────────────┐
│ Terminal Sessions              [+ New]        │
├───────────────┬───────────────────────────────┤
│ term_123      │                               │
│ term_456      │  $ npm run dev                │
│ term_789      │  > server started...          │
│               │                               │
│               │                               │
└───────────────┴───────────────────────────────┘
```

---

# Phase 12 — End-to-end validation

## Goal

Validate the complete system.

## Scenarios

### Scenario A — basic terminal

- [x] Create session.
- [x] Open terminal.
- [x] Run `echo hello`.
- [x] See output.

### Scenario B — interactive shell

- [x] Run `cd`.
- [x] Run `pwd`.
- [x] Run `ls`.
- [ ] Use arrow keys. _(not explicitly verified; xterm.js default behaviour)_
- [x] Use Ctrl+C.
- [x] Use tab completion.

### Scenario C — resize

- [x] Resize browser.
- [x] Verify PTY dimensions.
- [x] Run a program that responds to terminal dimensions.

### Scenario D — reconnect

- [x] Start command.
- [x] Disconnect browser.
- [x] Command continues.
- [x] Reconnect.
- [x] Recent output is replayed.

### Scenario E — multiple clients

- [x] Open same session in two browser tabs.
- [x] Type in one.
- [x] Observe output in both.

### Scenario F — process exit

- [x] Run `exit`.
- [x] Session transitions to exited.
- [x] Browser receives exit event.

### Scenario G — server shutdown

- [x] Start sessions.
- [x] Stop server.
- [x] Confirm PTYs are terminated.
- [x] Confirm no orphan processes remain.

---

# Phase 13 — Hardening

## Tasks

- [x] Validate all API inputs.
- [x] Bound session count.
- [x] Bound output history.
- [x] Bound message size.
- [x] Bound WebSocket payload size.
- [x] Validate terminal dimensions.
- [x] Validate CWD.
- [x] Restrict supported shells.
- [x] Avoid logging terminal data.
- [x] Add structured logging.
- [x] Add graceful shutdown.
- [x] Add health endpoint.
- [x] Add readiness endpoint if deployment requires it.
- [x] Add error correlation/request IDs.
- [x] Add metrics hooks.

---

# Phase 14 — Documentation

## Tasks

- [x] README quickstart.
- [x] Architecture documentation.
- [x] REST API documentation.
- [x] WebSocket protocol documentation.
- [x] Local development guide.
- [x] Testing guide.
- [x] Security warning.
- [x] Deployment guide.
- [x] Troubleshooting guide.

The documentation should clearly state that V1 is a trusted/internal terminal service and that exposing host PTYs to untrusted users requires authentication and isolation.

---

# Phase 15 — CI/CD

## Tasks

- [x] Run formatting check.
- [x] Run lint.
- [x] Run typecheck.
- [x] Run unit tests.
- [x] Run integration tests.
- [x] Build server.
- [x] Build web.
- [x] Use Nx affected tasks in CI.
- [x] Cache appropriate build/test outputs.

Nx supports affected-task execution and caching through its project/task graph, which is useful as the monorepo grows. citeturn0search0turn0search2

---

# Recommended implementation order

The shortest useful path is:

```text
Phase 1  Nx
   ↓
Phase 2  Contracts
   ↓
Phase 3  PTY abstraction
   ↓
Phase 4  node-pty
   ↓
Phase 5  TerminalSession
   ↓
Phase 6  SessionManager
   ↓
Phase 7  REST
   ↓
Phase 8  WebSocket
   ↓
Phase 11 xterm.js
   ↓
Phase 12 E2E
   ↓
Phase 9  Replay
   ↓
Phase 10 Multi-client
   ↓
Phase 13 Hardening
   ↓
Phase 14 Docs
   ↓
Phase 15 CI/CD
```

Replay and multi-client can be implemented before the browser application if desired, but the above sequence optimizes for getting a working end-to-end terminal early.

---

# Suggested Git milestones

## Milestone 1

`chore: bootstrap nx workspace`

Result:

```text
Nx + TypeScript + project boundaries
```

## Milestone 2

`feat: add terminal domain and pty abstraction`

Result:

```text
fake PTY + TerminalSession + SessionManager
```

## Milestone 3

`feat: add node-pty runtime`

Result:

```text
real bash PTY
```

## Milestone 4

`feat: add session REST api`

Result:

```text
create/list/get/delete
```

## Milestone 5

`feat: add terminal websocket protocol`

Result:

```text
interactive terminal transport
```

## Milestone 6

`feat: add xterm web client`

Result:

```text
browser terminal
```

## Milestone 7

`feat: support terminal replay`

Result:

```text
reconnectable terminal
```

## Milestone 8

`feat: support multiple terminal clients`

Result:

```text
shared terminal session
```

## Milestone 9

`chore: harden terminal runtime`

Result:

```text
bounded + observable + graceful
```

---

# Final V1 architecture

```text
                         ┌──────────────────┐
                         │     Browser      │
                         │                  │
                         │  xterm.js        │
                         │  Session UI      │
                         └───────┬──────────┘
                                 │
                         HTTP / WebSocket
                                 │
                                 ▼
┌───────────────────────────────────────────────────────┐
│                    apps/server                        │
│                                                       │
│  Fastify REST              WebSocket Gateway          │
│       │                           │                   │
│       └─────────────┬─────────────┘                   │
│                     ▼                                 │
│              SessionManager                           │
│                     │                                 │
│              TerminalSession                          │
│                     │                                 │
│               PtyProcess                              │
└─────────────────────┼─────────────────────────────────┘
                      │
                      ▼
              packages/terminal-pty
                      │
                      ▼
                   node-pty
                      │
                      ▼
                bash / zsh / sh


Shared:
  packages/api-contract
  packages/terminal-protocol

Domain:
  packages/terminal-core
```

This structure deliberately keeps the first version simple while preserving the extension points needed for authentication, workspaces, containers, and AI-agent runtimes later.

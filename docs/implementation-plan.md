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

- [ ] Create Nx workspace.
- [ ] Configure TypeScript.
- [ ] Configure package-manager workspaces.
- [ ] Create `apps/server`.
- [ ] Create `apps/web`.
- [ ] Create `packages/terminal-core`.
- [ ] Create `packages/terminal-pty`.
- [ ] Create `packages/terminal-protocol`.
- [ ] Create `packages/api-contract`.
- [ ] Configure project references.
- [ ] Configure linting.
- [ ] Configure unit testing.
- [ ] Configure formatting.
- [ ] Verify `nx graph`.
- [ ] Verify all projects are recognized.
- [ ] Add basic CI command.

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

- [ ] Define `SessionId`.
- [ ] Define `TerminalSessionStatus`.
- [ ] Define `CreateSessionRequest`.
- [ ] Define `TerminalSessionResponse`.
- [ ] Define `ListSessionsResponse`.
- [ ] Define API error shape.
- [ ] Define WebSocket client messages.
- [ ] Define WebSocket server messages.
- [ ] Add Zod schemas.
- [ ] Add protocol tests.
- [ ] Define protocol versioning strategy.

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

- [ ] Define `PtyProcess`.
- [ ] Define `PtyFactory`.
- [ ] Define PTY events.
- [ ] Define spawn options.
- [ ] Define fake PTY for tests.
- [ ] Add unit tests around the fake.
- [ ] Document PTY ownership and lifecycle.

## Acceptance criteria

`terminal-core` compiles and tests without importing `node-pty`.

---

# Phase 4 — Implement node-pty adapter

## Goal

Connect the abstraction to a real operating-system PTY.

## Tasks

- [ ] Add `node-pty`.
- [ ] Implement `NodePtyFactory`.
- [ ] Map shell names to executables.
- [ ] Spawn PTY with configured dimensions.
- [ ] Forward PTY output.
- [ ] Forward input.
- [ ] Implement resize.
- [ ] Implement kill.
- [ ] Forward exit event.
- [ ] Validate working directory.
- [ ] Add platform handling.
- [ ] Add integration test.

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

- [ ] Create session ID generator.
- [ ] Implement session state.
- [ ] Connect PTY output to session.
- [ ] Implement `write`.
- [ ] Implement `resize`.
- [ ] Implement `terminate`.
- [ ] Track PID.
- [ ] Track timestamps.
- [ ] Track exit code.
- [ ] Track exit state.
- [ ] Add lifecycle events.
- [ ] Reject writes after exit.
- [ ] Make termination idempotent.

## Unit tests

- [ ] starts in `starting`.
- [ ] becomes `running`.
- [ ] writes input.
- [ ] resizes PTY.
- [ ] receives output.
- [ ] exits.
- [ ] records exit code.
- [ ] termination kills PTY.
- [ ] repeated termination is safe.

---

# Phase 6 — Implement SessionManager

## Goal

Manage all active sessions.

## Tasks

- [ ] Add in-memory session map.
- [ ] Implement `create`.
- [ ] Implement `get`.
- [ ] Implement `list`.
- [ ] Implement `terminate`.
- [ ] Implement max-session limit.
- [ ] Remove exited sessions according to lifecycle policy.
- [ ] Implement shutdown.
- [ ] Add manager tests.

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

- [ ] Bootstrap Fastify.
- [ ] Add `/health`.
- [ ] Add `POST /api/v1/sessions`.
- [ ] Add `GET /api/v1/sessions`.
- [ ] Add `GET /api/v1/sessions/:id`.
- [ ] Add `DELETE /api/v1/sessions/:id`.
- [ ] Validate request bodies.
- [ ] Map domain errors to HTTP errors.
- [ ] Add response serialization.
- [ ] Add API tests.
- [ ] Add CORS configuration appropriate for development.

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

- [ ] Add WebSocket server.
- [ ] Implement session route.
- [ ] Validate session ID.
- [ ] Validate incoming messages.
- [ ] Attach clients.
- [ ] Route input to PTY.
- [ ] Route resize to PTY.
- [ ] Broadcast output.
- [ ] Send status.
- [ ] Send exit.
- [ ] Handle malformed messages.
- [ ] Handle disconnect.
- [ ] Add heartbeat/ping handling.
- [ ] Add WebSocket tests.

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

- [ ] Implement bounded ring buffer.
- [ ] Configure byte limit.
- [ ] Append PTY output.
- [ ] Replay snapshot on attach.
- [ ] Handle snapshot/live ordering safely.
- [ ] Add tests around buffer truncation.
- [ ] Add reconnect test.

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

- [ ] Create client registry per session.
- [ ] Broadcast output.
- [ ] Broadcast status/exit.
- [ ] Route input from any client.
- [ ] Remove disconnected clients.
- [ ] Ensure one client failure doesn't affect others.
- [ ] Add multi-client integration test.

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

- [ ] Add xterm.js.
- [ ] Add terminal component.
- [ ] Create session API client.
- [ ] Create WebSocket client.
- [ ] Render output.
- [ ] Forward keyboard input.
- [ ] Handle terminal resize.
- [ ] Use `FitAddon`.
- [ ] Display connection state.
- [ ] Display session exit state.
- [ ] Add reconnect action.
- [ ] Add session list.
- [ ] Add create-session action.
- [ ] Add terminate-session action.

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

- [ ] Create session.
- [ ] Open terminal.
- [ ] Run `echo hello`.
- [ ] See output.

### Scenario B — interactive shell

- [ ] Run `cd`.
- [ ] Run `pwd`.
- [ ] Run `ls`.
- [ ] Use arrow keys.
- [ ] Use Ctrl+C.
- [ ] Use tab completion.

### Scenario C — resize

- [ ] Resize browser.
- [ ] Verify PTY dimensions.
- [ ] Run a program that responds to terminal dimensions.

### Scenario D — reconnect

- [ ] Start command.
- [ ] Disconnect browser.
- [ ] Command continues.
- [ ] Reconnect.
- [ ] Recent output is replayed.

### Scenario E — multiple clients

- [ ] Open same session in two browser tabs.
- [ ] Type in one.
- [ ] Observe output in both.

### Scenario F — process exit

- [ ] Run `exit`.
- [ ] Session transitions to exited.
- [ ] Browser receives exit event.

### Scenario G — server shutdown

- [ ] Start sessions.
- [ ] Stop server.
- [ ] Confirm PTYs are terminated.
- [ ] Confirm no orphan processes remain.

---

# Phase 13 — Hardening

## Tasks

- [ ] Validate all API inputs.
- [ ] Bound session count.
- [ ] Bound output history.
- [ ] Bound message size.
- [ ] Bound WebSocket payload size.
- [ ] Validate terminal dimensions.
- [ ] Validate CWD.
- [ ] Restrict supported shells.
- [ ] Avoid logging terminal data.
- [ ] Add structured logging.
- [ ] Add graceful shutdown.
- [ ] Add health endpoint.
- [ ] Add readiness endpoint if deployment requires it.
- [ ] Add error correlation/request IDs.
- [ ] Add metrics hooks.

---

# Phase 14 — Documentation

## Tasks

- [ ] README quickstart.
- [ ] Architecture documentation.
- [ ] REST API documentation.
- [ ] WebSocket protocol documentation.
- [ ] Local development guide.
- [ ] Testing guide.
- [ ] Security warning.
- [ ] Deployment guide.
- [ ] Troubleshooting guide.

The documentation should clearly state that V1 is a trusted/internal terminal service and that exposing host PTYs to untrusted users requires authentication and isolation.

---

# Phase 15 — CI/CD

## Tasks

- [ ] Run formatting check.
- [ ] Run lint.
- [ ] Run typecheck.
- [ ] Run unit tests.
- [ ] Run integration tests.
- [ ] Build server.
- [ ] Build web.
- [ ] Use Nx affected tasks in CI.
- [ ] Cache appropriate build/test outputs.

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

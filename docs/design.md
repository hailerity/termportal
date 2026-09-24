# Remote Terminal Server — Comprehensive Design

## 1. Purpose

Build a reusable TypeScript terminal runtime server that owns real PTY-backed shell sessions and exposes:

- REST APIs for terminal-session lifecycle and management.
- WebSocket APIs for interactive terminal I/O.
- A browser client integration based on xterm.js.
- Session output replay for clients attaching after a session has started.
- Multiple browser clients attached to one session.
- Terminal resize and lifecycle events.

The initial product intentionally excludes **authentication** and **workspaces**. The server is assumed to run in a trusted environment during the first implementation stages.

The architectural boundary is:

> REST manages terminal sessions; WebSocket carries terminal streams; PTY executes the shell; xterm.js renders the terminal.

Nx is used as the monorepo/task-orchestration layer. Nx's TypeScript setup supports package-manager workspaces, project references, affected detection, caching, and a project graph. [Nx TypeScript documentation](https://nx.dev/docs/technologies/typescript/introduction)

---

## 2. Goals

### Functional goals

1. Start a new terminal session.
2. Spawn a real PTY-backed shell.
3. Attach xterm.js to a session through WebSocket.
4. Send keyboard input from browser to PTY.
5. Stream PTY output to one or more browsers.
6. Resize the PTY when the browser terminal changes size.
7. List active sessions.
8. Inspect one session.
9. Terminate a session.
10. Detect shell/process exit.
11. Replay a bounded amount of recent output when a new client attaches.
12. Support session state and lifecycle events.
13. Provide a small, explicit protocol that can evolve without coupling browser code to PTY internals.

### Non-goals for the initial scope

- Authentication/authorization.
- User accounts.
- Workspaces.
- Repository/worktree management.
- Container orchestration.
- Multi-host scheduling.
- Persistent database storage.
- File APIs.
- AI-agent APIs.
- Shell command execution outside a PTY session.
- Full terminal recording/replay.
- Production-grade multi-tenant isolation.

These can be added later without changing the core terminal abstraction.

---

## 3. Design principles

### 3.1 Terminal session is a first-class resource

A WebSocket connection does not define the lifetime of a terminal.

A session can continue after a browser disconnects:

```text
Browser A ── WebSocket ──> Session ──> PTY ──> Shell
    X
disconnect

Session ───────────────────────────────> PTY ──> Shell

Browser B ── WebSocket ────────────────> Session
```

### 3.2 Separate control plane and data plane

REST is the control plane:

```text
create
list
get
delete
```

WebSocket is the interactive data plane:

```text
input
output
resize
status
exit
```

### 3.3 Keep PTY implementation behind an abstraction

The rest of the application should not depend directly on `node-pty`.

```text
TerminalSession
      |
      v
PtyAdapter
      |
      v
node-pty
```

This makes testing easier and leaves room for alternative runtimes later.

### 3.4 Keep the protocol explicit

Do not expose raw WebSocket strings as an undocumented convention. Define message types and schemas.

### 3.5 Prefer in-memory state initially

The first version should avoid introducing Redis or a database. Sessions are runtime state and can be represented by an in-memory `Map`.

Persistence can be introduced when there is a concrete requirement.

---

# 4. High-level architecture

```text
                         Browser
                ┌──────────────────────┐
                │ Terminal UI           │
                │                      │
                │ xterm.js              │
                │ session management UI │
                └──────────┬───────────┘
                           │
                    HTTP + WebSocket
                           │
                           v
              ┌────────────────────────────┐
              │       Terminal Server      │
              │                            │
              │ REST Controllers           │
              │ WebSocket Gateway          │
              │            │               │
              │            v               │
              │      Session Manager       │
              │            │               │
              │     ┌──────┼──────┐        │
              │     v      v      v        │
              │   Session Session Session  │
              │      │      │      │       │
              │     PTY    PTY    PTY       │
              └──────┼──────┼──────┼───────┘
                     │      │      │
                     v      v      v
                   bash   zsh    bash
```

---

# 5. Nx monorepo structure

Recommended initial structure:

```text
terminal-runtime/
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── main.ts
│   │       ├── app.ts
│   │       ├── config/
│   │       ├── http/
│   │       └── websocket/
│   │
│   └── web/
│       └── src/
│           ├── main.tsx
│           ├── app/
│           ├── features/
│           └── components/
│
├── packages/
│   ├── terminal-core/
│   │   └── src/
│   │       ├── domain/
│   │       ├── ports/
│   │       └── services/
│   │
│   ├── terminal-pty/
│   │   └── src/
│   │       └── node-pty-adapter.ts
│   │
│   ├── terminal-protocol/
│   │   └── src/
│   │       ├── messages.ts
│   │       └── schemas.ts
│   │
│   └── api-contract/
│       └── src/
│           ├── sessions.ts
│           └── errors.ts
│
├── docs/
│   ├── design.md
│   └── implementation-plan.md
│
├── nx.json
├── package.json
├── tsconfig.base.json
└── tsconfig.json
```

The exact frontend stack is deliberately not part of the server architecture. React + Vite is a reasonable choice if a browser demo is wanted.

Nx recommends grouped application/library structures and can maintain TypeScript project references from the project graph. [Nx folder structure](https://nx.dev/docs/kb/folder-structure) [Nx TypeScript project linking](https://nx.dev/docs/kb/typescript-project-linking)

## Project responsibilities

### `apps/server`

Composition root.

Responsible for:

- HTTP server.
- REST routes.
- WebSocket server.
- dependency wiring.
- configuration.
- process startup/shutdown.

It should not contain the core terminal business logic.

### `apps/web`

Reference browser client.

Responsible for:

- xterm.js rendering.
- session list.
- session creation.
- session selection.
- WebSocket connection.
- resize handling.

### `packages/terminal-core`

Framework-independent domain/application logic.

Responsible for:

- `TerminalSession`.
- `SessionManager`.
- lifecycle.
- client attachment.
- output buffering.
- PTY port interfaces.

### `packages/terminal-pty`

Infrastructure implementation of the PTY port using `node-pty`.

`node-pty` provides pseudoterminal bindings for Node.js and is explicitly suitable for terminal emulators such as xterm.js. [node-pty](https://github.com/microsoft/node-pty)

### `packages/terminal-protocol`

WebSocket protocol types and runtime validation.

### `packages/api-contract`

HTTP DTOs and API error contracts.

---

# 6. Domain model

## TerminalSession

```ts
interface TerminalSession {
  id: string;
  status: TerminalSessionStatus;
  shell: string;
  cwd: string;
  pid?: number;
  cols: number;
  rows: number;
  createdAt: string;
  lastActivityAt: string;
  exitCode?: number;
  exitSignal?: number;
}
```

Status:

```ts
type TerminalSessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "terminating"
  | "failed";
```

The in-memory domain object should also contain internal runtime state that is not exposed through the HTTP DTO.

---

# 7. PTY abstraction

Define a narrow port:

```ts
interface PtyProcess {
  readonly pid: number;

  write(data: string): void;

  resize(cols: number, rows: number): void;

  kill(signal?: string): void;

  onData(handler: (data: string) => void): Unsubscribe;

  onExit(handler: (event: PtyExitEvent) => void): Unsubscribe;
}
```

Factory:

```ts
interface PtyFactory {
  spawn(options: SpawnPtyOptions): PtyProcess;
}
```

The `terminal-core` package depends on this interface, not on `node-pty`.

---

# 8. Session manager

The central application service:

```ts
interface SessionManager {
  create(options: CreateSessionOptions): Promise<TerminalSession>;
  get(id: string): TerminalSession | undefined;
  list(): TerminalSession[];
  terminate(id: string): Promise<void>;
  attach(id: string, client: TerminalClient): Promise<void>;
}
```

Internally:

```text
Map<SessionId, ManagedTerminalSession>
```

The manager is responsible for:

- generating IDs.
- creating PTYs.
- tracking lifecycle.
- routing PTY output.
- routing client input.
- broadcasting output.
- resizing.
- disconnecting clients.
- cleanup after process exit.
- maintaining bounded output history.

---

# 9. Session lifecycle

```text
                 create
                   |
                   v
              STARTING
                   |
              PTY created
                   |
                   v
               RUNNING
              /        \
             /          \
        shell exits    delete
           |              |
           v              v
         EXITED      TERMINATING
                          |
                       kill PTY
                          |
                          v
                       EXITED
```

A session should emit a final exit event and then become unavailable for new interactive attachment.

---

# 10. REST API

Base path:

```text
/api/v1
```

## Create session

```http
POST /api/v1/sessions
Content-Type: application/json
```

Request:

```json
{
  "shell": "bash",
  "cwd": "/tmp",
  "cols": 120,
  "rows": 40,
  "env": {
    "TERM": "xterm-256color"
  }
}
```

All fields except the server-defined defaults should be optional.

Response:

```json
{
  "id": "term_01...",
  "status": "running",
  "shell": "/bin/bash",
  "cwd": "/tmp",
  "pid": 12345,
  "cols": 120,
  "rows": 40,
  "createdAt": "2026-09-20T15:00:00.000Z",
  "lastActivityAt": "2026-09-20T15:00:00.000Z"
}
```

## List

```http
GET /api/v1/sessions
```

Response:

```json
{
  "sessions": []
}
```

## Get

```http
GET /api/v1/sessions/:id
```

## Terminate

```http
DELETE /api/v1/sessions/:id
```

Expected successful response:

```http
204 No Content
```

---

# 11. WebSocket API

Endpoint:

```text
WS /api/v1/sessions/:id/terminal
```

## Client → server

### Input

```json
{
  "type": "input",
  "data": "ls -la\r"
}
```

### Resize

```json
{
  "type": "resize",
  "cols": 160,
  "rows": 50
}
```

### Ping

```json
{
  "type": "ping"
}
```

## Server → client

### Output

```json
{
  "type": "output",
  "data": "\u001b[32mhello\u001b[0m\r\n"
}
```

### Status

```json
{
  "type": "status",
  "status": "running"
}
```

### Exit

```json
{
  "type": "exit",
  "exitCode": 0
}
```

### Error

```json
{
  "type": "error",
  "code": "SESSION_NOT_FOUND",
  "message": "Terminal session was not found."
}
```

### Pong

```json
{
  "type": "pong"
}
```

---

# 12. WebSocket connection lifecycle

When a client connects:

```text
1. Parse session ID.
2. Find session.
3. Reject if missing/exited.
4. Register client.
5. Send current session status.
6. Send bounded output replay.
7. Start live output stream.
```

When client sends input:

```text
WebSocket
   |
   v
validate message
   |
   v
session.write(data)
   |
   v
PTY
```

When PTY emits output:

```text
PTY
 |
 v
Session
 |
 +--> output buffer
 |
 +--> client A
 +--> client B
 +--> client C
```

When client disconnects:

```text
remove client
```

Do **not** terminate the session automatically unless an explicit future policy enables that behavior.

---

# 13. Output replay buffer

Each session maintains a bounded ring buffer.

Example:

```ts
interface OutputBuffer {
  append(data: string): void;
  snapshot(): string;
  clear(): void;
}
```

Recommended initial limit:

```text
1–5 MB per session
```

The exact value should be configurable.

The buffer is deliberately bounded so a long-running process cannot cause unbounded memory growth.

Replay ordering:

```text
client connects
      |
      v
status
      |
      v
buffer snapshot
      |
      v
live output
```

The implementation must prevent an output gap between snapshot and live subscription.

---

# 14. Multiple clients

A session may have multiple WebSocket clients.

```text
                  ┌── Client A
                  │
PTY ─ Session ────┼── Client B
                  │
                  └── Client C
```

Output is broadcast to all clients.

Input from any writable client is sent to the same PTY.

Read-only attachment can be introduced later.

---

# 15. Resize semantics

A PTY has one terminal size, but multiple browser clients may have different dimensions.

Therefore, V1 should define a simple rule:

> The most recently received resize becomes the session's PTY size.

This is easy to understand but has an important limitation: two clients with different window sizes will compete.

Later options:

- one active controller client.
- per-client virtual terminal dimensions.
- read-only clients.
- explicit session ownership.
- separate PTYs per attachment.

Do not solve these complexities in V1.

---

# 16. Shell configuration

Do not allow arbitrary executable paths through the public API.

Use named shells:

```ts
type ShellType = "bash" | "zsh" | "sh";
```

Server configuration maps these to actual executables.

Example:

```ts
const shellMap = {
  bash: "/bin/bash",
  zsh: "/bin/zsh",
  sh: "/bin/sh",
};
```

Default:

```text
bash on Linux
zsh on macOS
```

The server should validate that the requested working directory exists and is a directory.

---

# 17. Environment handling

Request environment should be merged with a controlled base environment.

Avoid blindly replacing the entire server environment.

Example:

```text
process environment
        +
safe overrides
        =
PTY environment
```

The server should explicitly decide which variables can be overridden.

---

# 18. Error model

Use stable machine-readable error codes.

Examples:

```text
SESSION_NOT_FOUND
SESSION_ALREADY_EXITED
INVALID_SESSION_ID
INVALID_SHELL
INVALID_CWD
INVALID_DIMENSIONS
INVALID_MESSAGE
PTY_SPAWN_FAILED
SESSION_TERMINATION_FAILED
```

HTTP example:

```json
{
  "error": {
    "code": "INVALID_SHELL",
    "message": "Unsupported shell."
  }
}
```

Do not expose stack traces or internal filesystem details through API responses.

---

# 19. Security boundary

Although authentication is out of scope, the architecture must still acknowledge the risk.

A terminal API can effectively execute commands with the server process's operating-system privileges.

Therefore V1 should be documented as:

> Trusted/internal deployment only.

Security-sensitive controls to implement or document before public exposure:

- authentication.
- authorization.
- container isolation.
- resource limits.
- filesystem restrictions.
- process limits.
- environment restrictions.
- command/shell policy.
- network egress policy.
- audit logging.

Container isolation should be considered before exposing arbitrary users to host PTYs.

---

# 20. Server shutdown

On SIGINT/SIGTERM:

```text
server shutdown
      |
      v
stop accepting HTTP/WS
      |
      v
SessionManager.shutdown()
      |
      v
terminate active PTYs
      |
      v
wait for cleanup
      |
      v
process exits
```

Do not leave orphaned shells behind.

A configurable graceful shutdown timeout should be used.

---

# 21. Observability

V1 logging should include:

- server start/stop.
- session created.
- session terminated.
- PTY spawn failure.
- PTY exit.
- WebSocket connected.
- WebSocket disconnected.
- WebSocket protocol error.

Avoid logging terminal input/output by default because it may contain secrets.

Useful metrics later:

```text
active_sessions
session_created_total
session_exited_total
websocket_connections
pty_spawn_failures
session_duration
output_bytes
input_bytes
```

---

# 22. Testing strategy

## Unit tests

`terminal-core` should be heavily unit tested using a fake PTY.

Test:

- create session.
- lifecycle transitions.
- write input.
- resize.
- output broadcast.
- multiple clients.
- client disconnect.
- output buffering.
- process exit.
- termination.
- repeated termination.
- invalid state transitions.

## Integration tests

Use a real PTY.

Test:

```text
create
  -> attach
  -> write "echo hello"
  -> receive "hello"
  -> resize
  -> terminate
```

## API tests

Test all REST endpoints.

## WebSocket tests

Test:

- connection.
- protocol validation.
- input.
- output.
- resize.
- exit.
- disconnect.
- session-not-found.

## Browser E2E

The browser application should verify:

1. Create session.
2. Terminal appears.
3. Type command.
4. See output.
5. Resize browser.
6. Refresh/reconnect.
7. See replayed output.
8. Terminate session.

---

# 23. Dependency boundaries

Desired dependency graph:

```text
apps/web
   |
   v
api-contract + terminal-protocol

apps/server
   |
   +--> api-contract
   +--> terminal-protocol
   +--> terminal-core
   +--> terminal-pty
             |
             v
          node-pty

terminal-core
   |
   +--> api-independent domain
   +--> Pty interfaces
```

The core package must not import:

- Express/Fastify.
- WebSocket library.
- xterm.js.
- node-pty.

This keeps the core portable and testable.

---

# 24. Configuration

Environment variables:

```text
HOST=127.0.0.1
PORT=24001

DEFAULT_SHELL=bash
DEFAULT_CWD=/tmp

DEFAULT_COLS=120
DEFAULT_ROWS=40

OUTPUT_BUFFER_BYTES=5242880

SHUTDOWN_TIMEOUT_MS=10000

MAX_SESSIONS=100
```

`MAX_SESSIONS` should be configurable even in trusted deployments.

---

# 25. Future architecture

The initial design intentionally leaves extension points.

Future:

```text
                     Runtime Server
                          |
        ┌─────────────────┼─────────────────┐
        |                 |                 |
    Workspace          Terminal          Process
        |                 |                 |
     worktree            PTY             subprocess
        |                 |                 |
        └─────────────────┼─────────────────┘
                          |
                     Container
```

Authentication can later wrap the HTTP/WebSocket layer without changing `terminal-core`.

Workspaces can later become a resource that supplies `cwd` and environment to terminal sessions.

Container execution can replace the PTY infrastructure implementation while keeping the session abstraction.

---

# 26. Definition of done for V1

The system is considered complete when:

- `nx serve server` starts the server.
- `nx serve web` starts the browser client.
- Browser can create a terminal.
- Browser can interact with bash through xterm.js.
- Terminal supports ANSI output and interactive programs.
- Browser resize changes PTY dimensions.
- Multiple browser tabs can attach to one session.
- Session survives browser disconnect.
- Session list shows active sessions.
- Session can be terminated.
- Shell exit is reflected in session state.
- New attachments receive bounded recent output.
- REST and WebSocket contracts have automated tests.
- Core logic has unit tests using a fake PTY.
- Integration tests exercise a real PTY.
- Server shuts down without orphaning sessions.
- README documents trusted/internal deployment limitations.

---

# 27. Technology decisions

| Area | Choice |
|---|---|
| Monorepo | Nx |
| Language | TypeScript |
| Runtime | Node.js |
| PTY | node-pty |
| Browser terminal | xterm.js |
| HTTP | Fastify |
| WebSocket | ws |
| Validation | Zod |
| Unit tests | Vitest |
| Browser E2E | Playwright |
| State | In-memory |
| Persistence | None |
| Authentication | Out of scope |
| Workspaces | Out of scope |
| Containers | Out of scope for V1 |

Nx is used for project/task orchestration rather than as an application framework. It provides project graph, task orchestration, caching and affected-task capabilities. [Nx project graph](https://nx.dev/docs/features/explore-graph)

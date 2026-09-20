# API reference

Base path: `/api/v1`. The REST API is the control plane; the WebSocket endpoint is the data
plane. Both are versioned by the path prefix: within `v1` changes are additive only (new
optional fields, new message types); anything breaking ships as `/api/v2`.

Browser requests must come from an origin listed in `ALLOWED_ORIGINS`, otherwise they get
`403 ORIGIN_NOT_ALLOWED` (HTTP) or a refused upgrade (WebSocket). Requests without an `Origin`
header are accepted. There is no authentication — see the security warning in the README.

## Session object

```json
{
  "id": "term_et7eErjkYtyj3JhwNbJa9F",
  "status": "running",
  "shell": "/bin/bash",
  "cwd": "/tmp",
  "pid": 12345,
  "cols": 120,
  "rows": 40,
  "createdAt": "2026-09-20T15:00:00.000Z",
  "lastActivityAt": "2026-09-20T15:00:00.000Z",
  "exitCode": 0,
  "exitSignal": 1
}
```

`status` is one of `starting`, `running`, `terminating`, `exited`, `failed`. `pid` is absent
before the PTY exists; `exitCode`/`exitSignal` appear once the process has exited.

## REST

| Method & path             | Success          | Notes                                                |
| ------------------------- | ---------------- | ---------------------------------------------------- |
| `POST /sessions`          | `201` + session  | `Location` header points at the new session          |
| `GET /sessions`           | `200 {sessions}` | includes recently exited sessions                    |
| `GET /sessions/:id`       | `200` + session  |                                                      |
| `DELETE /sessions/:id`    | `204`            | waits for the process to exit, then forgets the session |
| `GET /health`             | `200`            | liveness                                             |
| `GET /ready`              | `200` / `503`    | `503` once shutdown has begun                        |
| `GET /metrics`            | `200` text       | Prometheus text format                               |

### Create session

Every field is optional; an absent body means all defaults. Unknown fields are rejected.

```json
{
  "shell": "bash",
  "cwd": "/tmp",
  "cols": 120,
  "rows": 40,
  "env": { "TERM": "xterm-256color" }
}
```

- `shell` — `bash`, `zsh` or `sh`. Never a path: the server maps names to the executables
  installed on the host.
- `cwd` — absolute path of an existing directory.
- `cols` 2–1000, `rows` 1–500.
- `env` — overrides merged onto the server's base environment. Only `TERM`, `COLORTERM`,
  `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `EDITOR`, `VISUAL` and `PAGER` may be overridden; anything
  else (`PATH`, `LD_PRELOAD`, …) is `INVALID_ENV`.

Only `application/json` bodies are parsed (max 64 KB).

### Exited sessions

A session whose shell exits stays listed with `status: "exited"` for `EXITED_SESSION_TTL_MS`
(5 minutes by default) so clients can observe its final state, then disappears. It no longer
counts against `MAX_SESSIONS`. `DELETE` removes it immediately.

### Errors

```json
{ "error": { "code": "INVALID_SHELL", "message": "Unsupported shell.", "requestId": "…" } }
```

`requestId` matches the `X-Request-Id` response header; a well-formed `X-Request-Id` request
header is reused. Messages never contain stack traces or filesystem details.

| Code                         | HTTP | Meaning                                              |
| ---------------------------- | ---- | ---------------------------------------------------- |
| `INVALID_REQUEST`            | 400\* | malformed JSON, unknown field, wrong content type   |
| `INVALID_SESSION_ID`         | 400  | id is not of the form `term_…`                       |
| `INVALID_SHELL`              | 400  | unknown or uninstalled shell                         |
| `INVALID_CWD`                | 400  | not an absolute path to an existing directory        |
| `INVALID_DIMENSIONS`         | 400  | cols/rows out of range or not integers               |
| `INVALID_ENV`                | 400  | bad variable name, or variable not overridable       |
| `ORIGIN_NOT_ALLOWED`         | 403  | browser origin not in `ALLOWED_ORIGINS`              |
| `SESSION_NOT_FOUND`          | 404  |                                                      |
| `NOT_FOUND`                  | 404  | unknown route                                        |
| `SESSION_ALREADY_EXITED`     | 409  | the session can no longer be used interactively      |
| `SESSION_LIMIT_REACHED`      | 429  | `MAX_SESSIONS` live sessions exist, or shutting down |
| `CLIENT_LIMIT_REACHED`       | 429  | too many clients attached to the session (WebSocket) |
| `PTY_SPAWN_FAILED`           | 500  |                                                      |
| `SESSION_TERMINATION_FAILED` | 500  | the process survived SIGKILL; the session remains    |
| `INTERNAL_ERROR`             | 500  |                                                      |
| `INVALID_MESSAGE`            | —    | WebSocket only                                       |

\* `413` for an oversized body and `415` for a non-JSON content type, with the same code.

## WebSocket

```text
WS /api/v1/sessions/:id/terminal
```

All frames are JSON text. Binary frames are rejected.

On connect the server sends, in this order and without gaps or duplicates:

1. `status` — the session's current status
2. `output` — one message with the buffered recent output, if any (replay)
3. live `output`, `status` and `exit` messages

The upgrade is completed even when the session is unusable, so that browsers can read the
reason: the server sends an `error` message and closes with an application code.

### Client → server

```json
{ "type": "input", "data": "ls -la\r" }
{ "type": "resize", "cols": 160, "rows": 50 }
{ "type": "ping" }
```

`input.data` is 1–65 536 UTF-16 code units; split larger pastes into several messages. A frame
may not exceed 256 KiB. The most recent `resize` from any client sets the PTY size.

### Server → client

```json
{ "type": "output", "data": "\u001b[32mhello\u001b[0m\r\n" }
{ "type": "status", "status": "running" }
{ "type": "exit", "exitCode": 0, "signal": 1 }
{ "type": "error", "code": "INVALID_MESSAGE", "message": "…" }
{ "type": "pong" }
```

`exit.signal` is present only when the process was signalled. After `exit` the server closes
the socket with `1000`. Clients must ignore message types they do not know.

An invalid client message is answered with `error` / `INVALID_MESSAGE` and the connection
stays open; 20 consecutive invalid messages close it. Input sent while the session is not
running is answered with `SESSION_ALREADY_EXITED`.

### Close codes

| Code   | Meaning                                                        | Reconnect? |
| ------ | -------------------------------------------------------------- | ---------- |
| `1000` | session exited                                                 | no         |
| `1001` | server shutting down                                           | later      |
| `1008` | too many invalid messages                                      | fix client |
| `1009` | frame larger than 256 KiB                                      | fix client |
| `1013` | client too slow to drain output | yes |
| `4400` | invalid session id                                             | no         |
| `4404` | session not found                                              | no         |
| `4409` | session already exited                                         | no         |
| `4429` | session already has `MAX_CLIENTS_PER_SESSION` clients | no\* |

\* The limit is transient, but a full session cannot be joined by retrying right away: treat
`4429` like the other `4xxx` codes and let the user retry once another client has left.

Closing the socket never terminates the session; only `DELETE` or the shell exiting does.
The server pings every 30 s and drops peers that stop answering.

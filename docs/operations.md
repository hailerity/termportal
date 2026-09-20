# Operations

## Configuration

All configuration is read from environment variables at startup; an invalid value aborts
startup with a message naming the variable.

| Variable                  | Default                                        | Meaning                                                             |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `HOST`                    | `127.0.0.1`                                    | bind address                                                        |
| `PORT`                    | `3000`                                         | bind port (`0` = ephemeral)                                         |
| `DEFAULT_SHELL`           | `zsh` on macOS, `bash` elsewhere               | `bash`, `zsh` or `sh`; must be installed                            |
| `DEFAULT_CWD`             | `/tmp`                                         | working directory when a request names none                         |
| `DEFAULT_COLS` / `_ROWS`  | `120` / `40`                                   | initial PTY size                                                    |
| `OUTPUT_BUFFER_BYTES`     | `5242880`                                      | replay buffer per session, UTF-8 bytes, max 16 MiB; `0` disables    |
| `MAX_SESSIONS`            | `100`                                          | live sessions                                                       |
| `MAX_CLIENTS_PER_SESSION` | `32`                                           | WebSocket clients attached to one session                           |
| `EXITED_SESSION_TTL_MS`   | `300000`                                       | how long an exited session stays listed                             |
| `SHUTDOWN_TIMEOUT_MS`     | `10000`                                        | grace period before PTYs are force-killed on shutdown               |
| `ALLOWED_ORIGINS`         | `http://localhost:4200,http://127.0.0.1:4200`  | comma-separated browser origins; `*` disables the check             |
| `LOG_LEVEL`               | `info`                                         | pino level, or `silent`                                             |

Memory: budget roughly `MAX_SESSIONS × OUTPUT_BUFFER_BYTES` for replay buffers, plus up to
about six times the buffer per slow WebSocket client for queued frames.

These variables — except the generic `HOST` and `LOG_LEVEL` — are removed from the environment
handed to shells, so a shell does not inherit the server's `PORT`. Everything else in the server's environment is inherited; start the server
with a minimal environment if that matters.

## Deployment

**Read the security warning in the README first.** V1 is for trusted, internal use: no
authentication, no isolation, commands run as the server's user.

```bash
npm ci
npx nx run-many -t build -p server web
NODE_ENV=production node apps/server/dist/main.js     # API
# apps/web/dist is a static site; serve it with any web server
```

Recommended shape:

- Run as a dedicated unprivileged user, ideally inside a container or VM whose filesystem and
  network are all a session should ever be able to touch.
- Keep `HOST=127.0.0.1` and put a reverse proxy in front that terminates TLS **and
  authenticates every request**, including the WebSocket upgrade.
- The proxy must forward upgrades for `/api/v1/sessions/*/terminal` and should not buffer or
  time out idle connections below the 30 s heartbeat.
- Set `ALLOWED_ORIGINS` to exactly the origin(s) serving the web client. If the client and the
  API share an origin, list that origin — the server deliberately does not infer it from the
  `Host` header, which is attacker-controlled under DNS rebinding.
- Use `/health` for liveness and `/ready` for readiness (it turns `503` during shutdown).
- Send `SIGTERM` to stop. The server stops accepting sessions, sends every shell `SIGHUP`,
  escalates to `SIGKILL` after `SHUTDOWN_TIMEOUT_MS`, and exits non-zero if a process survived.
  A second signal exits immediately. Give the orchestrator a stop timeout above
  `SHUTDOWN_TIMEOUT_MS` + 10 s.
- Set OS-level limits (`ulimit`, cgroups) for processes, memory and CPU: `MAX_SESSIONS` bounds
  shells, not what runs inside them.

Controls that V1 does not provide and that are required before exposing it to untrusted users:
authentication, authorization, per-user isolation, resource and process limits, filesystem
restrictions, environment restrictions, command/shell policy, network-egress policy, audit
logging.

## Observability

Logs are JSON lines (pino) on stdout: server start/stop, session created/terminating/exited/
removed, PTY spawn failures, WebSocket connected/disconnected, origin rejections and protocol
errors, plus one line per HTTP request with its request id. **Terminal input and output are
never logged**, and invalid WebSocket payloads are not echoed into logs, because both can
contain secrets.

`GET /metrics` serves Prometheus text:

```text
termportal_active_sessions
termportal_session_created_total
termportal_session_exited_total
termportal_pty_spawn_failures_total
termportal_session_duration_seconds_total
termportal_websocket_connections
termportal_websocket_connections_total
termportal_websocket_protocol_errors_total
```

## Troubleshooting

**`posix_spawnp failed` when creating a session (macOS).** node-pty's prebuilt `spawn-helper`
lost its executable bit. `npm install` repairs it through `scripts/fix-node-pty.mjs`; run
`node scripts/fix-node-pty.mjs` if you installed with `--ignore-scripts`.

**npm warns that install scripts are not covered by `allowScripts`.** Recent npm versions run
dependency install scripts only when approved. The repository approves `node-pty`, `esbuild`
and `nx` in `package.json`; after upgrading one of them run `npm approve-scripts <name>`.

**`node-pty` fails to build on Linux.** It compiles from source there: install `python3`,
`make` and a C++ compiler (`build-essential`).

**The browser shows "Origin is not allowed" or the terminal never connects.** The page's
origin is not in `ALLOWED_ORIGINS`. `http://localhost:4200` and `http://127.0.0.1:4200` are
different origins. Check the server log for `websocket origin rejected`.

**`INVALID_SHELL` for `bash` or `zsh`.** The shell is not installed at a known location; the
startup log line `server started` lists the shells that were found.

**`429 SESSION_LIMIT_REACHED`.** `MAX_SESSIONS` live sessions exist. List them with
`GET /api/v1/sessions` and `DELETE` the ones you no longer need.

**The terminal is disconnected with close code `1013`.** The client could not keep up with
the output (for example a throttled background tab during `yes`). Reconnect; the session is unaffected.
Code `4429` means the session already has `MAX_CLIENTS_PER_SESSION` clients.

**After reconnecting, a full-screen program (vim, htop) looks garbled.** Replay is a byte
history, not a screen snapshot. Press `Ctrl+L` or resize the window to make the program redraw.

**Two tabs keep resizing each other.** One PTY has one size and the most recent resize wins
(design §15). Give both windows the same size.

**Shells are still running after the server died.** That only happens after `SIGKILL` or a
crash, which skip the shutdown sequence; the kernel normally hangs the shells up when the PTY
master closes. Check with `ps -o pid,ppid,tty,comm`.

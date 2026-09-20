import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config/config.js';
import { startServer, type RunningServer } from './runtime.js';
import { TestTerminalClient } from './testing/ws-client.js';

let server: RunningServer | undefined;

async function start(env: Record<string, string> = {}) {
  server = await startServer({
    config: loadConfig({ PORT: '0', DEFAULT_SHELL: 'sh', SHUTDOWN_TIMEOUT_MS: '3000', ...env }),
  });
  const http = `http://127.0.0.1:${server.port}`;
  const createSession = async (body: object = {}) => {
    const response = await fetch(`${http}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; pid: number };
  };
  const connect = (id: string) =>
    TestTerminalClient.connect(`ws://127.0.0.1:${server!.port}/api/v1/sessions/${id}/terminal`);
  return { http, createSession, connect };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('server with a real PTY', () => {
  it('runs the full flow: connect, status, input, output, resize, terminate, exit', async () => {
    const { http, createSession, connect } = await start();
    const { id, pid } = await createSession({ cols: 80, rows: 24 });
    const client = await connect(id);

    await client.waitFor((m) => m.type === 'status' && m.status === 'running');
    client.send({ type: 'input', data: 'echo hello-$((40+2))\r' });
    await client.waitForOutput(/hello-42/);

    client.send({ type: 'resize', cols: 132, rows: 43 });
    client.send({ type: 'input', data: 'stty size\r' });
    await client.waitForOutput(/43 132/);

    const response = await fetch(`${http}/api/v1/sessions/${id}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    await client.waitFor((m) => m.type === 'exit');
    expect((await client.closed).code).toBe(1000);
    expect(isAlive(pid)).toBe(false);
  });

  it('reflects a shell that exits by itself', async () => {
    const { http, createSession, connect } = await start();
    const { id } = await createSession();
    const client = await connect(id);
    await client.waitFor((m) => m.type === 'status');
    client.send({ type: 'input', data: 'exit 3\r' });
    expect(await client.waitFor((m) => m.type === 'exit')).toEqual({ type: 'exit', exitCode: 3 });
    const session = (await (await fetch(`${http}/api/v1/sessions/${id}`)).json()) as object;
    expect(session).toMatchObject({ status: 'exited', exitCode: 3 });
  });

  it('leaves no orphaned shells behind on shutdown', async () => {
    const { createSession, connect } = await start();
    const first = await createSession();
    const second = await createSession();
    const client = await connect(first.id);
    await client.waitFor((m) => m.type === 'status');

    await expect(server!.stop()).resolves.toEqual([]);
    expect(isAlive(first.pid)).toBe(false);
    expect(isAlive(second.pid)).toBe(false);
    expect(client.messages.some((m) => m.type === 'exit')).toBe(true);
    await client.closed;
  });
});

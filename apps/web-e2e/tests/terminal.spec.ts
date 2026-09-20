import { expect, test, type Page } from '@playwright/test';

const API = '/api/v1/sessions';

/** Text currently shown by xterm (DOM renderer rows). */
async function terminalText(page: Page): Promise<string> {
  return page.locator('.xterm-rows').innerText();
}

async function run(page: Page, command: string): Promise<void> {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

async function expectOutput(page: Page, pattern: RegExp): Promise<void> {
  await expect.poll(() => terminalText(page), { timeout: 10_000 }).toMatch(pattern);
}

async function createSession(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('connection-state')).toHaveText('connected');
  await expect(page.getByTestId('session-status')).toHaveText('running');
  return (await page.getByTestId('active-session').innerText()).trim();
}

test.afterEach(async ({ request }) => {
  const { sessions } = (await (await request.get(API)).json()) as { sessions: { id: string }[] };
  for (const { id } of sessions) await request.delete(`${API}/${id}`);
});

test('A — creates a session and runs a command', async ({ page }) => {
  const id = await createSession(page);
  expect(id).toMatch(/^term_/);
  await expect(page.getByTestId('session-item')).toHaveCount(1);
  // The arithmetic distinguishes the command's output from the echo of what was typed.
  await run(page, 'echo hello-$((40+2))');
  await expectOutput(page, /hello-42/);
});

test('B — behaves like an interactive shell: cd, colours, Ctrl+C', async ({ page }) => {
  await createSession(page);
  await run(page, 'cd / && pwd && echo cwd-ok');
  await expectOutput(page, /\n\/\n[\s\S]*cwd-ok/);

  await run(page, "printf '\\033[32mgreen-text\\033[0m\\n'");
  // The output line holds the bare text: xterm interpreted the ANSI sequences around it.
  await expectOutput(page, /\ngreen-text\n/);

  await run(page, 'sleep 100');
  await page.keyboard.press('Control+C');
  await run(page, 'echo interrupted-$((1+1))');
  await expectOutput(page, /interrupted-2/);
});

test('C — resizing the browser resizes the PTY', async ({ page, request }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  const id = await createSession(page);
  const before = await page.getByTestId('dimensions').innerText();

  await page.setViewportSize({ width: 900, height: 500 });
  await expect(page.getByTestId('dimensions')).not.toHaveText(before);
  const [cols, rows] = (await page.getByTestId('dimensions').innerText()).split('×').map(Number);

  await expect
    .poll(async () => {
      const session = (await (await request.get(`${API}/${id}`)).json()) as {
        cols: number;
        rows: number;
      };
      return [session.cols, session.rows];
    })
    .toEqual([cols, rows]);
  // A program inside the PTY sees the new size.
  await run(page, 'echo size=$(stty size)');
  await expectOutput(page, new RegExp(`size=${rows} ${cols}`));
});

test('D — the session survives a refresh and replays recent output', async ({ page }) => {
  const id = await createSession(page);
  await run(page, '(sleep 1; echo finished-$((6*7))) & echo started-$((1+2))');
  await expectOutput(page, /started-3/);

  await page.reload();
  await expect(page.getByTestId('active-session')).toHaveText(id);
  await expect(page.getByTestId('connection-state')).toHaveText('connected');
  // Output from before the refresh is replayed, and the background command kept running.
  await expectOutput(page, /started-3/);
  await expectOutput(page, /finished-42/);
});

test('E — two tabs share one session', async ({ page, context }) => {
  const id = await createSession(page);
  const second = await context.newPage();
  await second.goto(`/#${id}`);
  await expect(second.getByTestId('connection-state')).toHaveText('connected');

  await run(page, 'echo from-first-$((10+1))');
  await expectOutput(page, /from-first-11/);
  await expectOutput(second, /from-first-11/);

  await run(second, 'echo from-second-$((20+2))');
  await expectOutput(page, /from-second-22/);

  await second.close();
  await run(page, 'echo alone-$((30+3))');
  await expectOutput(page, /alone-33/);
});

test('F — a shell that exits is reflected in the terminal and the list', async ({ page }) => {
  await createSession(page);
  await run(page, 'exit 3');
  await expect(page.getByTestId('exit-notice')).toContainText('code 3');
  await expect(page.getByTestId('session-status')).toHaveText('exited');
  await expect(page.getByTestId('session-item').locator('.badge')).toHaveText('exited');
  await expect(page.getByTestId('reconnect')).toHaveCount(0);
});

test('terminating a session from the list removes it', async ({ page, request }) => {
  const id = await createSession(page);
  await page.getByRole('button', { name: `Terminate ${id}` }).click();
  await expect(page.getByTestId('session-item')).toHaveCount(0);
  await expect(page.getByText('Create or select a terminal session.')).toBeVisible();
  expect((await request.get(`${API}/${id}`)).status()).toBe(404);
});

test('a stale session link explains itself instead of offering to reconnect', async ({ page }) => {
  await page.goto('/#term_doesNotExist1234');
  await expect(page.getByTestId('error-notice')).toHaveText('Terminal session was not found.');
  await expect(page.getByTestId('reconnect')).toHaveCount(0);
});

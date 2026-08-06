// Role-matrix browser regression (plan §3): reader vs operator gating of nav,
// hash routes, palette, and hotkeys; settings login lifecycle; unconfigured
// portal messaging. Runs against the configured portal (8322, baseURL),
// the unconfigured portal (8323), and uses API login shortcuts where the
// login form itself is not under test.
import { test, expect } from '@playwright/test';
import { E2E_PASSWORD, CONFIGURED, UNCONFIGURED } from './paths.mjs';

const OPERATOR_NAV = ['queue', 'acquire', 'upstream', 'raw', 'govern'];
const READER_NAV = ['dashboard', 'browse', 'graph', 'search', 'chat'];

async function apiLogin(context, base = CONFIGURED) {
  const res = await context.request.post(base + '/api/admin/login', {
    data: { password: E2E_PASSWORD },
  });
  if (res.status() !== 200) throw new Error(`apiLogin failed: ${res.status()}`);
}

test('P1 reader nav is minimal, operator links hidden before /api/session resolves', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // no flash: hidden attribute is applied synchronously during module init,
  // before DOMContentLoaded fires — assert the DOM state right now, no waiting
  const hidden = await page.locator('nav a[data-route]').evaluateAll(
    (els) => Object.fromEntries(els.map((a) => [a.dataset.route, a.hidden])),
  );
  for (const r of OPERATOR_NAV) expect(hidden[r], `${r} hidden at domcontentloaded`).toBe(true);
  for (const r of READER_NAV) expect(hidden[r], `${r} not hidden`).toBe(false);
  await expect(page.locator('#stale-banner')).toBeHidden();
  // stays hidden after the session check resolves
  for (const r of OPERATOR_NAV) await expect(page.locator(`nav a[data-route="${r}"]`)).toBeHidden();
});

for (const route of ['queue', 'govern', 'raw', 'upstream', 'acquire']) {
  test(`P2 reader blocked from operator route #/${route}`, async ({ page }) => {
    const apiHits = [];
    page.on('response', (r) => { if (r.url().includes(`/api/${route}`) && r.status() === 200) apiHits.push(r.url()); });
    await page.goto(`/#/${route}`);
    await expect(page.locator('#view')).toContainText('Operator login required');
    await expect(page.locator('#view')).toContainText('Go to Settings login');
    expect(apiHits, `no 200 from /api/${route} while gated`).toEqual([]);
  });
}

test('P2b gate CTA leads to the settings login page', async ({ page }) => {
  await page.goto('/#/queue');
  await expect(page.locator('#view')).toContainText('Operator login required');
  await page.locator('#view a', { hasText: 'Go to Settings login' }).click();
  // the reader must land on the operator login form
  await expect(page.locator('#login-section')).toBeVisible();
});

test('P3 unconfigured portal: operator features disabled messaging, no login link', async ({ page }) => {
  await page.goto(UNCONFIGURED + '/#/queue');
  await expect(page.locator('#view')).toContainText('Operator features are disabled');
  await expect(page.locator('#view')).toContainText('WEFT_ADMIN_PASSWORD_HASH');
  await expect(page.locator('#view a', { hasText: 'Go to Settings login' })).toHaveCount(0);
});

test('P4 login via settings form: wrong password errors, correct unlocks settings', async ({ page }) => {
  await page.goto('/views/settings.html');
  await page.fill('#password', 'wrong-password');
  await page.click('#login-form button[type="submit"]');
  await expect(page.locator('#login-status')).toContainText('invalid password');

  await page.fill('#password', E2E_PASSWORD);
  await page.click('#login-form button[type="submit"]');
  await expect(page.locator('#login-section')).toBeHidden();
  await expect(page.locator('#settings-section')).toBeVisible();
  await expect(page.locator('#config-display')).toContainText('gpt-5.4');
  await expect(page.locator('#env-list')).toContainText('WEFT_ADMIN_PASSWORD_HASH: ✅ set');
});

test('P5 settings shows masked model config and the prompts list', async ({ page, context }) => {
  await apiLogin(context);
  await page.goto('/views/settings.html');
  await expect(page.locator('#settings-section')).toBeVisible();
  const config = await page.locator('#config-display').textContent();
  expect(config).toContain('env:WEFT_LLM_API_KEY'); // masked
  expect(config).not.toMatch(/"api_key": "WEFT_LLM_API_KEY"/); // raw value never rendered
  await expect(page.locator('#prompts-list')).toContainText('Chat prompt (chat.md,');
  await expect(page.locator('#prompts-list')).toContainText('Govern prompt (govern.md,');
  await expect(page.locator('#prompts-list')).toContainText('bytes');
});

test('P6 login unlocks operator nav and all five operator routes', async ({ page, context }) => {
  await apiLogin(context);
  await page.goto('/');
  for (const r of OPERATOR_NAV) await expect(page.locator(`nav a[data-route="${r}"]`)).toBeVisible();

  await page.goto('/#/queue');
  await expect(page.locator('#view')).toContainText('Alpha Topic'); // fixture candidate listed
  await expect(page.locator('#view')).not.toContainText('Operator login required');

  for (const [route, apiPath] of [['govern', '/api/plan'], ['raw', '/api/rawlist'], ['upstream', '/api/detect'], ['acquire', '/api/inbox']]) {
    const ok = page.waitForResponse((r) => r.url().includes(apiPath) && r.status() === 200, { timeout: 10_000 });
    await page.goto(`/#/${route}`);
    await ok;
    await expect(page.locator('#view')).not.toContainText('Operator login required');
  }
});

test('P7 session persists across reload', async ({ page, context }) => {
  await apiLogin(context);
  await page.goto('/');
  await expect(page.locator('nav a[data-route="queue"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('nav a[data-route="queue"]')).toBeVisible();
  const session = await (await context.request.get('/api/session')).json();
  expect(session.admin).toBe(true);
});

test('P8 logout re-locks operator surfaces', async ({ page, context }) => {
  await apiLogin(context);
  await page.goto('/views/settings.html');
  await expect(page.locator('#settings-section')).toBeVisible();
  await page.click('#btn-logout');
  await expect(page.locator('#login-section')).toBeVisible();

  await page.goto('/');
  await page.reload();
  for (const r of OPERATOR_NAV) await expect(page.locator(`nav a[data-route="${r}"]`)).toBeHidden();
  await page.goto('/#/queue');
  await expect(page.locator('#view')).toContainText('Operator login required');
  const res = await context.request.get('/api/settings');
  expect(res.status()).toBe(401);
});

test('P9 command palette filters actions and pages by role', async ({ page, context, browser }) => {
  // reader
  await page.goto('/');
  await page.keyboard.press('Control+k');
  const list = page.locator('.cmdk .list');
  const paletteInput = page.locator('.cmdk input');
  await expect(list.locator('.row').first()).toBeVisible();
  const readerLabels = await list.locator('.row').allTextContents();
  for (const label of ['前往:总览', '前往:浏览', '前往:图谱', '前往:检索', '前往:问答']) {
    expect(readerLabels.some((l) => l.includes(label)), `reader sees ${label}`).toBe(true);
  }
  for (const label of ['评审队列', '采集控制台', '上游检测', '来源管理', '治理控制台']) {
    expect(readerLabels.some((l) => l.includes(label)), `reader must NOT see ${label}`).toBe(false);
  }
  expect(readerLabels.some((l) => l.includes('Payment Gateway Requirements')), 'approved pages listed').toBe(true);
  // candidate pages must not even be in the reader's item set — filter for it
  await paletteInput.fill('Alpha');
  await expect(list.locator('.empty')).toBeVisible();
  await page.keyboard.press('Escape');

  // operator (same context after API login; reload so the SPA re-reads /api/session)
  await apiLogin(context);
  await page.goto('/');
  await page.reload();
  await page.keyboard.press('Control+k');
  await expect(list.locator('.row').first()).toBeVisible();
  const opLabels = await list.locator('.row').allTextContents();
  for (const label of ['评审队列', '采集控制台', '上游检测', '来源管理', '治理控制台']) {
    expect(opLabels.some((l) => l.includes(label)), `operator sees ${label}`).toBe(true);
  }
  // pages rank above the utility actions, so candidate pages list unfiltered
  expect(opLabels.some((l) => l.includes('Alpha Topic')), 'operator sees candidate pages unfiltered').toBe(true);
  // filtering still narrows to pages
  await paletteInput.fill('Alpha');
  const filtered = await list.locator('.row').allTextContents();
  expect(filtered.some((l) => l.includes('Alpha Topic')), 'operator sees candidate pages').toBe(true);
});

test('P10 operator hotkeys are gated by role', async ({ page, context, browser }) => {
  // reader: g q must not navigate
  await page.goto('/#/browse');
  await expect(page).toHaveURL(/#\/browse/);
  await page.keyboard.press('g');
  await page.keyboard.press('q');
  await page.waitForTimeout(300);
  expect(page.url()).toContain('#/browse');

  // operator: g q lands on the queue
  await apiLogin(context);
  await page.reload();
  await expect(page.locator('nav a[data-route="queue"]')).toBeVisible();
  await page.goto('/#/browse');
  await page.keyboard.press('g');
  await page.keyboard.press('q');
  await expect(page).toHaveURL(/#\/queue/);
});

test('P16 reader header degrades silently despite 401 /api/jobs poll', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view')).not.toContainText('Operator login required');
  await expect(page.locator('#view .error')).toHaveCount(0); // no error banner from the swallowed 401
  await expect(page.locator('#sb-pages')).toContainText('pages');
});

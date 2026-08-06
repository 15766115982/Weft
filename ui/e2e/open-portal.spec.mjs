// Open-portal browser regression (2026-08-06): the role gating experiment was
// reverted — every feature is available to everyone. These tests pin the full
// navigation surface, operator-route rendering without any login, settings
// without a login form, palette/hotkey access, and browse with all segments.
import { test, expect } from '@playwright/test';

const ALL_NAV = ['dashboard', 'browse', 'graph', 'search', 'chat', 'queue', 'acquire', 'upstream', 'raw', 'govern'];

test('O1 every nav entry is visible for an anonymous visitor', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const hidden = await page.locator('nav a[data-route]').evaluateAll(
    (els) => Object.fromEntries(els.map((a) => [a.dataset.route, a.hidden])),
  );
  for (const r of ALL_NAV) expect(hidden[r], `${r} must be visible`).toBe(false);
});

for (const route of ['queue', 'govern', 'raw', 'upstream', 'acquire']) {
  test(`O2 anonymous visitor can open #/${route} (no login gate)`, async ({ page }) => {
    await page.goto(`/#/${route}`);
    await expect(page.locator('#view')).not.toContainText('Operator login required');
    await expect(page.locator('#view')).not.toContainText('Operator features are disabled');
    await expect(page.locator('#view .error')).toHaveCount(0);
  });
}

test('O3 settings renders config/prompts with no login form', async ({ page }) => {
  await page.goto('/views/settings.html');
  await expect(page.locator('#login-section')).toHaveCount(0);
  await expect(page.locator('#config-display')).toContainText('api_key');
  await expect(page.locator('#config-display')).toContainText('env:'); // secrets masked
  await expect(page.locator('#prompts-list li').first()).toBeVisible();
});

test('O4 palette lists all routes and pages unfiltered', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  const list = page.locator('.cmdk');
  await expect(list).toBeVisible();
  const labels = await list.locator('.row').allTextContents();
  for (const name of ['评审队列', '采集控制台', '上游检测', '来源管理', '治理控制台']) {
    expect(labels.some((l) => l.includes(name)), `palette has ${name}`).toBe(true);
  }
  // candidate pages are listed without filtering
  expect(labels.some((l) => l.includes('Alpha Topic')), 'candidate pages visible').toBe(true);
});

test('O5 g-sequences navigate to every console', async ({ page }) => {
  await page.goto('/#/browse');
  await page.keyboard.press('g');
  await page.keyboard.press('q');
  await expect(page).toHaveURL(/#\/queue/);
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await expect(page).toHaveURL(/#\/govern/);
});

test('O6 browse shows wiki tree, raw segment, and candidate pages for everyone', async ({ page }) => {
  await page.goto('/#/browse');
  await expect(page.locator('#view .error')).toHaveCount(0);
  await expect(page.locator('#view')).toContainText('Payment Gateway Requirements');
  await expect(page.locator('.grp-body a', { hasText: 'Alpha Topic' })).toHaveCount(1);
  await expect(page.locator('.rail-nav button[data-tt="raw 原文"]')).toBeVisible();
  // page detail exposes edit/compare/history (operator surfaces, now open)
  await page.goto('/#/page?path=' + encodeURIComponent('wiki/sources/jira-proj-1.md'));
  await expect(page.locator('button', { hasText: '编辑' })).toBeVisible();
  await expect(page.locator('button', { hasText: '对照' })).toBeVisible();
  await expect(page.locator('.ctx')).toContainText('历史');
});

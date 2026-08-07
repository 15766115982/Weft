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

test('O3 settings is an editable form: provider cards, field hints, prompts editor', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.locator('#login-section')).toHaveCount(0);
  // section rail: five sections, LLM active by default
  await expect(page.locator('.settings-nav-item')).toHaveCount(5);
  await expect(page.locator('.settings-nav-item.on .t')).toHaveText('模型');
  // provider cards: pick OpenAI-compatible → model field appears, deployment hides
  await page.locator('.provider-card[data-provider="openai"]').click();
  await expect(page.locator('#wrap-model')).toBeVisible();
  await expect(page.locator('#wrap-deployment')).toBeHidden();
  // form loads the fixture config values
  await expect(page.locator('#f-api-key')).toHaveValue('WEFT_LLM_API_KEY');
  // every field carries an explanation
  await expect(page.locator('.field .hint').first()).toBeVisible();
  // edit → dirty bar appears → save → persists
  await page.locator('#f-model').fill('kimi-k2');
  await expect(page.locator('#save-bar')).toBeVisible();
  await page.locator('#btn-save').click();
  await expect(page.locator('#save-note')).toContainText('已保存');
  // prompts master-detail opens an inline editor
  await page.goto('/#/settings?sec=prompts');
  await expect(page.locator('.prompt-editor').first()).toBeVisible();
  // legacy standalone page redirects into the SPA route
  await page.goto('/views/settings.html');
  await expect(page).toHaveURL(/#\/settings/);
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
  // candidate pages are reachable via the palette (filter: earlier flow tests
  // may have approved the fixture candidate, so don't rely on unfiltered caps)
  await list.locator('input').fill('Alpha');
  const filtered = await list.locator('.row').allTextContents();
  expect(filtered.some((l) => l.includes('Alpha Topic')), 'candidate pages visible').toBe(true);
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

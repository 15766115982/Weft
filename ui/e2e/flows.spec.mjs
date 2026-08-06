// PW-01..05 — Real user-flow browser tests (catalog docs/plans/test-catalog.md §E).
// Runs against the 8422 portal (fixture KB + stub LLM).
import { test, expect } from '@playwright/test';

test('PW-01 chat flow: steps shown, chunks stream, citation link navigates', async ({ page }) => {
  await page.goto('/#/chat');
  await page.fill('.chat-input-row textarea', 'retry 策略是什么?');
  await page.locator('.chat-input-row textarea').press('Enter');

  const assistant = page.locator('.chat-msg.assistant').last();
  await expect(assistant).toContainText('hello world', { timeout: 10_000 });
  // reasoning steps (search + read) are visible in the steps drawer
  await assistant.locator('.chat-steps summary').click();
  await expect(assistant.locator('.chat-steps')).toContainText('检索');
  await expect(assistant.locator('.chat-steps')).toContainText('jira-proj-1');
  // citation link lands on the cited page
  await assistant.locator('.chat-citations a').first().click();
  await expect(page).toHaveURL(/#\/page\?path=/);
  await expect(page.locator('#view')).toContainText('Payment Gateway Requirements');
});

test('PW-02 govern console: plan preview, sweep job completes via queue', async ({ page }) => {
  await page.goto('/#/govern');
  await expect(page.locator('#view')).toContainText('治理预览');
  await expect(page.locator('#view')).toContainText('评审队列');
  // mechanical step: sweep runs through the job queue (no agent needed)
  await page.locator('button', { hasText: '运行 sweep' }).click();
  await expect(page.locator('#view')).toContainText(/done|完成|sweep/i, { timeout: 15_000 });
  await expect(page.locator('#view .error')).toHaveCount(0);
});

test('PW-03 review flow: approve with reason drains the queue', async ({ page }) => {
  await page.goto('/#/queue');
  await expect(page.locator('#view')).toContainText('Alpha Topic');
  await page.locator('.reviewbar .approve').click();
  // reason is mandatory — the modal enforces it
  const modal = page.locator('.cmdk');
  await expect(modal).toContainText('批准理由');
  await modal.locator('textarea').fill('fixture approval: accurate and grounded');
  await modal.locator('button.primary').click();
  // queue drains and the page becomes approved + retrievable in browse
  await expect(page.locator('#view')).toContainText(/队列已清空|approved/i, { timeout: 15_000 });
  await page.goto('/#/page?path=' + encodeURIComponent('wiki/syntheses/alpha.md'));
  await expect(page.locator('#view')).toContainText('approved');
});

test('PW-04 settings: edit → save → persists across reload', async ({ page }) => {
  await page.goto('/views/settings.html');
  await page.locator('.provider-card[data-provider="openai"]').click();
  await page.locator('#f-model').fill('kimi-k2-pw04');
  await expect(page.locator('#save-bar')).toBeVisible();
  await page.locator('#btn-save').click();
  await expect(page.locator('#save-note')).toContainText('已保存');
  await page.reload();
  await expect(page.locator('#f-model')).toHaveValue('kimi-k2-pw04');
  // restore the fixture value so later tests are unaffected
  await page.locator('#f-model').fill('kimi-k2-0711-preview');
  await page.locator('#btn-save').click();
  await expect(page.locator('#save-note')).toContainText('已保存');
});

test('PW-05 upload flow: file lands in inbox and acquires into raw/', async ({ page }) => {
  await page.goto('/#/acquire');
  const name = `pw05-upload-${Date.now()}.md`;
  await page.locator('input[type="file"]').setInputFiles({
    name, mimeType: 'text/markdown', buffer: Buffer.from('# PW05 Upload\n\nUploaded via Playwright flow test.\n'),
  });
  // upload enqueues a job that stages inbox + runs acquire local
  await expect(page.locator('#view')).toContainText('完成', { timeout: 20_000 });
  // inbox shows it, then the raw layer lists the acquired doc
  await expect(page.locator('#view')).toContainText(name);
  await page.goto('/#/browse?raw=' + encodeURIComponent(`raw/local/${name}`));
  await expect(page.locator('#view')).not.toContainText('raw doc does not exist');
});

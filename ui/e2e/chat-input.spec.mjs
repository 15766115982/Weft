// Chat input behavior browser regression (plan §3 P11–P15): Enter sends,
// Shift+Enter newline, IME composition Enter ignored, level switch, stream
// failure surfacing. Driven against the WEFT_LLM_CLI stub — no network.
import { test, expect } from '@playwright/test';
import { FAILING_LLM } from './paths.mjs';

const INPUT = '.chat-input-row textarea';
const SEND = '.chat-input-row button.primary';

function countChatPosts(page) {
  const state = { n: 0 };
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/chat')) state.n++; });
  return state;
}

test('P11 Enter sends: one POST, bubbles stream, citation link, input cleared + refocused', async ({ page }) => {
  const posts = countChatPosts(page);
  await page.goto('/#/chat');
  await page.fill(INPUT, 'hello');
  await page.locator(INPUT).press('Enter');

  await expect(page.locator('.chat-msg.user .bubble')).toHaveText('hello');
  const assistant = page.locator('.chat-msg.assistant').last();
  await expect(assistant).toContainText('hello world', { timeout: 10_000 });
  const cite = assistant.locator('.chat-citations a');
  await expect(cite).toHaveCount(1);
  await expect(cite).toContainText('sources/jira-proj-1.md');
  expect(posts.n, 'exactly one POST /api/chat').toBe(1);
  await expect(page.locator(INPUT)).toHaveValue('');
  await expect(page.locator(INPUT)).toBeFocused();
});

test('P12 Shift+Enter inserts a newline instead of sending', async ({ page }) => {
  const posts = countChatPosts(page);
  await page.goto('/#/chat');
  await page.fill(INPUT, 'line1');
  await page.locator(INPUT).press('Shift+Enter');
  await page.locator(INPUT).pressSequentially('line2');
  await expect(page.locator(INPUT)).toHaveValue('line1\nline2');
  await page.waitForTimeout(300);
  expect(posts.n, 'no POST issued').toBe(0);
});

test('P13 IME composition Enter is ignored (regression guard for e.isComposing)', async ({ page }) => {
  const posts = countChatPosts(page);
  await page.goto('/#/chat');
  await page.fill(INPUT, 'IME 入力中');
  // Playwright cannot drive a real IME — synthesize the event exactly as an
  // IME composition would deliver it (isComposing: true).
  await page.locator(INPUT).evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  expect(posts.n, 'composition Enter must not send').toBe(0);
  await expect(page.locator(INPUT)).toHaveValue('IME 入力中');
});

test('P14 level switch moves .on; Enter on empty input sends nothing', async ({ page }) => {
  const posts = countChatPosts(page);
  await page.goto('/#/chat');
  await page.locator('.level-btn', { hasText: '深度' }).click();
  await expect(page.locator('.level-btn', { hasText: '深度' })).toHaveClass(/on/);
  await expect(page.locator('.level-btn', { hasText: '快速' })).not.toHaveClass(/on/);
  await page.locator(INPUT).press('Enter');
  await page.waitForTimeout(300);
  expect(posts.n, 'empty input never sends').toBe(0);
});

test('P15 stream failure surfaces in the bubble and the input recovers', async ({ page }) => {
  await page.goto(FAILING_LLM + '/#/chat');
  await page.fill(INPUT, 'hello');
  await page.locator(INPUT).press('Enter');
  const assistant = page.locator('.chat-msg.assistant').last();
  await expect(assistant).toContainText('流式输出失败', { timeout: 10_000 });
  await expect(page.locator(SEND)).toBeEnabled();
  await expect(page.locator('.chat-thinking')).toBeHidden();
});

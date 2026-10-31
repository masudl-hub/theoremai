import type { Page } from '@playwright/test';
import { expect, open, seen, send, test } from './drive.ts';

const systemOf = async (page: Page) => {
  const [request] = (await seen(page)).slice(-1);
  const first = request?.body.messages?.find((message) => message.role === 'system');
  return JSON.stringify(first?.content ?? '');
};

const withLines = async (page: Page) => {
  await open(page);
  await page.getByRole('textbox', { name: 'Conditions' }).fill('{ "plan": ["free", "paid"] }');
  await page.getByRole('button', { name: 'Add line' }).click();
  await page
    .getByRole('textbox', { name: 'Line 2' })
    .fill('when plan is paid: Mention the garden.');
  await expect(page.getByText('Edited (studio)')).toBeVisible();
  await page.getByRole('button', { name: 'Hide saved' }).click();
};

test('the first value is stated until the builder picks another', async ({ page }) => {
  await withLines(page);
  await send(page, 'first');
  await expect(page.getByText('Fake reply on full to "first"')).toBeVisible();
  expect(await systemOf(page)).not.toContain('Mention the garden.');
});

test('a picked condition sends the line it chooses', async ({ page }) => {
  await withLines(page);
  await page.getByRole('combobox', { name: 'plan' }).click();
  await page.getByRole('option', { name: 'paid' }).click();
  await send(page, 'second');
  await expect(page.getByText('Fake reply on full to "second"')).toBeVisible();
  expect(await systemOf(page)).toContain('Mention the garden.');
});

test('both sides run when only the edit declares conditions', async ({ page }) => {
  await open(page);
  await page.getByRole('textbox', { name: 'Conditions' }).fill('{ "plan": ["free", "paid"] }');
  await expect(page.getByText('Edited (studio)')).toBeVisible();
  await send(page, 'third');
  await expect(page.getByText('Fake reply on full to "third"')).toHaveCount(2);
});

test('the trace names the prompt lines the turn sent', async ({ page }) => {
  await withLines(page);
  await page.getByRole('combobox', { name: 'plan' }).click();
  await page.getByRole('option', { name: 'paid' }).click();
  await send(page, 'fourth');
  await expect(page.getByText('Fake reply on full to "fourth"')).toBeVisible();
  await page.getByRole('button', { name: 'View trace' }).click();
  await page.getByRole('button', { name: /Answered Fake reply/ }).click();
  await page.getByRole('button', { name: 'All details' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const row = page.getByRole('term').filter({ hasText: 'Prompt lines sent' });
  await expect(row.locator('xpath=following-sibling::*[1]')).toHaveText(/1.*2/);
});

test('an image agent runs with the conditions the edit declares', async ({ page }) => {
  await open(page, 'picture');
  await page.getByRole('textbox', { name: 'Conditions' }).fill('{ "plan": ["free", "paid"] }');
  await page.getByRole('button', { name: 'Add line' }).click();
  await page
    .getByRole('textbox', { name: 'Line 2' })
    .fill('when plan is paid: Mention the garden.');
  await page.getByRole('combobox', { name: 'plan' }).click();
  await page.getByRole('option', { name: 'paid' }).click();
  await expect(page.getByText('Edited (studio)')).toBeVisible();
  await page.getByRole('button', { name: 'Hide saved' }).click();
  await send(page, 'a red pixel');
  await expect(page.getByRole('img', { name: 'Generated image' })).toBeVisible();
});

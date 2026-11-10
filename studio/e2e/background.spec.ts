import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, open, PROJECT, putProjectBack, seen, send, test } from './drive.ts';

const tools = path.join(PROJECT, 'tools.ts');
const STARTED = 'has started and is still running';

async function toolPage(page: Page, name: string) {
  await page.getByRole('radio', { name: /Tools, 6/ }).click();
  await page.getByRole('button', { name, exact: true }).first().click();
}

test.afterEach(async ({ browser }) => {
  await putProjectBack(await browser.newPage());
});

test('a tool set to always answers the model at once, and a reload shows how it ended', async ({
  page,
}) => {
  await open(page);
  await send(page, '[call slow_report {}]');
  await expect(page.getByText(/Tool answered on full/)).toBeVisible();
  const read = JSON.stringify((await seen(page)).at(-1)?.body.messages);
  expect(read).toContain(STARTED);
  expect(read).not.toContain('"pages"');
  await page.waitForTimeout(2000);
  await page.reload();
  await page.getByRole('button', { name: 'desk', exact: true }).first().click();
  await page.getByRole('button', { name: /Worked for/ }).click();
  await page.getByRole('button', { name: /Slow report/ }).click();
  await expect(page.getByText('pages')).toBeVisible();
});

test('a late call that ends redraws the open chat, with the project keeping its own record', async ({
  page,
}) => {
  await open(page);
  await send(page, '[call slow_report {}]');
  await expect(page.getByText(/Tool answered on full/)).toBeVisible();
  await page.getByRole('button', { name: /Worked for/ }).click();
  await page.getByRole('button', { name: /Slow report/ }).click();
  await expect(page.getByText('pages')).toBeVisible({ timeout: 10_000 });
});

test('the tool page sets when the model gets its reply, and save writes it', async ({ page }) => {
  await open(page);
  await toolPage(page, 'file_note');
  const row = page.getByRole('radiogroup', { name: 'Background' });
  await row.getByRole('radio', { name: 'After a time' }).click();
  await expect(page.getByRole('spinbutton', { name: 'After' })).toHaveValue('10000');
  await row.getByRole('radio', { name: 'Always' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await page
    .getByRole('dialog', { name: /Save to/ })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByText('Saved to tools.ts.').first()).toBeVisible();
  expect(readFileSync(tools, 'utf8')).toContain("background: 'always'");
});

test('a tool set to always answers a live call at once', async ({ page }) => {
  await open(page, 'line');
  await page.getByRole('button', { name: 'Start voice call' }).click();
  await expect(page.getByText('listening')).toBeVisible();
  await send(page, '[call slow_report {}]');
  await expect(page.getByText('Live tool slow_report answered')).toBeVisible();
  const answer = (await seen(page)).find((call) => 'toolResponse' in call.body);
  expect(JSON.stringify(answer?.body)).toContain(STARTED);
});

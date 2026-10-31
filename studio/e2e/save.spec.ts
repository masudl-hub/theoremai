import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { composer, expect, open, PROJECT, putProjectBack, seen, send, test } from './drive.ts';

const desk = path.join(PROJECT, 'agents/desk.ts');
const tools = path.join(PROJECT, 'tools.ts');
const original = readFileSync(desk, 'utf8');
const originalTools = readFileSync(tools, 'utf8');

const handle = (page: Page) => page.getByRole('textbox', { name: 'Handle' }).first();
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Line 1' }).first();
const saveToken = (page: Page) => page.getByRole('button', { name: 'Save', exact: true }).first();
const edited = (from: string, to: string) => original.replace(from, to);

test.afterEach(async ({ browser }) => {
  await putProjectBack(await browser.newPage());
});

test('an edit runs beside the saved agent, and neither crosses over', async ({ page }) => {
  await open(page);
  await prompt(page).fill('Answer in French.');
  await expect(page.getByText('Saved (your files)')).toBeVisible();
  await composer(page).fill('bonjour');
  await composer(page).press('Enter');
  await expect(page.getByText('Fake reply on full to "bonjour"')).toHaveCount(2);
  const systems = (await seen(page)).flatMap((call) =>
    call.body.messages ? [JSON.stringify(call.body.messages[0])] : [],
  );
  expect(systems.filter((system) => system.includes('Answer in French.'))).toHaveLength(1);
  expect(systems.filter((system) => system.includes('Answer in one line.'))).toHaveLength(1);
  expect(readFileSync(desk, 'utf8')).toBe(original);
});

test('save writes the edit to the file and nothing else', async ({ page }) => {
  await open(page);
  await handle(page).fill('Deskx');
  await saveToken(page).click();
  const dialog = page.getByRole('dialog', { name: /Save to/ });
  await expect(dialog.getByText('agents/desk.ts:6')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved to agents/desk.ts.').first()).toBeVisible();
  expect(readFileSync(desk, 'utf8')).toBe(edited("handle: 'Desk'", "handle: 'Deskx'"));
  await expect(saveToken(page)).toBeHidden();
  await expect(page.getByText('Saved (your files)')).toBeHidden();
  await expect(page.getByRole('heading', { name: '@Deskx' })).toBeVisible();
});

test('undo after a save puts the file and the edit back', async ({ page }) => {
  await open(page);
  await handle(page).fill('Deskx');
  await saveToken(page).click();
  const dialog = page.getByRole('dialog', { name: /Save to/ });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(handle(page)).toHaveValue('Deskx');
  await expect(saveToken(page)).toBeVisible();
  expect(readFileSync(desk, 'utf8')).toBe(original);
});

test('discard all goes back to the files', async ({ page }) => {
  await open(page);
  await handle(page).fill('Deskx');
  await saveToken(page).click();
  await page
    .getByRole('dialog', { name: /Save to/ })
    .getByRole('button', { name: 'Discard all' })
    .click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard all' }).click();
  await expect(handle(page)).toHaveValue('Desk');
  await expect(saveToken(page)).toBeHidden();
  expect(readFileSync(desk, 'utf8')).toBe(original);
});

test('edits survive a reload', async ({ page }) => {
  await open(page);
  await handle(page).fill('Deskx');
  await expect(saveToken(page)).toBeVisible();
  await page.reload();
  await expect(handle(page)).toHaveValue('Deskx');
  await expect(saveToken(page)).toBeVisible();
});

test('a change to the file reaches the studio', async ({ page }) => {
  await open(page);
  await expect(handle(page)).toHaveValue('Desk');
  writeFileSync(desk, edited("handle: 'Desk'", "handle: 'Disk'"));
  await expect(handle(page)).toHaveValue('Disk');
  await expect(saveToken(page)).toBeHidden();
});

test('a setting changed on both sides asks which stands: source', async ({ page }) => {
  await open(page);
  await handle(page).fill('Deskx');
  await expect(saveToken(page)).toBeVisible();
  writeFileSync(desk, edited("handle: 'Desk'", "handle: 'Disk'"));
  const dialog = page.getByRole('dialog', { name: /conflict/ });
  await dialog.getByRole('button', { name: 'Keep source code' }).click();
  await dialog.getByRole('button', { name: 'Resolve conflict' }).click();
  await expect(handle(page)).toHaveValue('Disk');
  await expect(saveToken(page)).toBeHidden();
  expect(readFileSync(desk, 'utf8')).toBe(edited("handle: 'Desk'", "handle: 'Disk'"));
});

test('a setting changed on both sides asks which stands: studio', async ({ page }) => {
  await open(page);
  await handle(page).fill('Deskx');
  await expect(saveToken(page)).toBeVisible();
  writeFileSync(desk, edited("handle: 'Desk'", "handle: 'Disk'"));
  const dialog = page.getByRole('dialog', { name: /conflict/ });
  await dialog.getByRole('button', { name: 'Resolve conflict' }).click();
  await expect(handle(page)).toHaveValue('Deskx');
  await expect(saveToken(page)).toBeVisible();
  expect(readFileSync(desk, 'utf8')).toBe(edited("handle: 'Desk'", "handle: 'Disk'"));
});

test('a save the project cannot type-check puts the files back and says why', async ({ page }) => {
  await open(page);
  await handle(page).fill('Deskx');
  await saveToken(page).click();
  const broken = originalTools.replace("country: 'PT'", 'country: 7');
  writeFileSync(tools, broken);
  await page.waitForTimeout(1500);
  const dialog = page.getByRole('dialog', { name: /Save to/ });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toContainText('TS2322');
  expect(await dialog.textContent()).not.toContain('\x1b');
  expect(readFileSync(desk, 'utf8')).toBe(original);
  expect(readFileSync(tools, 'utf8')).toBe(broken);
});

test('a file that stops loading shows the last load and the studio stays up', async ({ page }) => {
  await open(page);
  await expect(handle(page)).toHaveValue('Desk');
  writeFileSync(desk, 'export const desk = (;\n');
  await expect(page.getByText('1 alert')).toBeVisible();
  await expect(page.getByText('Your files stopped loading')).toBeVisible();
  await send(page, 'still here');
  await expect(page.getByText('Fake reply on full to "still here"')).toBeVisible();
  writeFileSync(desk, original);
  await expect(page.getByText('1 alert')).toBeHidden();
});

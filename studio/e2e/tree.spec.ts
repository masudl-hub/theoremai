import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { composer, expect, FAKE, open, PROJECT, putProjectBack, send, test } from './drive.ts';

const saveToken = (page: Page) => page.getByRole('button', { name: 'Save', exact: true }).first();
const saved = (page: Page) => page.getByText(/^Saved to /).first();
const written = () =>
  readdirSync(PROJECT, { recursive: true, encoding: 'utf8' }).filter((file) =>
    file.endsWith('.ts'),
  );
const allText = () =>
  written()
    .map((file) => readFileSync(path.join(PROJECT, file), 'utf8'))
    .join('\n');

async function saveAll(page: Page) {
  await saveToken(page).click();
  const dialog = page.getByRole('dialog', { name: /Save/ });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
}

test.afterEach(async ({ browser }) => {
  await putProjectBack(await browser.newPage());
});

test('a blank agent says what it needs, and is removed clean', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Add agent' }).click();
  await page.getByRole('menuitem', { name: /Blank agent/ }).click();
  await expect(page.getByText('Profile id is required.')).toBeVisible();
  await expect(saveToken(page)).toBeHidden();
  await page
    .getByRole('button', { name: /^Remove/ })
    .last()
    .click({ force: true });
  await expect(page.getByText('Unnamed agent').first()).toBeHidden();
  await expect(saveToken(page)).toBeHidden();
});

test('a duplicate runs, Save writes its file, and Save takes it back out', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Duplicate concierge' }).click({ force: true });
  await page.getByRole('textbox', { name: 'Handle' }).first().fill('Second');
  await send(page, 'hello second');
  await expect(page.getByText('Fake reply on full to "hello second"')).toBeVisible();
  await saveAll(page);
  await expect(saved(page)).toBeVisible();
  expect(written()).toContain('agents/concierge_copy.ts');
  expect(allText()).toContain('registerProfile(conciergeCopy.profile)');
  await page.getByRole('button', { name: 'Remove concierge_copy' }).click({ force: true });
  await saveAll(page);
  await expect(saved(page)).toBeVisible();
  expect(written()).not.toContain('agents/concierge_copy.ts');
  expect(allText()).not.toContain('conciergeCopy');
});

test('a new tool goes on the agent and Save writes both', async ({ page }) => {
  await open(page);
  await page.getByRole('radio', { name: /Tools, 4/ }).click();
  await page.getByRole('button', { name: 'Add tool' }).click();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('my_tool');
  await page.getByRole('textbox', { name: 'Name' }).fill('stamp_note');
  await saveAll(page);
  await expect(saved(page)).toBeVisible();
  await expect(saveToken(page)).toBeHidden();
  expect(written().join()).toContain('stamp_note');
  expect(allText()).toContain("'wipe_desk', 'stamp_note'");
});

test('discard takes every edit back from settings', async ({ page }) => {
  await open(page);
  const handle = page.getByRole('textbox', { name: 'Handle' }).first();
  await handle.fill('Edited');
  await expect(page.getByText('Edited (studio)')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('tree', { name: 'Settings' })
    .getByRole('button', { name: /Project/ })
    .click();
  await page.getByRole('button', { name: 'Discard unsaved edits' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /Discard/ })
    .click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(handle).toHaveValue('Desk');
  await expect(page.getByText('Edited (studio)')).toBeHidden();
  await send(page, 'after discard');
  await expect(page.getByText('Fake reply on full to "after discard"')).toBeVisible();
  await expect(composer(page)).toBeVisible();
});

test('with watch off a saved file waits, and turning it on takes it in', async ({ page }) => {
  await open(page);
  const handle = page.getByRole('textbox', { name: 'Handle' }).first();
  const watch = () =>
    page
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
      .then(() =>
        page.getByRole('tree', { name: 'Settings' }).getByRole('button', { name: /Files/ }).click(),
      );
  await watch();
  await page.getByRole('checkbox', { name: /Watch files/ }).uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  const desk = path.join(PROJECT, 'agents/desk.ts');
  writeFileSync(desk, readFileSync(desk, 'utf8').replace("handle: 'Desk'", "handle: 'Desky'"));
  await page.waitForTimeout(2500);
  await expect(handle).toHaveValue('Desk');
  await watch();
  await page.getByRole('checkbox', { name: /Watch files/ }).check();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(handle).toHaveValue('Desky');
});

test('a line from the files opens in the editor at that line', async ({ page }) => {
  await open(page);
  await page
    .getByRole('tree', { name: 'Agents' })
    .getByRole('button', { name: 'concierge', exact: true })
    .click();
  await page.locator('button.inspector-origin').first().click();
  const opened = `${PROJECT}-tools/opened`;
  await expect
    .poll(() => existsSync(opened) && readFileSync(opened, 'utf8'))
    .toMatch(/team\.ts:\d+/);
});

test("an http tool is tested against its endpoint, within the agent's network guardrail", async ({
  page,
}) => {
  await open(page);
  await page.getByRole('radio', { name: /Tools, 4/ }).click();
  await page.getByRole('button', { name: 'Add tool' }).click();
  await page.getByRole('radio', { name: 'HTTP' }).click();
  await page.getByRole('textbox', { name: 'Endpoint' }).fill(`${FAKE}/requests`);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/network guardrail doesn't allow this address/)).toBeVisible();
  await page.getByRole('radio', { name: /Agents/ }).click();
  await page.getByRole('button', { name: 'Guardrails', exact: true }).first().click();
  await page.getByRole('switch', { name: 'Private' }).click();
  await page.getByRole('radio', { name: /Tools/ }).click();
  await page.getByRole('button', { name: 'my_tool' }).first().click();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/^200 OK/)).toBeVisible();
});

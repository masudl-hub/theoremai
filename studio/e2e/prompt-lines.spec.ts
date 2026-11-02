import type { Page } from '@playwright/test';
import { expect, open, promptCode, seen, send, test } from './drive.ts';

const systemOf = async (page: Page) => {
  const [request] = (await seen(page)).slice(-1);
  const first = request?.body.messages?.find((message) => message.role === 'system');
  return JSON.stringify(first?.content ?? '');
};

const declarePlan = async (page: Page) => {
  await page.getByRole('button', { name: 'Add option' }).first().click();
  await page.getByRole('textbox', { name: 'Option 1 name' }).fill('plan');
  const values = page.getByRole('combobox', { name: 'Option 1 values' });
  await values.fill('free');
  await values.press('Enter');
  await values.fill('paid');
  await values.press('Enter');
};

const pickPaid = (page: Page) =>
  page
    .getByRole('group', { name: 'Option 1 values' })
    .getByRole('button', { name: 'paid', exact: true })
    .click();

const addPaidLine = async (page: Page) => {
  const prompt = await promptCode(page);
  await prompt.fill(`${await prompt.inputValue()}\n\nwhen plan is paid: Mention the garden.`);
};

const withLines = async (page: Page) => {
  await open(page);
  await declarePlan(page);
  await addPaidLine(page);
  await expect(page.getByText('Edited (studio)')).toBeVisible();
  await page.getByRole('button', { name: 'Hide saved' }).click();
};

test('each option keeps its values in sight', async ({ page }) => {
  await open(page);
  await declarePlan(page);
  await page.getByRole('button', { name: 'Add option' }).first().click();
  await page.getByRole('textbox', { name: 'Option 2 name' }).fill('group');
  await page.getByRole('textbox', { name: 'Option 1 name' }).click();
  await expect(page.getByRole('group', { name: 'Option 1 values' })).toContainText('paid');
  await page.getByRole('button', { name: 'Remove option 2' }).click();
  await expect(page.getByRole('textbox', { name: 'Option 2 name' })).toBeHidden();
});

test('the first value is stated until the builder picks another', async ({ page }) => {
  await withLines(page);
  await send(page, 'first');
  const values = page.getByRole('group', { name: 'Option 1 values' });
  const marked = values.locator('[data-color="blue"]');
  await expect(marked).toHaveText('free');
  await expect(page.getByText('Fake reply on full to "first"')).toBeVisible();
  expect(await systemOf(page)).not.toContain('Mention the garden.');
});

test('a picked option sends the line it chooses', async ({ page }) => {
  await withLines(page);
  await pickPaid(page);
  await expect(
    page.getByRole('group', { name: 'Option 1 values' }).locator('[data-color="blue"]'),
  ).toHaveText('paid');
  await send(page, 'second');
  await expect(page.getByText('Fake reply on full to "second"')).toBeVisible();
  expect(await systemOf(page)).toContain('Mention the garden.');
});

test('an option shown in the interface is picked in the composer, and that pick sends its line', async ({
  page,
}) => {
  await withLines(page);
  await page.getByRole('button', { name: 'Option 1 not shown in interface' }).click();
  await page.getByRole('switch', { name: 'Shown in interface' }).click();
  await page.keyboard.press('Escape');
  const picker = page.getByRole('combobox', { name: 'plan' }).last();
  await expect(picker).toHaveText(/free/);
  await picker.click();
  await page.getByRole('option', { name: 'paid' }).click();
  await expect(picker).toHaveText(/paid/);
  await expect(
    page.getByRole('group', { name: 'Option 1 values' }).locator('[data-color="blue"]'),
  ).toHaveText('paid');
  await send(page, 'second');
  await expect(page.getByText('Fake reply on full to "second"')).toBeVisible();
  expect(await systemOf(page)).toContain('Mention the garden.');
});

test('both sides run when only the edit declares options', async ({ page }) => {
  await open(page);
  await declarePlan(page);
  await expect(page.getByText('Edited (studio)')).toBeVisible();
  await send(page, 'third');
  await expect(page.getByText('Fake reply on full to "third"')).toHaveCount(2);
});

test('the trace names the prompt lines the turn sent', async ({ page }) => {
  await withLines(page);
  await pickPaid(page);
  await send(page, 'fourth');
  await expect(page.getByText('Fake reply on full to "fourth"')).toBeVisible();
  await page.getByRole('button', { name: 'View trace' }).click();
  await page.getByRole('button', { name: /Answered Fake reply/ }).click();
  await page.getByRole('button', { name: 'All details' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const row = page.getByRole('term').filter({ hasText: 'Prompt lines sent' });
  await expect(row.locator('xpath=following-sibling::*[1]')).toHaveText(/1.*2/);
});

test('an image agent runs with the options the edit declares', async ({ page }) => {
  await open(page, 'picture');
  await declarePlan(page);
  await addPaidLine(page);
  await pickPaid(page);
  await expect(page.getByText('Edited (studio)')).toBeVisible();
  await page.getByRole('button', { name: 'Hide saved' }).click();
  await send(page, 'a red pixel');
  await expect(page.getByRole('img', { name: 'Generated image' })).toBeVisible();
});

test('a private section in the box stays private, across a blank line', async ({ page }) => {
  await open(page);
  const prompt = await promptCode(page);
  const loaded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/edited') && response.request().postData()?.includes('Say hello'),
  );
  await prompt.fill('Say hello. {private: Code 7731.\n\nKeep it.}\n\nThen help.');
  await loaded;
  await expect(page.getByText('Edited (studio)')).toBeVisible();
  await page.getByRole('button', { name: 'Hide saved' }).click();
  await send(page, 'fifth');
  await expect(page.getByText('Fake reply on full to "fifth"')).toBeVisible();
  const system = await systemOf(page);
  expect(system).toContain('Say hello.');
  expect(system).toContain('Code 7731.\\n\\nKeep it.');
  expect(system).toContain('Then help.');
  expect(system).not.toContain('{private');
});

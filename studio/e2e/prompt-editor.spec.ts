import type { Locator, Page } from '@playwright/test';
import { expect, open, promptCode, seen, send, test } from './drive.ts';

const editor = (page: Page) => page.getByRole('textbox', { name: 'Prompt' }).first();
const button = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).first();
const edited = (page: Page) => page.getByText('Edited (studio)');

const declarePlan = async (page: Page) => {
  await page.getByRole('button', { name: 'Add option' }).first().click();
  await page.getByRole('textbox', { name: 'Option 1 name' }).fill('plan');
  const values = page.getByRole('combobox', { name: 'Option 1 values' });
  await values.fill('free');
  await values.press('Enter');
  await values.fill('paid');
  await values.press('Enter');
};

const write = async (page: Page, text: string) => {
  const code = await promptCode(page);
  await code.fill(text);
  await button(page, 'Code').click();
};

const selectAll = async (page: Page) => {
  await editor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
};

const written = async (page: Page) => (await promptCode(page)).inputValue();

test('the prompt opens formatted, and opening it changes nothing', async ({ page }) => {
  await open(page);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await expect(edited(page)).toBeHidden();
  await button(page, 'Code').click();
  await button(page, 'Code').click();
  await expect(edited(page)).toBeHidden();
});

test('private text reads as the rest does, marked on the words or on the whole block', async ({
  page,
}) => {
  await open(page);
  await write(page, 'Shared {private: held} words.\n\n{private: All of it.}');
  const held = page.locator('.prompt-editor [style*="--private"]').first();
  await expect(held).toHaveText('held');
  const shared = page.locator('.prompt-editor p').first();
  const colour = (at: typeof held) => at.evaluate((node) => getComputedStyle(node).color);
  expect(await colour(held)).toBe(await colour(shared));
  await expect(page.locator('[data-private]')).toHaveCount(1);
  await expect(page.locator('[data-private]')).toHaveText('All of it.');
});

test('a private list is one block, its bullets inside the wash', async ({ page }) => {
  await open(page);
  await write(page, '## Voice\n\n- One.\n- Two.');
  await selectAll(page);
  await button(page, 'Private').click();
  const list = page.locator('.prompt-editor ul');
  await expect(list).toHaveAttribute('data-private', '');
  const background = (at: Locator) => at.evaluate((node) => getComputedStyle(node).background);
  expect(await background(list)).not.toContain('rgba(0, 0, 0, 0)');
  for (const item of await list.locator('li').all()) {
    expect(await background(item)).toContain('rgba(0, 0, 0, 0)');
  }
});

test('private items in a list that opens shared run as one block, their bullets inside the wash', async ({
  page,
}) => {
  await open(page);
  await write(page, '- Shared "the weight."\n{private: - Your voice.\n- Analogies.}');
  const items = page.locator('.prompt-editor li');
  await expect(page.locator('.prompt-editor ul')).not.toHaveAttribute('data-private');
  await expect(items.nth(0)).not.toHaveAttribute('data-private');
  await expect(items.nth(1)).toHaveAttribute('data-private-start', '');
  await expect(items.nth(2)).toHaveAttribute('data-private-end', '');
  for (const at of [1, 2]) {
    const wash = await items.nth(at).evaluate((node) => {
      const after = getComputedStyle(node, '::after');
      return { background: after.backgroundColor, start: after.insetInlineStart };
    });
    expect(wash.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(Number.parseFloat(wash.start)).toBeLessThan(0);
  }
});

test('a private section with a shared quote is one block, the quote cut out of it', async ({
  page,
}) => {
  await open(page);
  await write(page, '## Voice\n\n- Grounded: say weight then.\n- Yours.');
  await selectAll(page);
  await button(page, 'Private').click();
  await page.getByText('Grounded: say weight then.').click();
  await page.keyboard.press('Home');
  for (const _ of 'Grounded: say ') await page.keyboard.press('ArrowRight');
  for (const _ of 'weight') await page.keyboard.press('Shift+ArrowRight');
  await button(page, 'Private').click();
  await expect(page.locator('.prompt-editor h2')).toHaveAttribute('data-private-start', '');
  await expect(page.locator('.prompt-editor ul')).toHaveAttribute('data-private-end', '');
  await expect(page.locator('[data-private-start]')).toHaveCount(1);
  const shared = page.locator('.prompt-editor li [data-lexical-text]:not([style*="--private"])');
  await expect(shared).toHaveCount(1);
  const colour = (at: Locator) => at.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(await colour(shared)).not.toBe(await colour(page.locator('.prompt-editor ul')));
  expect(await written(page)).toContain('} weight {private: then.');
});

test('text marked private stays private when it reaches the code', async ({ page }) => {
  await open(page);
  await write(page, 'Say hello.');
  await selectAll(page);
  await button(page, 'Private').click();
  await expect(page.locator('[data-private-start]')).toBeVisible();
  expect(await written(page)).toBe('{private: Say hello.}');
});

test('an option comes in from the toolbar, and its token changes it', async ({ page }) => {
  await open(page);
  await declarePlan(page);
  await write(page, 'One.\n\nTwo.');
  await page.getByText('Two.').click();
  await button(page, 'Option').click();
  await page.getByRole('menuitem', { name: 'plan is free' }).click();
  await button(page, 'plan is free').click();
  await editor(page).getByRole('menuitem', { name: 'plan is paid' }).click();
  await expect(button(page, 'plan is paid')).toBeVisible();
  expect(await written(page)).toBe('One.\n\nwhen plan is paid: Two.');
});

test('taking an option off one line leaves the line beside it', async ({ page }) => {
  await open(page);
  await declarePlan(page);
  await write(page, 'when plan is free: One.\n\nTwo.');
  await page.getByRole('button', { name: 'Remove plan is free' }).click();
  expect(await written(page)).toBe('One.\n\nTwo.');
});

test('a word taken out of a private stretch keeps the spaces beside it', async ({ page }) => {
  await open(page);
  await write(page, '{private: Say hello there.}');
  await selectAll(page);
  await page.keyboard.press('ArrowRight');
  for (const _ of ' there.') await page.keyboard.press('ArrowLeft');
  for (const _ of 'hello') await page.keyboard.press('Shift+ArrowLeft');
  await button(page, 'Private').click();
  expect(await written(page)).toBe('{private: Say} hello {private: there.}');
});

test('backspace at the top of a line takes off its option, and the line above covers it', async ({
  page,
}) => {
  await open(page);
  await declarePlan(page);
  await write(page, 'when plan is free: One.\n\nwhen plan is paid: Two.');
  await page.getByText('Two.').click({ position: { x: 1, y: 8 } });
  await page.keyboard.press('Backspace');
  expect(await written(page)).toBe('when plan is free: One.\n\nwhen plan is free: Two.');
});

test('a shared prompt goes back on Cancel and keeps the caret on Change', async ({ page }) => {
  await open(page, 'front_counter');
  await editor(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor(page)).toHaveText('Answer at the counter.');
  await editor(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.getByRole('button', { name: 'Change for all' }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('?');
  await expect(editor(page)).toHaveText('Answer at the counter.!?');
});

test('a blank prompt opens formatted and takes text', async ({ page }) => {
  await open(page);
  await write(page, '');
  await editor(page).click();
  await page.keyboard.type('Say hello.');
  expect(await written(page)).toBe('Say hello.');
});

test('a prompt with broken markup stays in the code view', async ({ page }) => {
  await open(page);
  const code = await promptCode(page);
  await code.fill('{private: open');
  await expect(button(page, 'Code')).toBeDisabled();
  await expect(code).toHaveValue('{private: open');
});

test('text typed in the formatted view reaches the model', async ({ page }) => {
  await open(page);
  await write(page, 'Start.');
  await editor(page).click();
  await page.keyboard.press('End');
  const loaded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/edited') && response.request().postData()?.includes('8842.'),
  );
  await page.keyboard.type(' Say the code 8842.');
  await loaded;
  await page.getByRole('button', { name: 'Hide saved' }).click();
  await send(page, 'first');
  await expect(page.getByText('Fake reply on full to "first"')).toBeVisible();
  const [request] = (await seen(page)).slice(-1);
  const system = request?.body.messages?.find((message) => message.role === 'system');
  expect(JSON.stringify(system?.content ?? '')).toContain('Say the code 8842.');
});

test('the editor says what its marks do on hover', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Add option' }).first().click();
  await page.getByRole('textbox', { name: 'Option 1 name' }).fill('plan');
  const values = page.getByRole('combobox', { name: 'Option 1 values' });
  await values.fill('free');
  await values.press('Enter');
  await values.fill('paid');
  await values.press('Enter');
  const prompt = await promptCode(page);
  await prompt.fill('{private: Keep this.}\n\nwhen plan is paid: Mention the garden.');
  await button(page, 'Code').click();
  const tip = page.getByRole('tooltip');
  const says = async (hovered: Locator, text: string) => {
    await hovered.hover();
    await expect(tip.filter({ hasText: text })).toBeVisible();
    await page.mouse.move(800, 500);
    await expect(tip.filter({ hasText: text })).toBeHidden();
  };
  const box = editor(page);
  await says(box.getByText('Keep this.'), 'a reply that repeats it is stopped');
  await says(button(page, 'Bold'), 'Bold');
  await says(page.locator('.prompt-editor .astryx-selector'), 'Text style');
  await says(page.getByRole('button', { name: 'Private' }), 'a reply that repeats it is stopped');
  await says(page.getByRole('button', { name: 'Option', exact: true }), 'an option fits');
  await says(box.getByText('plan is paid').first(), 'Sent only on turns where plan is paid');
  const free = page.getByRole('group', { name: 'Option 1 values' });
  await says(free.getByText('free'), 'The studio states this value');
  await says(free.getByText('paid'), 'Press to state this value');
  await box.getByText('Keep this.').hover();
  await expect(tip.filter({ hasText: 'a reply that repeats' })).toBeVisible();
  await page.getByText('System prompt').hover();
  await expect(page.getByText('the options that decide which lines go out')).toBeVisible();
});

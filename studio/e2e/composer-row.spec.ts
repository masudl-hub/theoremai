import type { Page } from '@playwright/test';
import { composer, expect, open, release, seen, send, test } from './drive.ts';

/** The studio with Settings' composer layout on Row. */
async function openRow(page: Page, agent = 'desk') {
  await page.addInitScript(() => {
    localStorage.setItem('theorem.studio.composer-layout', 'row');
  });
  await open(page, agent);
}

const pill = (page: Page, name: string) =>
  page.locator('.astryx-token', { hasText: name }).locator('visible=true').last();
const sendButton = (page: Page) =>
  page.getByRole('button', { name: 'Send', exact: true }).locator('visible=true').last();
const sendMenu = (page: Page) =>
  page.getByRole('button', { name: 'Send options' }).locator('visible=true').last();

test('the row composer sends on one line, with no send menu while idle', async ({ page }) => {
  await openRow(page);
  await composer(page).fill('hello');
  await expect(page.getByRole('button', { name: 'More send options' })).toHaveCount(0);
  await expect(sendMenu(page)).toHaveCount(0);
  const field = await composer(page).boundingBox();
  const send = await sendButton(page).boundingBox();
  // One row: send sits beside the field, not under it.
  expect(send && field && send.y < field.y + field.height).toBe(true);
  await composer(page).press('Enter');
  await expect(page.getByText('Fake reply on full to "hello"')).toBeVisible();
});

test('text that wraps puts the field on its own line, and an empty field brings the row back', async ({
  page,
}) => {
  await openRow(page);
  await composer(page).fill('a long line that keeps going '.repeat(12));
  await expect
    .poll(async () => {
      const field = await composer(page).boundingBox();
      const send = await sendButton(page).boundingBox();
      return Boolean(field && send && send.y >= field.y + field.height);
    })
    .toBe(true);
  await composer(page).fill('');
  await expect
    .poll(async () => {
      const field = await composer(page).boundingBox();
      const send = await sendButton(page).boundingBox();
      return Boolean(field && send && send.y < field.y + field.height);
    })
    .toBe(true);
});

test('while it replies, stop is on the working pill and send is off', async ({ page }) => {
  await openRow(page);
  await send(page, 'first [hold rowstop]');
  const working = pill(page, 'Working');
  await expect(working).toBeVisible();
  await expect(sendButton(page)).toBeDisabled();
  await working.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('interrupted')).toBeVisible();
  await expect(pill(page, 'Working')).toHaveCount(0);
});

test('a draft while it replies: Enter queues, and the one button opens the send menu', async ({
  page,
}) => {
  await openRow(page);
  await send(page, 'first [hold rowqueue]');
  await expect(pill(page, 'Working')).toBeVisible();
  await composer(page).fill('menu');
  await expect(sendButton(page)).toHaveCount(0);
  await sendMenu(page).click();
  for (const item of [/^Queue/, /^Steer this reply/, /^Send now/, /^Stash/])
    await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
  await page.keyboard.press('Escape');
  await composer(page).fill('after');
  await composer(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Collapse queued' })).toBeVisible();
  expect((await seen(page)).length).toBe(1);
  await release(page, 'rowqueue');
  await expect(page.getByText('Fake reply on full to "after"')).toBeVisible();
});

test('mod+shift+Enter sends now while it replies', async ({ page }) => {
  await openRow(page);
  await send(page, 'first [hold rownow]');
  await expect(pill(page, 'Working')).toBeVisible();
  await composer(page).fill('instead');
  await composer(page).press('ControlOrMeta+Shift+Enter');
  await expect(page.getByText('Fake reply on full to "instead"')).toBeVisible();
});

test('a background job shows as a pill until its result lands', async ({ page }) => {
  await openRow(page);
  await send(page, '[call slow_report {}]');
  await expect(pill(page, 'Slow report')).toBeVisible();
  await expect(page.getByText(/Fake reply on full/)).toBeVisible({ timeout: 10_000 });
  await expect(pill(page, 'Slow report')).toHaveCount(0);
});

test('while a step waits for approval, the send menu speaks of the step', async ({ page }) => {
  await openRow(page);
  await send(page, '[call wipe_desk {"confirm":true}]');
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(pill(page, 'Working')).toHaveCount(0);
  await composer(page).fill('meanwhile');
  await sendMenu(page).click();
  await expect(page.getByRole('menuitem', { name: /^Queue/ })).toContainText(
    'Send it once you answer the waiting step.',
  );
  await expect(page.getByRole('menuitem', { name: /^Send now/ })).toContainText(
    'Cancel the waiting step and send this instead.',
  );
  await expect(page.getByRole('menuitem', { name: /^Steer/ })).toHaveCount(0);
});

test('a staged file opens the drawer under the row, and the field stays in reach', async ({
  page,
}) => {
  await openRow(page);
  await page
    .locator('input[type=file]')
    .last()
    .setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
  await expect(page.getByRole('button', { name: 'Collapse attached' })).toBeVisible();
  // why: A click lands only on what is on top, so the drawer must not cover the field or send.
  await composer(page).click();
  await composer(page).fill('look');
  await sendButton(page).click();
  await expect(page.getByText('with 1 attached')).toBeVisible();
});

test('the working pill and the reply status count from the same start', async ({ page }) => {
  await openRow(page);
  await send(page, 'first [hold rowclock]');
  const working = page.getByText(/^Working for \d+s$/).locator('visible=true');
  // why: The pill and the status line read one clock; two clocks would differ once a second passes.
  await expect
    .poll(async () => {
      const shown = await working.allTextContents();
      const [first] = shown;
      return (
        shown.length >= 2 && first !== 'Working for 0s' && shown.every((text) => text === first)
      );
    })
    .toBe(true);
  await release(page, 'rowclock');
  await expect(page.getByText('Fake reply on full to "first [hold rowclock]"')).toBeVisible();
});

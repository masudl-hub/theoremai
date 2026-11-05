import type { Page } from '@playwright/test';
import { composer, expect, open, test } from './drive.ts';

/** How far the composer's content runs past its card, and whether send sits inside the card. */
const fitsCard = (page: Page) =>
  page
    .locator('.astryx-chat-composer')
    .locator('visible=true')
    .last()
    .evaluate((root) => {
      const card = root.firstElementChild as HTMLElement;
      const box = card.getBoundingClientRect();
      const send = card.querySelector('button[aria-label="Send"]')?.getBoundingClientRect();
      return {
        overflow: card.scrollWidth - card.clientWidth,
        sendInside: Boolean(send && send.left >= box.left && send.right <= box.right),
      };
    });

const FITS = { overflow: 0, sendInside: true };

test('a narrow composer folds its pickers to icons, and nothing leaves the card', async ({
  page,
}) => {
  await open(page, 'scout');
  await expect(composer(page)).toBeVisible();
  const source = page.getByRole('combobox', { name: 'Source' }).last();
  const picker = page.locator('.astryx-selector', { has: source });

  await expect(picker).toHaveText('Hugging Face Open Research');
  expect(await fitsCard(page)).toEqual(FITS);

  await page.setViewportSize({ width: 1000, height: 950 });
  await expect(picker).toHaveText('');
  expect(await fitsCard(page)).toEqual(FITS);
  await picker.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Source: Hugging Face Open Research');

  // A choice made while folded counts, and the picker still names itself.
  await picker.click();
  await page.getByRole('option', { name: 'arXiv' }).click();
  await expect(source).toHaveAccessibleName('Source');

  await page.setViewportSize({ width: 1600, height: 950 });
  await expect(picker).toHaveText('arXiv');
  expect(await fitsCard(page)).toEqual(FITS);
});

import { expect, open, test } from './drive.ts';

test('the code view refuses what the kernel refuses, on the line', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Editor', exact: true }).first().click();
  await page.getByRole('menuitem', { name: /^Code/ }).click();
  const editor = page.locator('.monaco-editor').first();

  await editor.getByText("'read-only'").first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText("\n  background: 'sometimes',");
  await expect(editor.locator('.squiggly-error').first()).toBeVisible();

  await page.keyboard.press('F8');
  await expect(editor.locator('.zone-widget')).toContainText('background');
  await expect(editor.locator('.zone-widget')).toContainText('sometimes');
  await page.keyboard.press('Escape');

  await editor.getByText('sometimes').dblclick();
  await page.keyboard.insertText('ask');
  await expect(editor.locator('.squiggly-error')).toHaveCount(0);
});

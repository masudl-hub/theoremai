import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  composer,
  expect,
  open,
  PROJECT,
  putProjectBack,
  release,
  seen,
  send,
  test,
} from './drive.ts';

const desk = path.join(PROJECT, 'agents/desk.ts');
const tools = path.join(PROJECT, 'tools.ts');
const team = path.join(PROJECT, 'agents/team.ts');
const originalTeam = readFileSync(team, 'utf8');
const original = readFileSync(desk, 'utf8');
const originalTools = readFileSync(tools, 'utf8');

const handle = (page: Page) => page.getByRole('textbox', { name: 'Handle' }).first();
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Prompt' }).first();
const saveToken = (page: Page) => page.getByRole('button', { name: 'Save', exact: true }).first();
const edited = (from: string, to: string) => original.replace(from, to);
const approve = (page: Page) => page.getByRole('button', { name: 'Approve' });
const ASKS = '[call wipe_desk {"confirm":true}]';

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
  await page
    .getByRole('region', { name: 'Notifications' })
    .getByRole('button', { name: 'Undo' })
    .click();
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

test('a file written during a reply loads when the reply ends, and the reply lives', async ({
  page,
}) => {
  await open(page);
  await send(page, 'first [hold reload]');
  await expect(page.getByText('Working', { exact: true })).toBeVisible();
  writeFileSync(desk, edited("handle: 'Desk'", "handle: 'Disk'"));
  await page.waitForTimeout(2500);
  await expect(handle(page)).toHaveValue('Desk');
  await release(page, 'reload');
  await expect(page.getByText('Fake reply on full to "first [hold reload]"')).toBeVisible();
  await expect(handle(page)).toHaveValue('Disk');
  await send(page, 'second');
  await expect(page.getByText('Fake reply on full to "second"')).toBeVisible();
});

test('stop ends a reply a written file waits for, and the file loads', async ({ page }) => {
  await open(page);
  await send(page, 'first [hold stopping]');
  await expect(page.getByText('Working', { exact: true })).toBeVisible();
  writeFileSync(desk, edited("handle: 'Desk'", "handle: 'Disk'"));
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('interrupted')).toBeVisible();
  await expect(handle(page)).toHaveValue('Disk');
});

test('both replies of a comparison outlive a written file', async ({ page }) => {
  await open(page);
  await prompt(page).fill('Answer in French.');
  await expect(page.getByText('Saved (your files)')).toBeVisible();
  await composer(page).fill('both [hold compare]');
  await composer(page).press('Enter');
  await expect(page.getByText('Working', { exact: true })).toHaveCount(2);
  writeFileSync(desk, edited("handle: 'Desk'", "handle: 'Disk'"));
  await page.waitForTimeout(2500);
  await release(page, 'compare');
  await expect(page.getByText('Fake reply on full to "both [hold compare]"')).toHaveCount(2);
});

test('a save made during a reply lands when the reply ends', async ({ page }) => {
  await open(page);
  await send(page, 'first [hold saving]');
  await expect(page.getByText('Working', { exact: true })).toBeVisible();
  await handle(page).fill('Deskx');
  await saveToken(page).click();
  const dialog = page.getByRole('dialog', { name: /Save to/ });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(1500);
  await release(page, 'saving');
  await expect(page.getByText('Fake reply on full to "first [hold saving]"')).toBeVisible();
  await expect(saveToken(page)).toBeHidden();
  await expect.poll(() => readFileSync(desk, 'utf8')).toContain("handle: 'Deskx'");
});

test('a gate outlives the file written under it, and its answer runs on the new load', async ({
  page,
}) => {
  await open(page);
  await send(page, ASKS);
  await expect(approve(page)).toBeVisible();
  writeFileSync(desk, edited("handle: 'Desk'", "handle: 'Disk'"));
  await expect(handle(page)).toHaveValue('Disk');
  await approve(page).click();
  await expect(page.getByText('Tool answered on full')).toBeVisible();
  await expect(page.getByText('no longer waiting')).toHaveCount(0);
});

test('a gate outlives a save', async ({ page }) => {
  await open(page);
  await send(page, ASKS);
  await expect(approve(page)).toBeVisible();
  await handle(page).fill('Deskx');
  await saveToken(page).click();
  const dialog = page.getByRole('dialog', { name: /Save to/ });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saveToken(page)).toBeHidden();
  await expect.poll(() => readFileSync(desk, 'utf8')).toContain("handle: 'Deskx'");
  await approve(page).click();
  await expect(page.getByText('Tool answered on full')).toBeVisible();
});

test('a gate whose tool the new load no longer has fails in plain words', async ({ page }) => {
  await open(page);
  await send(page, ASKS);
  await expect(approve(page)).toBeVisible();
  writeFileSync(tools, originalTools.replaceAll('wipe_desk', 'wipe_room'));
  writeFileSync(desk, original.replaceAll('wipe_desk', 'wipe_room'));
  await page.waitForTimeout(3000);
  await approve(page).click();
  await expect(page.getByText('Tool failed on full')).toBeVisible();
  const asked = (await seen(page)).at(-1)?.body.messages ?? [];
  expect(JSON.stringify(asked)).toContain("Tool 'wipe_desk' is not registered");
});

test('a background call goes on through a reload, and its result reaches the chat', async ({
  page,
}) => {
  await open(page);
  await send(page, '[call slow_report {}]');
  await expect(page.getByText(/Tool answered on full/)).toBeVisible();
  writeFileSync(desk, edited("handle: 'Desk'", "handle: 'Disk'"));
  await expect(handle(page)).toHaveValue('Disk');
  await page.waitForTimeout(2000);
  await page.reload();
  await page.getByRole('button', { name: 'desk', exact: true }).first().click();
  await page.getByRole('button', { name: /Worked for/ }).click();
  await page.getByRole('button', { name: /Slow report/ }).click();
  await expect(page.getByText('pages')).toBeVisible();
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

/** `team.ts` with the counters' `free` model made by one helper, as a project shares a model. */
function sharedFree(): string {
  const helper =
    "const lite = (effort: 'minimal' | 'low') => ({ protocol: 'openRouterOpenAi' as const, provider: 'router', apiId: 'fake/free', efforts: { normal: effort } });\n\n";
  const [head = '', front = '', back = ''] = originalTeam.split(
    /(?=export const (?:frontCounter|backCounter) )/,
  );
  const withFree = (part: string, effort: string) =>
    part.replace('  models: {\n', `  models: {\n    free: lite('${effort}'),\n`);
  const tail = back.split(/(?=export const triage )/);
  return `${head}${helper}${withFree(front, 'minimal')}${withFree(tail[0] ?? '', 'low')}${tail.slice(1).join('')}`;
}

test('taking a shared model out of one agent leaves it on the others', async ({ page }) => {
  writeFileSync(team, sharedFree());
  await open(page, 'front_counter');
  await page.getByRole('button', { name: 'free', exact: true }).first().click();
  await page.getByRole('button', { name: 'Remove model' }).click();
  await expect(page.getByText(/shared with|Change it for this profile only/)).toBeHidden();
  await saveToken(page).click();
  const dialog = page.getByRole('dialog', { name: /Save to/ });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved to agents/team.ts.').first()).toBeVisible();
  const written = readFileSync(team, 'utf8');
  expect(written).not.toContain("free: lite('minimal')");
  expect(written).toContain("free: lite('low')");
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

test('the alerts copy button sits on the first line, clear of its text', async ({ page }) => {
  await open(page);
  writeFileSync(desk, 'export const desk = (;\n');
  await page.getByText('1 alert').hover();
  const title = page.getByText('The studio cannot load your files.');
  const copy = page.getByRole('button', { name: 'Copy alerts' });
  await expect(copy).toBeVisible();
  await page.waitForTimeout(300);
  const [line, button] = await Promise.all([title.boundingBox(), copy.boundingBox()]);
  expect(Math.abs((button?.y ?? 0) - (line?.y ?? 0))).toBeLessThan(8);
  const width = await title.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().right;
  });
  expect(width).toBeLessThanOrEqual(button?.x ?? 0);
  writeFileSync(desk, original);
  await expect(page.getByText('1 alert')).toBeHidden();
});

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

export const FAKE = `http://127.0.0.1:${process.env.FAKE_MODEL_PORT}`;

export type SeenRequest = {
  url: string;
  authorization?: string;
  body: { model?: string; messages?: { role: string; content: unknown }[] };
};

export const seen = async (page: Page): Promise<SeenRequest[]> =>
  (await page.request.get(`${FAKE}/requests`)).json();

/** Lets a `[hold name]` reply finish. */
export const release = (page: Page, name: string) => page.request.post(`${FAKE}/release/${name}`);

/** The studio on `agent`, with no conversation left over from another test. */
export async function open(page: Page, agent = 'desk') {
  await page.goto(process.env.STUDIO_URL ?? '');
  await page.getByRole('button', { name: agent, exact: true }).first().click();
}

export const composer = (page: Page) => page.getByLabel('Message input').last();

export async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** Sends `text` by a choice in the menu beside send. */
export async function sendBy(page: Page, choice: string | RegExp, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'More send options' }).last().click();
  await page.getByRole('menuitem', { name: choice }).click();
}

test.beforeEach(async ({ page }) => {
  await page.request.delete(`${FAKE}/requests`);
});

/** The fixture's copy on disk, which Save writes. */
export const PROJECT = process.env.STUDIO_E2E_PROJECT ?? '';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'project');

const filesIn = (folder: string) =>
  readdirSync(folder, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'));

/** Every file of the fixture, to put back after a test that saves. */
const asItWas = new Map(
  filesIn(FIXTURE).map((file) => [file, readFileSync(path.join(FIXTURE, file), 'utf8')]),
);

/**
 * Puts the fixture back and waits for the running project to load it.
 * invariant: what a test wrote is gone from the running project before the next one opens it.
 */
export async function putProjectBack(page: Page) {
  for (const file of filesIn(PROJECT)) if (!asItWas.has(file)) rmSync(path.join(PROJECT, file));
  for (const [file, text] of asItWas) writeFileSync(path.join(PROJECT, file), text);
  await open(page);
  await expect(page.getByRole('textbox', { name: 'Handle' }).first()).toHaveValue('Desk');
  await expect(page.getByText(/\d+ alerts?$/)).toBeHidden();
  await page.close();
}

export { expect, test };

import { expect, open, seen, send, test } from './drive.ts';

test('a decision agent decides', async ({ page }) => {
  await open(page, 'triage');
  await page.getByRole('button', { name: 'Decide' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'ask' })).toContainText('90%');
  await expect(page.getByText('fake/decide')).toBeVisible();
  expect((await seen(page)).some((call) => call.url?.endsWith('/decisions'))).toBe(true);
});

test('an embedding agent indexes', async ({ page }) => {
  await open(page, 'index');
  await page.getByRole('button', { name: 'Index', exact: true }).click();
  await expect.poll(async () => (await seen(page)).length).toBeGreaterThan(0);
  await expect(page.getByText('29 documents', { exact: true })).toBeVisible();
  await expect(page.getByText('fake/embed')).toBeVisible();
  expect((await seen(page)).some((call) => call.url?.endsWith('/embeddings'))).toBe(true);
});

test('a host runs a tool', async ({ page }) => {
  await open(page, 'gatekeeper');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('PT', { exact: true })).toBeVisible();
  await expect(await seen(page)).toHaveLength(0);
});

test('an image agent draws', async ({ page }) => {
  await open(page, 'picture');
  await send(page, 'a red pixel');
  const drawn = page.getByRole('img', { name: 'Generated image' });
  await expect(drawn).toBeVisible();
  expect(await drawn.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  const [call] = await seen(page);
  expect(call.url).toContain('/images');
  expect(call.body).toMatchObject({ model: 'fake/image' });
});

test('a speech agent reads aloud', async ({ page }) => {
  await open(page, 'reader');
  await send(page, 'say this');
  await expect(page.getByRole('button', { name: 'Play voice.mp3' })).toBeVisible();
  const [call] = await seen(page);
  expect(call.url).toContain('/audio/speech');
  expect(call.body).toMatchObject({ model: 'fake/speech', input: 'say this', voice: 'alloy' });
});

test('a live agent hears the microphone, answers over its socket, and the call ends', async ({
  page,
}) => {
  await open(page, 'line');
  await page.getByRole('button', { name: 'Start voice call' }).click();
  await expect(page.getByText('listening')).toBeVisible();
  await expect
    .poll(async () =>
      (await seen(page)).some((call) => JSON.stringify(call.body).includes('"audio"')),
    )
    .toBe(true);
  await send(page, 'hello line');
  await expect(page.getByText(/Fake live to [\s\S]*hello line/)).toBeVisible();
  const said = await seen(page);
  expect(said.at(0)?.url).toContain('BidiGenerateContent');
  expect(said.at(0)?.body).toMatchObject({ setup: { model: 'models/fake-live' } });
  await page.getByRole('button', { name: 'End call' }).click();
  await expect(page.getByRole('button', { name: 'End call' })).toBeHidden();
});

test('a live call runs a tool as the person picked, and asks first', async ({ page }) => {
  await open(page, 'line');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('tree', { name: 'Settings' })
    .getByRole('button', { name: 'People' })
    .click();
  await page.getByRole('radio', { name: 'Ana of north' }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Start voice call' }).click();
  await expect(page.getByText('listening')).toBeVisible();
  await send(page, '[call file_note {"note":"from the call"}]');
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Live tool file_note answered')).toBeVisible();
  const answer = (await seen(page)).find((call) => 'toolResponse' in call.body);
  expect(JSON.stringify(answer?.body)).toContain('north-ana');
});

import { composer, expect, open, release, seen, send, sendBy, test } from './drive.ts';

const WRITE = '[call file_note {"note":"milk"}]';

test('a message gets the reply', async ({ page }) => {
  await open(page);
  await send(page, 'hello');
  await expect(page.getByText('Fake reply on full to "hello"')).toBeVisible();
});

test('a tool that reads runs without asking', async ({ page }) => {
  await open(page);
  await send(page, '[call lookup_city {"city":"Lisbon"}]');
  await expect(page.getByText('Tool answered on full')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test("a tool's image stands in the reply where the call ran", async ({ page }) => {
  await open(page);
  await send(page, '[call draw_city {"city":"Faro"}]');
  const image = page.getByRole('button', { name: 'Generated image' });
  const answer = page.getByText('Tool answered on full');
  await expect(answer).toBeVisible();
  await expect(image).toBeVisible();
  const above = async (locator: typeof image) => (await locator.boundingBox())?.y ?? 0;
  expect(await above(image)).toBeLessThan(await above(answer));
  await expect(page.getByRole('button', { name: /Worked for/ })).toBeVisible();
});

test('an approved write runs and the reply goes on', async ({ page }) => {
  await open(page);
  await send(page, WRITE);
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Tool answered on full')).toBeVisible();
  const asked = (await seen(page)).at(-1)?.body.messages ?? [];
  expect(JSON.stringify(asked.filter((message) => message.role === 'tool'))).toContain('filed');
});

test('a rejected write does not run and the reply goes on', async ({ page }) => {
  await open(page);
  await send(page, WRITE);
  await page.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Tool answered on full')).toBeVisible();
  const asked = (await seen(page)).at(-1)?.body.messages ?? [];
  expect(JSON.stringify(asked.filter((message) => message.role === 'tool'))).not.toContain(
    '"filed":true',
  );
});

test('stop ends a reply and the next message runs', async ({ page }) => {
  await open(page);
  await send(page, 'first [hold stop]');
  await expect(page.getByText('Working', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByText('interrupted')).toBeVisible();
  await send(page, 'second');
  await expect(page.getByText('Fake reply on full to "second"')).toBeVisible();
});

test('a queued message runs when the reply finishes', async ({ page }) => {
  await open(page);
  await send(page, 'first [hold queue]');
  await expect(page.getByText('Working', { exact: true })).toBeVisible();
  await sendBy(page, /^Queue/, 'after');
  await expect(page.getByRole('button', { name: 'Collapse queued' })).toBeVisible();
  expect((await seen(page)).length).toBe(1);
  await release(page, 'queue');
  await expect(page.getByText('Fake reply on full to "after"')).toBeVisible();
});

test('a steering message reaches the running reply', async ({ page }) => {
  await open(page);
  await send(page, '[call lookup_city {"city":"Porto"}] [hold steer]');
  await expect(page.getByText('Working', { exact: true })).toBeVisible();
  await sendBy(page, /^Steer/, '[steer] go north');
  await expect(page.getByRole('button', { name: 'Collapse steering' })).toBeVisible();
  await release(page, 'steer');
  await expect(page.getByText('Fake reply on full to "[steer] go north" steered')).toBeVisible();
  const asked = (await seen(page)).at(-1)?.body.messages ?? [];
  expect(asked.filter((message) => message.role === 'tool')).toHaveLength(1);
});

test('send now stops the reply and sends instead', async ({ page }) => {
  await open(page);
  await send(page, 'first [hold now]');
  await expect(page.getByText('Working', { exact: true })).toBeVisible();
  await sendBy(page, /^Send now/, 'instead');
  await expect(page.getByText('Fake reply on full to "instead"')).toBeVisible();
});

test('a stashed message waits and sends when asked', async ({ page }) => {
  await open(page);
  await sendBy(page, /^Stash/, 'for later');
  await expect(page.getByRole('button', { name: 'Collapse stashed' })).toBeVisible();
  await expect(composer(page)).toHaveText('');
  expect((await seen(page)).length).toBe(0);
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText('Fake reply on full to "for later"')).toBeVisible();
});

test('an attached image reaches the model', async ({ page }) => {
  await open(page);
  const PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await page
    .locator('input[type=file]')
    .last()
    .setInputFiles({
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PIXEL, 'base64'),
    });
  await expect(page.getByRole('button', { name: 'Collapse attached' })).toBeVisible();
  await send(page, 'look');
  await expect(page.getByText('with 1 attached')).toBeVisible();
});

test('a model that fails says so and the next message runs', async ({ page }) => {
  await open(page);
  await send(page, '[fail 400]');
  await page.getByText('failed', { exact: true }).hover();
  await expect(page.getByText('the fake model failed on purpose')).toBeVisible();
  await send(page, 'again');
  await expect(page.getByText('Fake reply on full to "again"')).toBeVisible();
});

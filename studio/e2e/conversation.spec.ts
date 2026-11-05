import { composer, expect, open, seen, send, test } from './drive.ts';

test('a reload brings the conversation back and it goes on', async ({ page }) => {
  await open(page);
  await send(page, 'remember this');
  await expect(page.getByText('Fake reply on full to "remember this"')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'desk', exact: true }).first().click();
  await expect(page.getByText('Fake reply on full to "remember this"')).toBeVisible();
  await send(page, 'and this');
  await expect(page.getByText('Fake reply on full to "and this"')).toBeVisible();
  const said = JSON.stringify((await seen(page)).at(-1)?.body.messages);
  expect(said).toContain('remember this');
});

test('clear history empties the chat, and the model forgets', async ({ page }) => {
  await open(page);
  await send(page, 'forget this');
  await expect(page.getByText('Fake reply on full to "forget this"')).toBeVisible();
  await page.getByRole('button', { name: 'Clear history' }).click();
  await expect(page.getByText('What are we working on?')).toBeVisible();
  await send(page, 'fresh');
  await expect(page.getByText('Fake reply on full to "fresh"')).toBeVisible();
  expect(JSON.stringify((await seen(page)).at(-1)?.body.messages)).not.toContain('forget this');
});

test('the trace shows the run', async ({ page }) => {
  await open(page);
  await send(page, '[call lookup_city {"city":"Faro"}]');
  await expect(page.getByText('Tool answered on full')).toBeVisible();
  await page.getByRole('button', { name: 'View trace' }).click();
  await expect(page.getByRole('button', { name: 'Download trace' })).toBeVisible();
  await expect(page.getByRole('button', { name: /fake\/full Asked for 1 tool/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Answered Tool answered on full/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /lookup_city city: Faro/ })).toBeVisible();
});

test('each agent keeps its own conversation', async ({ page }) => {
  await open(page);
  await send(page, 'for desk');
  await expect(page.getByText('Fake reply on full to "for desk"')).toBeVisible();
  await page.getByRole('button', { name: 'concierge', exact: true }).first().click();
  await expect(page.getByText('Fake reply on full to "for desk"')).toBeHidden();
  await send(page, 'for concierge');
  await expect(page.getByText('Fake reply on full to "for concierge"')).toBeVisible();
  await page.getByRole('button', { name: 'desk', exact: true }).first().click();
  await expect(page.getByText('Fake reply on full to "for desk"')).toBeVisible();
});

test('a new tab runs the agent, and goes on after the studio tab closes', async ({
  context,
  page,
}) => {
  await open(page);
  const [run] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('button', { name: 'Open in a new tab' }).click(),
  ]);
  await expect(composer(run)).toBeVisible();
  await send(run, 'in its own tab');
  await expect(run.getByText('Fake reply on full to "in its own tab"')).toBeVisible();
  await page.close();
  await run.reload();
  await send(run, 'after the studio closed');
  await expect(run.getByText('Fake reply on full to "after the studio closed"')).toBeVisible();
});

test('a key given in the studio is never stored', async ({ page }) => {
  await open(page);
  await send(page, 'hello');
  await expect(page.getByText('Fake reply on full to "hello"')).toBeVisible();
  const kept = await page.evaluate(async () => {
    const rows: unknown[] = [];
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await new Promise<IDBDatabase>((done, failed) => {
        const opening = indexedDB.open(name);
        opening.onsuccess = () => done(opening.result);
        opening.onerror = () => failed(opening.error);
      });
      for (const store of db.objectStoreNames) {
        const all = db.transaction(store).objectStore(store).getAll();
        rows.push(await new Promise((done) => (all.onsuccess = () => done(all.result))));
      }
    }
    return JSON.stringify([rows, { ...localStorage }, { ...sessionStorage }]);
  });
  expect(kept).not.toContain('fixture-placeholder');
});

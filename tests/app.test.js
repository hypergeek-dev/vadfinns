import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withServer(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vad-finns-test-'));
  const emptySeed = await mkdtemp(path.join(os.tmpdir(), 'vad-finns-seed-'));
  const { app } = await createApp({ dataDir, seedDir: emptySeed, adminPassword: 'test-password-long', sessionSecret: 'test-session-secret-that-is-long-enough' });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, dataDir }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([rm(dataDir, { recursive: true, force: true }), rm(emptySeed, { recursive: true, force: true })]);
  }
}

async function login(base) {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-long' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrfToken };
}

test('publika sidor och tomt matbibliotek fungerar', async () => {
  await withServer(async ({ base }) => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Kan du köpa\?/);
    const response = await fetch(`${base}/api/foods?available=true`);
    assert.deepEqual(await response.json(), { foods: [] });
  });
});

test('admin kräver inloggning och CSRF för ändringar', async () => {
  await withServer(async ({ base }) => {
    const denied = await fetch(`${base}/api/admin/foods/missing`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
    const session = await login(base);
    const csrfDenied = await fetch(`${base}/api/admin/foods/missing`, { method: 'PATCH', headers: { Cookie: session.cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(csrfDenied.status, 403);
  });
});

test('uppladdning, tillgänglighet och beständig lagring fungerar', async () => {
  await withServer(async ({ base, dataDir }) => {
    const session = await login(base);
    const source = await readFile(path.join(projectRoot, 'assets', 'Fresh Apple on White Plate.png'));
    const form = new FormData();
    form.set('name', 'Testäpple');
    form.set('image', new Blob([source], { type: 'image/png' }), 'apple.png');
    const createdResponse = await fetch(`${base}/api/admin/foods`, { method: 'POST', headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf }, body: form });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).food;
    assert.equal(created.available, false);

    const changed = await fetch(`${base}/api/admin/foods/${created.id}`, {
      method: 'PATCH', headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ available: true })
    });
    assert.equal(changed.status, 200);
    const publicList = await fetch(`${base}/api/foods?available=true`).then((response) => response.json());
    assert.equal(publicList.foods[0].name, 'Testäpple');
    const persisted = JSON.parse(await readFile(path.join(dataDir, 'foods.json'), 'utf8'));
    assert.equal(persisted[0].available, true);
  });
});

test('identiska bilder läggs inte till två gånger', async () => {
  await withServer(async ({ base }) => {
    const session = await login(base);
    const source = await readFile(path.join(projectRoot, 'assets', 'Fresh Apple on White Plate.png'));
    for (const expected of [201, 409]) {
      const form = new FormData();
      form.set('image', new Blob([source], { type: 'image/png' }), 'apple.png');
      const response = await fetch(`${base}/api/admin/foods`, { method: 'POST', headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf }, body: form });
      assert.equal(response.status, expected);
    }
  });
});

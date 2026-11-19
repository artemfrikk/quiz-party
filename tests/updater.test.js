import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yazl from 'yazl';
import { applyUpdate, checkForUpdate, compareVersions, downloadUpdate, assetName } from '../src/updater.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')); }

function makeZip(file, entries) {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const [name, text] of Object.entries(entries)) z.addBuffer(Buffer.from(text), name);
    z.end();
    z.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
  });
}

test('compareVersions', () => {
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('v2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

const release = (tag) => ({
  tag_name: tag, body: 'что нового',
  assets: [
    { name: assetName(tag.slice(1)), browser_download_url: 'https://x/zip' },
    { name: assetName(tag.slice(1)) + '.sha256', browser_download_url: 'https://x/sha' },
  ],
});
const jsonRes = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('checkForUpdate finds newer release only', async () => {
  const f = async () => jsonRes(200, release('v1.1.0'));
  const u = await checkForUpdate({ repo: 'a/b', current: '1.0.0', fetchImpl: f });
  assert.deepEqual([u.version, u.zipUrl, u.shaUrl], ['1.1.0', 'https://x/zip', 'https://x/sha']);
  assert.equal(await checkForUpdate({ repo: 'a/b', current: '1.1.0', fetchImpl: f }), null);
  assert.equal(await checkForUpdate({ repo: 'a/b', current: '1.0.0', fetchImpl: async () => jsonRes(404, {}) }), null);
  await assert.rejects(checkForUpdate({ repo: 'a/b', current: '1.0.0', fetchImpl: async () => jsonRes(500, {}) }));
});

test('downloadUpdate verifies sha256', async () => {
  const dir = tmp();
  const body = Buffer.from('zip-bytes');
  const sha = createHash('sha256').update(body).digest('hex');
  const mk = (shaText) => async (url) => (url.endsWith('sha')
    ? { ok: true, status: 200, text: async () => `${shaText}  file.zip\n` }
    : { ok: true, status: 200, body: new Response(body).body });
  const info = { version: '1.1.0', zipUrl: 'https://x/zip', shaUrl: 'https://x/sha' };
  const file = await downloadUpdate(info, dir, mk(sha));
  assert.equal(fs.readFileSync(file, 'utf8'), 'zip-bytes');
  await assert.rejects(downloadUpdate(info, path.join(dir, 'b'), mk('0'.repeat(64))), /BadChecksum/);
});

test('applyUpdate replaces code, keeps quizzes, data, runtime and launchers', async () => {
  const app = tmp();
  fs.mkdirSync(path.join(app, 'src'));
  fs.writeFileSync(path.join(app, 'src', 'old.js'), 'old');
  fs.writeFileSync(path.join(app, 'server.js'), 'old server');
  fs.mkdirSync(path.join(app, 'quizzes', 'Мой'), { recursive: true });
  fs.writeFileSync(path.join(app, 'quizzes', 'Мой', 'quiz.json'), '{}');
  fs.mkdirSync(path.join(app, 'data'));
  fs.writeFileSync(path.join(app, 'data', 'settings.json'), '{"x":1}');
  fs.writeFileSync(path.join(app, 'start.bat'), 'old bat');
  const zip = path.join(tmp(), 'u.zip');
  await makeZip(zip, {
    'src/new.js': 'new', 'server.js': 'new server', 'public/a.html': 'a',
    'quizzes/evil/quiz.json': 'x', 'data/settings.json': 'x', 'start.bat': 'new bat',
  });
  await applyUpdate(app, zip);
  assert.equal(fs.existsSync(path.join(app, 'src', 'old.js')), false);
  assert.equal(fs.readFileSync(path.join(app, 'src', 'new.js'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), 'new server');
  assert.equal(fs.readFileSync(path.join(app, 'public', 'a.html'), 'utf8'), 'a');
  assert.equal(fs.existsSync(path.join(app, 'quizzes', 'Мой', 'quiz.json')), true);
  assert.equal(fs.existsSync(path.join(app, 'quizzes', 'evil')), false);
  assert.equal(fs.readFileSync(path.join(app, 'data', 'settings.json'), 'utf8'), '{"x":1}');
  assert.equal(fs.readFileSync(path.join(app, 'start.bat'), 'utf8'), 'old bat');
  assert.deepEqual(fs.readdirSync(app).filter((n) => n.startsWith('.update')), []);
});

test('applyUpdate rejects traversal and incomplete archives without touching the app', async () => {
  const app = tmp();
  fs.mkdirSync(path.join(app, 'src'));
  fs.writeFileSync(path.join(app, 'server.js'), 'old');
  const bad = path.join(tmp(), 'bad.zip');
  await makeZip(bad, { 'src/x.js': 'x', 'server.js': 's', 'src/AAAAAA': 'x' });
  // yazl не даёт создать «..» — подменяем байты имени той же длины
  const buf = fs.readFileSync(bad);
  fs.writeFileSync(bad, Buffer.from(buf.toString('latin1').replaceAll('src/AAAAAA', 'src/../../').replace(/x/g, 'x'), 'latin1'));
  await assert.rejects(applyUpdate(app, bad), /BadArchive/);
  const partial = path.join(tmp(), 'p.zip');
  await makeZip(partial, { 'public/a.html': 'a' });
  await assert.rejects(applyUpdate(app, partial), /BadArchive/);
  assert.equal(fs.readFileSync(path.join(app, 'server.js'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(app).filter((n) => n.startsWith('.update')), []);
});

// Автообновление из GitHub Releases: маленький архив с кодом, Node.js не меняется.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';

// Что заменяется при обновлении. quizzes/, data/, runtime/ не трогаем никогда.
// start.bat/start.command не заменяем: они работают, пока идёт обновление.
export const UPDATABLE = ['src', 'public', 'node_modules', 'server.js', 'package.json', 'package-lock.json', 'README.md'];

export const assetName = (version) => `quiz-party-update-${version}.zip`;

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const UA = { 'user-agent': 'quiz-party-updater', accept: 'application/vnd.github+json' };

// null — обновления нет; иначе {version, notes, zipUrl, shaUrl}
export async function checkForUpdate({ repo, current, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: UA });
  if (res.status === 404) return null; // релизов ещё нет
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name ?? '').replace(/^v/, '');
  if (!version || compareVersions(version, current) <= 0) return null;
  const zip = rel.assets?.find((a) => a.name === assetName(version));
  const sha = rel.assets?.find((a) => a.name === assetName(version) + '.sha256');
  if (!zip || !sha) return null;
  return { version, notes: String(rel.body ?? '').slice(0, 2000), zipUrl: zip.browser_download_url, shaUrl: sha.browser_download_url };
}

export async function downloadUpdate(info, dir, fetchImpl = fetch) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, assetName(info.version));
  const shaRes = await fetchImpl(info.shaUrl, { headers: { 'user-agent': UA['user-agent'] } });
  if (!shaRes.ok) throw new Error(`Контрольная сумма: HTTP ${shaRes.status}`);
  const expected = (await shaRes.text()).trim().split(/\s+/)[0].toLowerCase();
  const res = await fetchImpl(info.zipUrl, { headers: { 'user-agent': UA['user-agent'] } });
  if (!res.ok) throw new Error(`Скачивание: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  if (h.digest('hex') !== expected) {
    await fsp.rm(file, { force: true });
    throw new Error('BadChecksum');
  }
  return file;
}

async function extract(zipPath, dest) {
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true, decodeStrings: true }).catch(() => { throw new Error('BadArchive'); });
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', () => reject(new Error('BadArchive')));
      zip.on('end', resolve);
      zip.on('entry', (e) => {
        const name = e.fileName;
        const top = name.split('/')[0];
        if (name.includes('\\') || name.split('/').includes('..') || path.isAbsolute(name) || /^[a-z]:/i.test(name)) {
          return reject(new Error('BadArchive'));
        }
        if (!UPDATABLE.includes(top) || name.endsWith('/')) return zip.readEntry();
        const out = path.join(dest, ...name.split('/'));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        zip.openReadStream(e, (err, s) => {
          if (err) return reject(err);
          pipeline(s, fs.createWriteStream(out)).then(() => zip.readEntry(), reject);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

// Распаковывает во временную папку и заменяет только UPDATABLE. При ошибке всё возвращается как было.
export async function applyUpdate(appDir, zipPath) {
  const id = randomUUID().slice(0, 8);
  const staging = path.join(appDir, `.update-new-${id}`);
  const backup = path.join(appDir, `.update-old-${id}`);
  await fsp.mkdir(staging, { recursive: true });
  try {
    await extract(zipPath, staging);
    if (!fs.existsSync(path.join(staging, 'server.js')) || !fs.existsSync(path.join(staging, 'src'))) throw new Error('BadArchive');
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw e;
  }
  await fsp.mkdir(backup, { recursive: true });
  const moved = [];
  try {
    for (const name of UPDATABLE) {
      const fresh = path.join(staging, name);
      if (!fs.existsSync(fresh)) continue;
      const cur = path.join(appDir, name);
      if (fs.existsSync(cur)) await fsp.rename(cur, path.join(backup, name));
      moved.push(name);
      await fsp.rename(fresh, cur);
    }
  } catch (e) {
    // откат
    for (const name of moved.reverse()) {
      const cur = path.join(appDir, name);
      await fsp.rm(cur, { recursive: true, force: true }).catch(() => {});
      if (fs.existsSync(path.join(backup, name))) await fsp.rename(path.join(backup, name), cur).catch(() => {});
    }
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(backup, { recursive: true, force: true }).catch(() => {}); // на Windows может не удалиться — уберём при следующем запуске
}

// Остатки прошлых обновлений
export function cleanupLeftovers(appDir) {
  for (const e of fs.readdirSync(appDir)) {
    if (/^\.update-(new|old)-/.test(e)) fs.rmSync(path.join(appDir, e), { recursive: true, force: true });
  }
}

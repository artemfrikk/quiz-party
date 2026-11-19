// Собирает dist/quiz-party-portable.zip: приложение + рабочие зависимости + официальный Node.js
// для Mac (Apple M и Intel) и Windows. Запуск: npm run portable
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import yauzl from 'yauzl';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'node');
const OUT = path.join(ROOT, 'dist', 'quiz-party-portable.zip');
const VERSION = process.version; // та же версия, на которой всё проверено
const BASE = `https://nodejs.org/dist/${VERSION}`;

const TARGETS = [
  { dir: 'darwin-arm64', archive: `node-${VERSION}-darwin-arm64.tar.gz`, member: `node-${VERSION}-darwin-arm64/bin/node`, out: 'node' },
  { dir: 'darwin-x64', archive: `node-${VERSION}-darwin-x64.tar.gz`, member: `node-${VERSION}-darwin-x64/bin/node`, out: 'node' },
  { dir: 'win-x64', archive: `node-${VERSION}-win-x64.zip`, member: `node-${VERSION}-win-x64/node.exe`, out: 'node.exe' },
];

async function download(url, dest) {
  if (fs.existsSync(dest)) return;
  console.log('Скачиваю', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest + '.part'));
  await fsp.rename(dest + '.part', dest);
}

async function sha256(file) {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

async function extractFromZip(zipPath, member, dest) {
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true });
  await new Promise((resolve, reject) => {
    zip.on('entry', (e) => {
      if (e.fileName !== member) return zip.readEntry();
      zip.openReadStream(e, (err, s) => {
        if (err) return reject(err);
        pipeline(s, fs.createWriteStream(dest)).then(resolve, reject);
      });
    });
    zip.on('end', () => reject(new Error(`${member} не найден в ${zipPath}`)));
    zip.readEntry();
  });
  zip.close();
}

async function prepareRuntimes() {
  await fsp.mkdir(CACHE, { recursive: true });
  const sumsFile = path.join(CACHE, `SHASUMS256-${VERSION}.txt`);
  await download(`${BASE}/SHASUMS256.txt`, sumsFile);
  const sums = Object.fromEntries((await fsp.readFile(sumsFile, 'utf8')).trim().split('\n').map((l) => l.split(/\s+/).reverse()));
  const result = [];
  for (const t of TARGETS) {
    const archive = path.join(CACHE, t.archive);
    await download(`${BASE}/${t.archive}`, archive);
    const actual = await sha256(archive);
    if (actual !== sums[t.archive]) {
      await fsp.rm(archive, { force: true });
      throw new Error(`Контрольная сумма ${t.archive} не совпала — файл удалён, запустите сборку снова`);
    }
    const binDir = path.join(CACHE, t.dir);
    const bin = path.join(binDir, t.out);
    if (!fs.existsSync(bin)) {
      await fsp.mkdir(binDir, { recursive: true });
      if (t.archive.endsWith('.zip')) await extractFromZip(archive, t.member, bin);
      else {
        // относительные пути: GNU tar принимает «W:» за адрес удалённого сервера
        execFileSync('tar', ['-xzf', t.archive, '-C', t.dir, t.member], { cwd: CACHE });
        await fsp.rename(path.join(binDir, t.member), bin);
        await fsp.rm(path.join(binDir, t.member.split('/')[0]), { recursive: true, force: true });
      }
    }
    result.push({ ...t, bin });
  }
  return result;
}

export function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export function prodPackageDirs() {
  const out = execSync('npm ls --omit=dev --all --parseable', { cwd: ROOT, encoding: 'utf8' });
  return [...new Set(out.trim().split(/\r?\n/).filter((p) => p && path.resolve(p) !== ROOT))];
}

export const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
export const SKIP = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.tmp$/i;
export const zipOpts = (name, mode = 0o100644) => ({ mode, compress: !/\.(mp4|webm|mov|jpe?g|png|gif|webp|zip)$/i.test(name) });

async function main() {
  const runtimes = await prepareRuntimes();
  await fsp.mkdir(path.dirname(OUT), { recursive: true });
  const zip = new yazl.ZipFile();
  const seen = new Set(); // вложенные пакеты npm встречаются дважды
  const add = (abs, name, mode = 0o100644) => !seen.has(name) && seen.add(name) && zip.addFile(abs, `quiz-party/${name}`, zipOpts(name, mode));

  for (const f of ['README.md', 'package.json', 'package-lock.json', 'server.js', 'start.bat']) add(path.join(ROOT, f), f);
  add(path.join(ROOT, 'start.command'), 'start.command', 0o100755);
  // квизов в сборке нет: папка quizzes появится пустой при первом запуске
  for (const d of ['src', 'public']) for (const f of walk(path.join(ROOT, d))) if (!SKIP.test(rel(f))) add(f, rel(f));
  for (const pkg of prodPackageDirs()) for (const f of walk(pkg)) if (!SKIP.test(rel(f))) add(f, rel(f));
  for (const r of runtimes) add(r.bin, `runtime/${r.dir}/${r.out}`, r.out === 'node' ? 0o100755 : 0o100644);

  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(OUT));
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(0);
  console.log(`Готово: ${OUT} (${mb} МБ), Node.js ${VERSION}`);
}

export { main as buildPortable };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

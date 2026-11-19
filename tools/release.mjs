// Выпуск новой версии: npm run release -- "что нового"
// 1) тесты; 2) архив обновления (~1–2 МБ) и полная переносная сборка;
// 3) код публикуется в GitHub (одним коммитом на версию, без локальной истории);
// 4) GitHub Release с тегом v<версия> — приложения у всех увидят его на пульте.
// Перед выпуском поднимите "version" в package.json.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { ROOT, SKIP, buildPortable, prodPackageDirs, rel, walk, zipOpts } from './build-portable.mjs';
import { UPDATABLE, assetName } from '../src/updater.js';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { version, updateRepo: repo } = pkg;
const tag = `v${version}`;
const notes = process.argv.slice(2).join(' ').trim() || `Версия ${version}`;
const DIST = path.join(ROOT, 'dist');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })?.trim() ?? '';
const tryRun = (cmd, args, opts) => { try { return run(cmd, args, opts); } catch { return null; } };
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };

async function buildUpdateZip() {
  const file = path.join(DIST, assetName(version));
  const zip = new yazl.ZipFile();
  const seen = new Set();
  const add = (abs, name) => { if (!seen.has(name) && !SKIP.test(name)) { seen.add(name); zip.addFile(abs, name, zipOpts(name)); } };
  for (const item of UPDATABLE.filter((n) => n !== 'node_modules')) {
    const abs = path.join(ROOT, item);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) for (const f of walk(abs)) add(f, rel(f));
    else add(abs, item);
  }
  for (const pkgDir of prodPackageDirs()) for (const f of walk(pkgDir)) add(f, rel(f));
  zip.end();
  await pipeline(zip.outputStream, fs.createWriteStream(file));
  const sha = createHash('sha256').update(await fsp.readFile(file)).digest('hex');
  await fsp.writeFile(file + '.sha256', `${sha}  ${path.basename(file)}\n`);
  return file;
}

async function main() {
  if (!repo) fail('В package.json нет updateRepo');
  if (run('git', ['status', '--porcelain', '--untracked-files=no'])) fail('Есть незакоммиченные изменения — сначала закоммитьте их');
  if (tryRun('gh', ['release', 'view', tag, '--repo', repo])) fail(`Версия ${tag} уже выпущена — поднимите "version" в package.json`);

  console.log('Тесты…');
  try { run(process.execPath, ['--test'], { stdio: 'inherit' }); } catch { fail('Тесты не прошли'); }

  await fsp.mkdir(DIST, { recursive: true });
  console.log('Архив обновления…');
  const updateZip = await buildUpdateZip();
  console.log('Переносная сборка…');
  await buildPortable();
  const portable = path.join(DIST, 'quiz-party-portable.zip');

  // Публичная история: по одному коммиту на версию поверх прошлого релиза
  console.log('Публикую код…');
  const login = run('gh', ['api', 'user', '--jq', '.login']);
  const id = run('gh', ['api', 'user', '--jq', '.id']);
  const who = { GIT_AUTHOR_NAME: login, GIT_AUTHOR_EMAIL: `${id}+${login}@users.noreply.github.com` };
  const env = { ...process.env, ...who, GIT_COMMITTER_NAME: who.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: who.GIT_AUTHOR_EMAIL };
  const remote = `https://github.com/${repo}.git`;
  tryRun('git', ['fetch', '--quiet', remote, 'main:refs/remotes/public/main']);
  const parent = tryRun('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/public/main']);
  const commit = run('git', ['commit-tree', 'HEAD^{tree}', ...(parent ? ['-p', parent] : []), '-m', `${tag}: ${notes}`], { env });
  run('git', ['push', '--quiet', remote, `${commit}:refs/heads/main`]);
  run('git', ['update-ref', 'refs/remotes/public/main', commit]);

  console.log('Создаю релиз…');
  run('gh', ['release', 'create', tag, '--repo', repo, '--target', commit, '--title', `Версия ${version}`, '--notes', notes,
    updateZip, updateZip + '.sha256', portable]);
  console.log(`\n✓ Выпущена версия ${version}: https://github.com/${repo}/releases/tag/${tag}`);
  console.log('  Пульты у всех покажут «Доступна новая версия» при следующем запуске.');
}

main().catch((e) => fail(e.stderr?.toString() || e.message));

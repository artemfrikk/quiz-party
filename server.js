import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './src/app.js';
import { getLanAddresses } from './src/network.js';
import fs from 'node:fs';
import { applyUpdate, checkForUpdate, cleanupLeftovers, downloadUpdate } from './src/updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3737;
const hostUrl = `http://localhost:${port}/host/`;

// Открыть пульт в браузере по умолчанию (Windows, macOS, Linux)
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' }).unref();
  } catch { /* браузер можно открыть вручную */ }
}
const shouldOpen = process.argv.includes('--open');

const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
try { cleanupLeftovers(here); } catch { /* не страшно */ }
// Код 42 — сигнал start.bat/start.command запустить сервер заново (уже с новой версией)
const update = pkg.updateRepo ? {
  current: pkg.version,
  check: () => checkForUpdate({ repo: pkg.updateRepo, current: pkg.version }),
  download: (info, dir) => downloadUpdate(info, dir),
  apply: (zip) => applyUpdate(here, zip),
  restart: () => { console.log('\nОбновление установлено, перезапускаю…\n'); process.exit(42); },
} : null;

try {
  const srv = await createServer({ quizzesDir: path.join(here, 'quizzes'), dataDir: path.join(here, 'data'), port, update });
  console.log(`\nКвиз запущен! Версия ${pkg.version}`);
  console.log(`  Пульт ведущего:   ${srv.url}/host/`);
  console.log(`  Редактор квизов:  ${srv.url}/editor/`);
  for (const a of getLanAddresses()) console.log(`  Для телефонов (${a.name}): http://${a.address}:${srv.port}/play/`);
  console.log('\nНе закрывайте это окно во время игры.\n');
  if (shouldOpen) openBrowser(hostUrl);
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.error(`Порт ${port} занят — скорее всего, квиз уже запущен в другом окне. Открываю пульт.`);
    if (shouldOpen) openBrowser(hostUrl);
  } else console.error(e);
  process.exitCode = 1;
}

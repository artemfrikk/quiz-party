// Квиз одним файлом: <имя>.quiz.zip = quiz.json + media/*
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { isSafeName, mediaDir } from './quizStore.js';

const MAX_TOTAL = 2 * 1024 ** 3;
const MAX_QUIZ_JSON = 5 * 1024 ** 2;

export function exportQuiz(dir, name) {
  if (!isSafeName(name)) throw new Error('BadName');
  const quizFile = path.join(dir, name, 'quiz.json');
  if (!fs.existsSync(quizFile)) throw new Error('NotFound');
  const zip = new yazl.ZipFile();
  zip.addFile(quizFile, 'quiz.json');
  const media = mediaDir(dir, name);
  if (fs.existsSync(media)) {
    for (const f of fs.readdirSync(media, { withFileTypes: true })) {
      // видео уже сжаты — не тратим время на повторное сжатие
      if (f.isFile() && isSafeName(f.name)) zip.addFile(path.join(media, f.name), `media/${f.name}`, { compress: !/\.(mp4|webm|mov|m4v|jpe?g|png|gif|webp)$/i.test(f.name) });
    }
  }
  zip.end();
  return zip.outputStream;
}

export function nameFromArchive(fileName) {
  const base = String(fileName ?? '').split(/[\\/]/).pop()
    .replace(/\.quiz\.zip$/i, '').replace(/\.zip$/i, '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
  return isSafeName(base) ? base : 'Квиз';
}

const isJunk = (p) => p.startsWith('__MACOSX/') || /(^|\/)(\.DS_Store|\._[^/]*|Thumbs\.db|desktop\.ini)$/i.test(p);

function readAll(zipfile, entry, limit) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > limit) { stream.destroy(); reject(new Error('BadArchive')); } else chunks.push(c);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

function extract(zipfile, entry, dest) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      pipeline(stream, fs.createWriteStream(dest)).then(resolve, reject);
    });
  });
}

async function listEntries(zipfile) {
  return new Promise((resolve, reject) => {
    const out = [];
    zipfile.on('entry', (e) => { out.push(e); zipfile.readEntry(); });
    zipfile.on('end', () => resolve(out));
    zipfile.on('error', reject);
    zipfile.readEntry();
  });
}

function uniqueName(dir, base) {
  if (!fs.existsSync(path.join(dir, base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`.slice(-80);
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/** Распаковывает квиз в dir. Возвращает { name }. Ошибка 'BadArchive', если это не квиз или архив опасный. */
export async function importQuiz(dir, zipPath, suggestedName) {
  let zipfile;
  try {
    zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false, strictFileNames: false });
  } catch {
    throw new Error('BadArchive');
  }
  const tmp = path.join(dir, `.import-${randomUUID()}`);
  try {
    let raw;
    try { raw = await listEntries(zipfile); } catch { throw new Error('BadArchive'); }
    const entries = raw
      .map((e) => ({ e, p: e.fileName.normalize('NFC').replace(/\\/g, '/') }))
      .filter(({ p }) => !p.endsWith('/') && !isJunk(p));

    // если архив сделали вручную из папки — внутри одна общая папка
    let prefix = '';
    if (!entries.some(({ p }) => p === 'quiz.json')) {
      const q = entries.find(({ p }) => /^[^/]+\/quiz\.json$/.test(p));
      if (!q) throw new Error('BadArchive');
      prefix = q.p.slice(0, -'quiz.json'.length);
    }

    let total = 0;
    let quizEntry = null;
    const media = [];
    for (const { e, p } of entries) {
      if (p.startsWith('/') || p.split('/').includes('..') || /^[a-z]:/i.test(p)) throw new Error('BadArchive');
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      total += e.uncompressedSize;
      if (rel === 'quiz.json') quizEntry = e;
      else if (/^media\/[^/]+$/.test(rel) && isSafeName(rel.slice(6))) media.push({ e, file: rel.slice(6) });
    }
    if (!quizEntry || total > MAX_TOTAL) throw new Error('BadArchive');

    let quiz;
    try { quiz = JSON.parse((await readAll(zipfile, quizEntry, MAX_QUIZ_JSON)).toString('utf8')); } catch { throw new Error('BadArchive'); }
    if (!quiz || typeof quiz !== 'object' || !Array.isArray(quiz.slides)) throw new Error('BadArchive');

    await fsp.mkdir(path.join(tmp, 'media'), { recursive: true });
    await fsp.writeFile(path.join(tmp, 'quiz.json'), JSON.stringify(quiz, null, 2), 'utf8');
    for (const { e, file } of media) await extract(zipfile, e, path.join(tmp, 'media', file));

    const name = uniqueName(dir, nameFromArchive(suggestedName));
    await fsp.rename(tmp, path.join(dir, name));
    return { name };
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw err;
  } finally {
    zipfile.close();
  }
}

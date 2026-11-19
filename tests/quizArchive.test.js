import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { exportQuiz, importQuiz, nameFromArchive } from '../src/quizArchive.js';
import { saveQuiz, loadQuiz, mediaDir, listQuizzes } from '../src/quizStore.js';

const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'qa-'));
const quiz = { title: 'Видео', slides: [{ id: 's', type: 'info', text: 'x', media: { kind: 'image', src: 'media/йод.png' } }] };

async function makeZip(file, entries) {
  const z = new yazl.ZipFile();
  for (const [name, content] of entries) z.addBuffer(Buffer.from(content), name);
  z.end();
  await pipeline(z.outputStream, fs.createWriteStream(file));
}

test('export then import on another machine keeps quiz and media', async () => {
  const a = await tmp();
  const b = await tmp();
  await saveQuiz(a, 'Мой квиз', quiz);
  await fsp.writeFile(path.join(mediaDir(a, 'Мой квиз'), 'йод.png'), 'PNG');
  const zipPath = path.join(await tmp(), 'Мой квиз.quiz.zip');
  await pipeline(exportQuiz(a, 'Мой квиз'), fs.createWriteStream(zipPath));
  const r1 = await importQuiz(b, zipPath, 'Мой квиз');
  assert.equal(r1.name, 'Мой квиз');
  assert.deepEqual(await loadQuiz(b, 'Мой квиз'), quiz);
  assert.equal(await fsp.readFile(path.join(mediaDir(b, 'Мой квиз'), 'йод.png'), 'utf8'), 'PNG');
  const r2 = await importQuiz(b, zipPath, 'Мой квиз');
  assert.equal(r2.name, 'Мой квиз (2)');
});

test('import accepts a hand-made zip with a top folder and mac junk', async () => {
  const dir = await tmp();
  const zipPath = path.join(await tmp(), 'x.zip');
  await makeZip(zipPath, [
    ['Квиз/quiz.json', JSON.stringify(quiz)],
    ['Квиз/media/йод.png'.normalize('NFD'), 'PNG'],
    ['__MACOSX/Квиз/._quiz.json', 'junk'],
    ['Квиз/.DS_Store', 'junk'],
  ]);
  const r = await importQuiz(dir, zipPath, 'Квиз');
  assert.equal(await fsp.readFile(path.join(mediaDir(dir, r.name), 'йод.png'), 'utf8'), 'PNG');
});

test('import rejects path traversal and non-quiz archives', async () => {
  const dir = await tmp();
  const evil = path.join(await tmp(), 'evil.zip');
  await makeZip(evil, [['quiz.json', JSON.stringify(quiz)], ['media/aaaaaaaaaaaaaa', 'x']]);
  // yazl не даёт создать опасное имя — подменяем байты на «media/../../evil.txt» той же длины
  const raw = await fsp.readFile(evil);
  await fsp.writeFile(evil, Buffer.from(raw.toString('latin1').split('media/aaaaaaaaaaaaaa').join('media/../../evil.txt'), 'latin1'));
  await assert.rejects(importQuiz(dir, evil, 'evil'), /BadArchive/);
  const noQuiz = path.join(await tmp(), 'no.zip');
  await makeZip(noQuiz, [['readme.txt', 'x']]);
  await assert.rejects(importQuiz(dir, noQuiz, 'no'), /BadArchive/);
  const badJson = path.join(await tmp(), 'bad.zip');
  await makeZip(badJson, [['quiz.json', '{oops']]);
  await assert.rejects(importQuiz(dir, badJson, 'bad'), /BadArchive/);
  assert.deepEqual(await listQuizzes(dir), []);
});

test('nameFromArchive', () => {
  assert.equal(nameFromArchive('Мой квиз.quiz.zip'), 'Мой квиз');
  assert.equal(nameFromArchive('a/b.zip'), 'b');
  assert.equal(nameFromArchive('...zip'), 'Квиз');
});

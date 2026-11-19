import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSafeName, listQuizzes, loadQuiz, saveQuiz, duplicateQuiz, deleteQuiz, mediaDir } from '../src/quizStore.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'quiz-'));
const quiz = { title: 'Тест', slides: [{ id: 's1', type: 'info', text: 'Привет', media: null }] };

test('rejects unsafe quiz names', async () => {
  for (const n of ['..', '.', 'a/b', 'a\\b', 'a\\..\\..', 'Тур 1\\2', 'CON', 'nul', 'name.', 'name ', '', '.hidden', 'a:b', 'x'.repeat(81)]) assert.equal(isSafeName(n), false, n);
  assert.equal(isSafeName('Новогодний квиз 2026'), true);
  const dir = await tmp();
  await assert.rejects(loadQuiz(dir, '../x'), /BadName/);
  await assert.rejects(saveQuiz(dir, 'a/b', quiz), /BadName/);
});

test('save/load roundtrip and list', async () => {
  const dir = await tmp();
  await saveQuiz(dir, 'Мой квиз', quiz);
  assert.deepEqual(await loadQuiz(dir, 'Мой квиз'), quiz);
  assert.deepEqual(await listQuizzes(dir), [{ name: 'Мой квиз', title: 'Тест', slideCount: 1 }]);
  await assert.rejects(loadQuiz(dir, 'Нет такого'), /NotFound/);
});

test('duplicate copies media, delete removes', async () => {
  const dir = await tmp();
  await saveQuiz(dir, 'A', quiz);
  await fs.writeFile(path.join(mediaDir(dir, 'A'), 'pic.png'), 'x');
  await duplicateQuiz(dir, 'A', 'B');
  assert.equal(await fs.readFile(path.join(mediaDir(dir, 'B'), 'pic.png'), 'utf8'), 'x');
  await deleteQuiz(dir, 'A');
  assert.deepEqual((await listQuizzes(dir)).map((q) => q.name), ['B']);
});

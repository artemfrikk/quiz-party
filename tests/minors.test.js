import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isTextCorrect } from '../src/answers.js';
import { Game } from '../src/game.js';
import { saveQuiz, renameQuiz, listQuizzes, loadQuiz } from '../src/quizStore.js';
import { validateQuiz } from '../public/shared/validate.js';

const t = (accepted, numeric = false) => ({ accepted, numeric });

test('numbers with thousand separators and decimals', () => {
  assert.equal(isTextCorrect('1 000', t(['тысяча'], true)), true);
  assert.equal(isTextCorrect('1 000 000', t(['1000000'], true)), true);
  assert.equal(isTextCorrect('1,5', t(['1.5'], true)), true);
  assert.equal(isTextCorrect('1,5', t(['1'], true)), false);
  assert.equal(isTextCorrect('1 000', t(['1000'])), true);
  assert.equal(isTextCorrect('украли.', t(['украли'])), true);
});

const quiz = {
  title: 'M',
  slides: [{ id: 'c', type: 'question', text: 'Q', media: null, answerType: 'choice', options: ['a', 'b'], correctIndex: 0, accepted: [], numeric: false, points: 100, timeLimit: 10 }],
};

test('showScores during an open question closes answers', () => {
  const g = new Game(quiz, 'M');
  const p = g.join({ name: 'A' }).playerId;
  g.goTo(0); g.startQuestion(0);
  g.showScores();
  assert.equal(g.deadline, null);
  assert.equal(g.submitAnswer(p, 0, 1).accepted, false);
  g.prev(); g.goTo(0);
  assert.equal(g.phase, 'closed');
});

test('csv neutralizes formulas but keeps negative numbers', () => {
  const g = new Game(quiz, 'M');
  const p = g.join({ name: '=SUM(1)' }).playerId;
  g.adjustPoints({ target: 'player', id: p, delta: -5, note: '+cmd' });
  const csv = g.exportCsv();
  assert.match(csv, /'=SUM\(1\)/);
  assert.match(csv, /'\+cmd;;-5/);
  assert.doesNotMatch(csv, /;=SUM/);
});

test('renameQuiz moves the folder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-'));
  await saveQuiz(dir, 'A', quiz);
  await renameQuiz(dir, 'A', 'Б');
  assert.deepEqual((await listQuizzes(dir)).map((q) => q.name), ['Б']);
  assert.equal((await loadQuiz(dir, 'Б')).title, 'M');
  await saveQuiz(dir, 'C', quiz);
  await assert.rejects(renameQuiz(dir, 'Б', 'C'), /Exists/);
});

test('validateQuiz lists problems per slide', () => {
  const bad = {
    slides: [
      { id: '1', type: 'info', text: '', media: null },
      { id: '2', type: 'question', text: 'q', answerType: 'choice', options: ['a', ''], correctIndex: 1 },
      { id: '3', type: 'question', text: 'q', answerType: 'text', accepted: [' '] },
      { id: '4', type: 'question', text: 'q', answerType: 'choice', options: ['a', 'b'], correctIndex: 0, media: { kind: 'video', source: 'file', src: 'x', start: 5, pauseAt: 3, end: null } },
    ],
  };
  const r = validateQuiz(bad);
  assert.deepEqual(r.map((x) => x.index), [0, 1, 2, 3]);
  assert.ok(r[1].errors.length >= 1);
  assert.deepEqual(validateQuiz(quiz), []);
});

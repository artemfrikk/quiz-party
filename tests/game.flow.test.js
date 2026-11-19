import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';

const quiz = {
  title: 'Flow',
  slides: [
    { id: 'i', type: 'info', text: 'Привет', media: null },
    { id: 'c', type: 'question', text: 'Выбор', media: null, answerType: 'choice', options: ['a', 'b', 'c', 'd'], correctIndex: 1, accepted: [], numeric: false, points: 100, timeLimit: 10 },
    { id: 't', type: 'question', text: 'Текст', media: null, answerType: 'text', options: [], correctIndex: null, accepted: ['десять'], numeric: false, points: 100, timeLimit: null },
  ],
};

function setup(n = 2) {
  const g = new Game(quiz, 'Flow');
  const ids = Array.from({ length: n }, (_, i) => g.join({ name: 'P' + i }).playerId);
  return { g, ids };
}

test('scoring with speed bonus', () => {
  const { g, ids } = setup(3);
  g.goTo(1);
  g.startQuestion(0);
  g.submitAnswer(ids[0], 1, 0);
  g.submitAnswer(ids[1], 1, 5000);
  g.submitAnswer(ids[2], 3, 100);
  assert.equal(g.pointsFor('c', ids[0]), 0);
  g.reveal();
  assert.equal(g.pointsFor('c', ids[0]), 150);
  assert.equal(g.pointsFor('c', ids[1]), 125);
  assert.equal(g.pointsFor('c', ids[2]), 0);
  assert.equal(g.playerScore(ids[0]), 150);
});

test('rejects late and repeated answers', () => {
  const { g, ids } = setup(3);
  g.goTo(0);
  assert.equal(g.submitAnswer(ids[0], 1, 0).accepted, false);
  g.goTo(1);
  g.startQuestion(0);
  assert.equal(g.submitAnswer(ids[0], 1, 100).accepted, true);
  assert.equal(g.submitAnswer(ids[0], 2, 200).accepted, false);
  assert.equal(g.submitAnswer(ids[1], 1, 10001).accepted, false);
  assert.equal(g.submitAnswer(ids[1], 7, 300).accepted, false);
  assert.equal(g.submitAnswer('ghost', 1, 300).accepted, false);
  g.closeAnswers();
  assert.equal(g.submitAnswer(ids[2], 1, 400).accepted, false);
});

test('allAnswered counts only connected players', () => {
  const { g, ids } = setup(3);
  g.setConnected(ids[2], false);
  g.goTo(1);
  g.startQuestion(0);
  assert.equal(g.submitAnswer(ids[0], 0, 10).allAnswered, false);
  assert.equal(g.submitAnswer(ids[1], 0, 10).allAnswered, true);
});

test('screen and player views hide answer until reveal', () => {
  const { g, ids } = setup(2);
  g.goTo(1);
  g.startQuestion(0);
  g.submitAnswer(ids[0], 1, 10);
  for (const v of [g.screenView(0), g.playerView(ids[0], 0)]) {
    const s = JSON.stringify(v);
    assert.equal(s.includes('correctIndex'), false);
    assert.equal(s.includes('accepted'), false);
  }
  assert.equal(g.hostView(0).slide.correctIndex, 1);
  g.reveal();
  const sv = g.screenView(0);
  assert.equal(sv.slide.correctIndex, 1);
  assert.deepEqual(sv.distribution, [0, 1, 0, 0]);
  assert.equal(g.playerView(ids[0], 0).result.correct, true);
});

test('override text answer', () => {
  const { g, ids } = setup(1);
  g.goTo(2);
  g.startQuestion(0);
  g.submitAnswer(ids[0], 'не знаю', 10);
  assert.equal(g.isCorrect('t', ids[0]), false);
  g.reveal();
  g.overrideAnswer('t', ids[0], true);
  assert.equal(g.pointsFor('t', ids[0]), 100);
  assert.equal(g.playerScore(ids[0]), 100);
  g.overrideAnswer('t', ids[0], false);
  assert.equal(g.pointsFor('t', ids[0]), 0);
});

test('text answer with numerals is auto-correct', () => {
  const { g, ids } = setup(1);
  g.goTo(2);
  g.startQuestion(0);
  g.submitAnswer(ids[0], '10', 10);
  assert.equal(g.isCorrect('t', ids[0]), true);
});

test('navigation phases', () => {
  const { g } = setup(1);
  assert.equal(g.phase, 'lobby');
  g.next();
  assert.equal(g.index, 0);
  assert.equal(g.phase, 'slide');
  g.next(); g.startQuestion(0); g.reveal();
  g.next(); g.prev();
  assert.equal(g.phase, 'reveal');
  g.goTo(2); g.next();
  assert.equal(g.phase, 'final');
});

test('snapshot roundtrip', () => {
  const { g, ids } = setup(2);
  const t = g.createTeam('X');
  g.assignPlayer(ids[0], t);
  g.goTo(1); g.startQuestion(0);
  g.submitAnswer(ids[0], 1, 0); g.submitAnswer(ids[1], 0, 0);
  g.reveal();
  g.adjustPoints({ target: 'team', id: t, delta: 7 });
  const g2 = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.deepEqual(g2.scoreboard(), g.scoreboard());
  assert.equal(g2.players.get(ids[0]).connected, false);
});

test('csv export', () => {
  const { g, ids } = setup(1);
  g.goTo(1); g.startQuestion(0); g.submitAnswer(ids[0], 1, 0); g.reveal();
  g.adjustPoints({ target: 'player', id: ids[0], delta: -5, note: 'шум' });
  const csv = g.exportCsv();
  assert.equal(csv.startsWith('\uFEFF'), true);
  assert.match(csv, /P0/);
  assert.match(csv, /Правка;P0;;шум;;-5/);
});

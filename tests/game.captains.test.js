import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';

const quiz = {
  title: 'T',
  slides: [
    { id: 'q1', type: 'question', text: '?', answerType: 'choice', options: ['a', 'b', 'c', 'd'], correctIndex: 1, points: 100, timeLimit: null },
    { id: 'q2', type: 'question', text: '?', answerType: 'text', accepted: ['десять'], numeric: true, points: 100, timeLimit: null },
  ],
};

function setup() {
  const g = new Game(quiz, 'T');
  g.setMode('teams');
  g.setCaptainMode(true);
  const t1 = g.createTeam('Красные');
  const t2 = g.createTeam('Синие');
  const a = g.join({ name: 'A' }).playerId;
  const b = g.join({ name: 'B' }).playerId;
  const c = g.join({ name: 'C' }).playerId;
  const d = g.join({ name: 'D' }).playerId;
  g.assignPlayer(a, t1); g.assignPlayer(b, t1); g.assignPlayer(c, t1);
  g.assignPlayer(d, t2);
  return { g, t1, t2, a, b, c, d };
}

test('first member becomes captain, captain follows membership', () => {
  const { g, t1, a, b, c } = setup();
  assert.equal(g.teams.get(t1).captainId, a);
  g.setCaptain(t1, c);
  assert.equal(g.teams.get(t1).captainId, c);
  g.assignPlayer(c, null);
  assert.equal(g.teams.get(t1).captainId, a);
  g.removePlayer(a);
  assert.equal(g.teams.get(t1).captainId, b);
  assert.throws(() => g.setCaptain(t1, 'nobody'), /NotFound/);
});

test('setCaptain rejects a player from another team', () => {
  const { g, t1, d } = setup();
  assert.throws(() => g.setCaptain(t1, d), /NotMember/);
});

test('only captain answers; others vote; team gets points', () => {
  const { g, t1, t2, a, b, c, d } = setup();
  g.goTo(0); g.startQuestion(1000);
  const vb = g.submitAnswer(b, 1, 1100);
  assert.deepEqual([vb.accepted, vb.vote], [true, true]);
  g.submitAnswer(c, 2, 1100);
  g.submitAnswer(c, 1, 1200); // голос можно поменять
  const pv = g.playerView(a);
  assert.equal(pv.me.isCaptain, true);
  assert.deepEqual(pv.votes, [0, 2, 0, 0]);
  assert.equal(g.playerView(b).votes, undefined);
  assert.equal(g.playerView(b).myVote, 1);
  const ra = g.submitAnswer(a, 1, 1300);
  assert.equal(ra.accepted, true);
  assert.equal(ra.allAnswered, false); // команда Синие ещё не ответила
  assert.equal(g.submitAnswer(a, 2, 1400).accepted, false);
  assert.equal(g.submitAnswer(b, 2, 1400).accepted, false); // после ответа капитана голосовать поздно
  const rd = g.submitAnswer(d, 0, 1500);
  assert.equal(rd.allAnswered, true);
  assert.equal(g.common(0).answeredCount, 2);
  assert.equal(g.common(0).totalCount, 2);
  g.reveal();
  assert.equal(g.teamScore(t1), 100);
  assert.equal(g.teamScore(t2), 0);
  assert.equal(g.playerScore(a), 0);
  assert.equal(g.playerView(b).myAnswer, 1);
  assert.equal(g.playerView(b).result.correct, true);
  assert.equal(g.playerView(b).result.points, 100);
  const sb = g.scoreboard();
  assert.equal(sb.teams.find((t) => t.id === t1).delta, 100);
  const hv = g.hostView();
  assert.equal(hv.teams.find((t) => t.id === t1).answered, true);
  assert.equal(hv.captainMode, true);
});

test('captain change keeps the team answer with the team', () => {
  const { g, t1, a, b } = setup();
  g.goTo(0); g.startQuestion(0);
  g.submitAnswer(a, 1, 10);
  g.setCaptain(t1, b);
  assert.equal(g.submitAnswer(b, 2, 20).accepted, false);
  g.reveal();
  assert.equal(g.teamScore(t1), 100);
});

test('text votes are grouped for the captain', () => {
  const { g, a, b, c } = setup();
  g.goTo(1); g.startQuestion(0);
  g.submitAnswer(b, 'Десять', 10);
  g.submitAnswer(c, ' десять ', 10);
  const v = g.playerView(a).votes;
  assert.deepEqual(v, [{ text: 'Десять', count: 2 }]);
  g.submitAnswer(a, '10', 20);
  g.reveal();
  assert.equal(g.playerView(c).result.correct, true);
});

test('captain mode off: members answer individually as before', () => {
  const { g, t1, a, b } = setup();
  g.setCaptainMode(false);
  g.goTo(0); g.startQuestion(0);
  assert.equal(g.submitAnswer(b, 1, 10).vote, undefined);
  g.submitAnswer(a, 1, 10);
  g.reveal();
  assert.equal(g.teamScore(t1), 200);
});

test('captain state survives save/restore and override works on team answer', () => {
  const { g, t1, a, b } = setup();
  g.goTo(1); g.startQuestion(0);
  g.submitAnswer(b, 'девять', 5);
  g.submitAnswer(a, 'девять', 10);
  g.closeAnswers();
  g.overrideAnswer('q2', a, true);
  g.reveal();
  const r = Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.equal(r.captainMode, true);
  assert.equal(r.teams.get(t1).captainId, a);
  assert.equal(r.teamScore(t1), 100);
  assert.match(r.exportCsv(), /Красные/);
});

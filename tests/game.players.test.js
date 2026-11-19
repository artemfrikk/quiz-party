import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';

const quiz = { title: 'T', slides: [{ id: 'i', type: 'info', text: 'x', media: null }] };

test('rejoin keeps score', () => {
  const g = new Game(quiz, 'T');
  const { playerId } = g.join({ name: 'Аня' });
  g.adjustPoints({ target: 'player', id: playerId, delta: 50 });
  g.setConnected(playerId, false);
  const again = g.join({ playerId, name: 'Другое' });
  assert.equal(again.playerId, playerId);
  assert.equal(g.players.size, 1);
  assert.equal(g.playerScore(playerId), 50);
  assert.equal(g.players.get(playerId).name, 'Аня');
  assert.equal(g.players.get(playerId).connected, true);
});

test('duplicate and empty names', () => {
  const g = new Game(quiz, 'T');
  const a = g.join({ name: 'Аня' }).playerId;
  const b = g.join({ name: ' аня ' }).playerId;
  assert.equal(g.players.get(a).name, 'Аня');
  assert.equal(g.players.get(b).name, 'аня (2)');
  assert.throws(() => g.join({ name: '   ' }), /EmptyName/);
  assert.throws(() => g.join({ playerId: 'unknown-id', name: '' }), /EmptyName/);
});

test('team score includes members and manual', () => {
  const g = new Game(quiz, 'T');
  g.setMode('teams');
  const t1 = g.createTeam('Красные');
  const t2 = g.createTeam('Синие');
  const p1 = g.join({ name: 'A' }).playerId;
  const p2 = g.join({ name: 'B' }).playerId;
  g.assignPlayer(p1, t1); g.assignPlayer(p2, t1);
  g.adjustPoints({ target: 'player', id: p1, delta: 10 });
  g.adjustPoints({ target: 'player', id: p2, delta: 20 });
  g.adjustPoints({ target: 'team', id: t1, delta: 5 });
  assert.equal(g.teamScore(t1), 35);
  g.assignPlayer(p2, t2);
  assert.equal(g.teamScore(t1), 15);
  assert.equal(g.teamScore(t2), 20);
});

test('negative adjustments and unknown targets', () => {
  const g = new Game(quiz, 'T');
  const t = g.createTeam('X');
  g.adjustPoints({ target: 'team', id: t, delta: -30, note: 'штраф' });
  assert.equal(g.teamScore(t), -30);
  assert.throws(() => g.adjustPoints({ target: 'player', id: 'nope', delta: 5 }), /NotFound/);
});

test('deleteTeam unassigns players', () => {
  const g = new Game(quiz, 'T');
  const t = g.createTeam('X');
  const p = g.join({ name: 'A' }).playerId;
  g.assignPlayer(p, t);
  g.adjustPoints({ target: 'player', id: p, delta: 10 });
  g.adjustPoints({ target: 'team', id: t, delta: 100 });
  g.deleteTeam(t);
  assert.equal(g.players.get(p).teamId, null);
  assert.equal(g.playerScore(p), 10);
  assert.equal(g.adjustments.some((a) => a.target === 'team' && a.id === t), false);
  assert.equal(g.scoreboard().teams.length, 0);
});

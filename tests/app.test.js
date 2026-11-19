import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { createServer } from '../src/app.js';
import { saveQuiz } from '../src/quizStore.js';

const quiz = {
  title: 'Сервер',
  slides: [
    { id: 'c', type: 'question', text: 'Выбор', media: null, answerType: 'choice', options: ['a', 'b'], correctIndex: 1, accepted: [], numeric: false, points: 100, timeLimit: 30 },
  ],
};

const clients = [];
function connect(url) {
  const s = io(url, { transports: ['websocket'], forceNew: true });
  s.states = [];
  s.on('state', (st) => s.states.push(st));
  clients.push(s);
  return s;
}
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
async function waitFor(s, pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = [...s.states].reverse().find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for state');
}
async function setup(dataDir) {
  const quizzesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qz-'));
  await saveQuiz(quizzesDir, 'Сервер', quiz);
  dataDir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'qd-'));
  const srv = await createServer({ quizzesDir, dataDir, port: 0 });
  return { srv, quizzesDir, dataDir };
}
const servers = [];
after(async () => { clients.forEach((c) => c.close()); for (const s of servers) await s.close(); });

test('full round, screen never sees answer before reveal, adjust', async () => {
  const { srv } = await setup();
  servers.push(srv);
  const host = connect(srv.url);
  const screen = connect(srv.url);
  await emit(host, 'host:hello');
  await emit(screen, 'screen:hello');
  assert.equal((await emit(host, 'host:cmd', { type: 'loadQuiz', name: 'Сервер' })).ok, true);
  const p1 = connect(srv.url);
  const p2 = connect(srv.url);
  const j1 = await emit(p1, 'player:join', { name: 'Аня' });
  const j2 = await emit(p2, 'player:join', { name: 'Боря' });
  assert.equal(j1.ok, true);
  await emit(host, 'host:cmd', { type: 'goTo', index: 0 });
  await emit(host, 'host:cmd', { type: 'startQuestion' });
  assert.equal((await emit(p1, 'player:answer', { value: 1 })).accepted, true);
  assert.equal((await emit(p2, 'player:answer', { value: 0 })).accepted, true);
  await waitFor(host, (s) => s.phase === 'closed');
  const beforeReveal = screen.states.map((s) => JSON.stringify(s));
  assert.equal(beforeReveal.some((s) => s.includes('correctIndex')), false);
  await emit(host, 'host:cmd', { type: 'reveal' });
  const ps = await waitFor(p1, (s) => s.phase === 'reveal');
  assert.equal(ps.result.correct, true);
  assert.equal((await emit(host, 'host:cmd', { type: 'adjust', target: 'player', id: j2.playerId, delta: -7 })).ok, true);
  const hs = await waitFor(host, (s) => s.adjustments?.length === 1);
  assert.equal(hs.scoreboard.players.find((p) => p.id === j2.playerId).score, -7);
  assert.equal((await emit(host, 'host:cmd', { type: 'bogus' })).error, 'UnknownCommand');
});

test('http endpoints', async () => {
  const { srv } = await setup();
  servers.push(srv);
  const list = await (await fetch(srv.url + '/api/quizzes')).json();
  assert.deepEqual(list.map((q) => q.name), ['Сервер']);
  assert.equal((await fetch(srv.url + '/api/quizzes/..%2Fx')).status, 400);
  const qr = await fetch(srv.url + '/api/qr?text=' + encodeURIComponent('http://x'));
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  const root = await fetch(srv.url + '/', { redirect: 'manual' });
  assert.equal(root.status, 302);
  const quizJson = await fetch(srv.url + '/quizzes/' + encodeURIComponent('Сервер') + '/quiz.json');
  assert.equal(quizJson.status, 404);
});

test('resume after restart', async () => {
  const first = await setup();
  const host = connect(first.srv.url);
  await emit(host, 'host:hello');
  await emit(host, 'host:cmd', { type: 'loadQuiz', name: 'Сервер' });
  const p = connect(first.srv.url);
  const { playerId } = await emit(p, 'player:join', { name: 'Аня' });
  await emit(host, 'host:cmd', { type: 'adjust', target: 'player', id: playerId, delta: 42 });
  p.close(); host.close();
  await first.srv.close();
  const second = await createServer({ quizzesDir: first.quizzesDir, dataDir: first.dataDir, port: 0 });
  servers.push(second);
  const host2 = connect(second.url);
  await emit(host2, 'host:hello');
  const st = await waitFor(host2, (s) => s.hasSavedGame === true);
  assert.equal(st.hasSavedGame, true);
  assert.equal((await emit(host2, 'host:cmd', { type: 'resume' })).ok, true);
  const st2 = await waitFor(host2, (s) => s.scoreboard?.players?.length === 1);
  assert.equal(st2.scoreboard.players[0].score, 42);
});

test('media upload keeps cyrillic file names', async () => {
  const { srv } = await setup();
  servers.push(srv);
  const fd = new FormData();
  fd.append('file', new Blob(['x'], { type: 'image/png' }), 'картинка тест.png');
  const r = await fetch(srv.url + '/api/quizzes/' + encodeURIComponent('Сервер') + '/media', { method: 'POST', body: fd });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { src: 'media/картинка_тест.png' });
  const again = await fetch(srv.url + '/api/quizzes/' + encodeURIComponent('Сервер') + '/media', { method: 'POST', body: fd });
  assert.deepEqual(await again.json(), { src: 'media/картинка_тест-2.png' });
  const get = await fetch(srv.url + '/quizzes/' + encodeURIComponent('Сервер') + '/media/' + encodeURIComponent('картинка_тест.png'));
  assert.equal(await get.text(), 'x');
});

test('stale navigation commands are ignored', async () => {
  const { srv } = await setup();
  servers.push(srv);
  const host = connect(srv.url);
  await emit(host, 'host:hello');
  await emit(host, 'host:cmd', { type: 'loadQuiz', name: 'Сервер' });
  const at = { index: -1, phase: 'lobby' };
  assert.equal((await emit(host, 'host:cmd', { type: 'next', at })).ok, true);
  const second = await emit(host, 'host:cmd', { type: 'next', at });
  assert.equal(second.error, 'Stale');
  const st = await waitFor(host, (s) => s.phase === 'slide');
  assert.equal(st.index, 0);
});

test('loading a quiz over a saved game keeps a backup', async () => {
  const first = await setup();
  const host = connect(first.srv.url);
  await emit(host, 'host:hello');
  await emit(host, 'host:cmd', { type: 'loadQuiz', name: 'Сервер' });
  const p = connect(first.srv.url);
  const { playerId } = await emit(p, 'player:join', { name: 'Аня' });
  await emit(host, 'host:cmd', { type: 'adjust', target: 'player', id: playerId, delta: 42 });
  p.close(); host.close();
  await first.srv.close();
  const second = await createServer({ quizzesDir: first.quizzesDir, dataDir: first.dataDir, port: 0 });
  servers.push(second);
  const host2 = connect(second.url);
  await emit(host2, 'host:hello');
  await emit(host2, 'host:cmd', { type: 'loadQuiz', name: 'Сервер' });
  const backup = JSON.parse(await fs.readFile(path.join(first.dataDir, 'game-state.prev.json'), 'utf8'));
  assert.equal(backup.adjustments[0].delta, 42);
});

test('loaded quiz: rename follows, delete refused, warnings shown', async () => {
  const { srv, quizzesDir } = await setup();
  servers.push(srv);
  await saveQuiz(quizzesDir, 'Плохой', { title: 'x', slides: [{ id: 'z', type: 'question', text: 'q', answerType: 'choice', options: ['a', ''], correctIndex: 1 }] });
  const host = connect(srv.url);
  await emit(host, 'host:hello');
  await emit(host, 'host:cmd', { type: 'loadQuiz', name: 'Сервер' });
  const del = await fetch(srv.url + '/api/quizzes/' + encodeURIComponent('Сервер'), { method: 'DELETE' });
  assert.equal(del.status, 409);
  const ren = await fetch(srv.url + '/api/quizzes/' + encodeURIComponent('Сервер') + '/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newName: 'Новое' }),
  });
  assert.equal(ren.status, 200);
  await waitFor(host, (s) => s.quizName === 'Новое');
  await emit(host, 'host:cmd', { type: 'loadQuiz', name: 'Плохой' });
  const st = await waitFor(host, (s) => s.quizName === 'Плохой');
  assert.equal(st.quizWarnings.length, 1);
});

test('mac-style decomposed (NFD) file names are kept readable', async () => {
  const { srv } = await setup();
  servers.push(srv);
  const fd = new FormData();
  fd.append('file', new Blob(['x'], { type: 'image/png' }), 'йога ёлка.png'.normalize('NFD'));
  const r = await fetch(srv.url + '/api/quizzes/' + encodeURIComponent('Сервер') + '/media', { method: 'POST', body: fd });
  assert.deepEqual(await r.json(), { src: 'media/йога_ёлка.png' });
});

test('quiz file export/import over http', async () => {
  const { srv } = await setup();
  servers.push(srv);
  const exp = await fetch(srv.url + '/api/quizzes/' + encodeURIComponent('Сервер') + '/export');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition'), /filename\*=UTF-8''%D0%A1%D0%B5%D1%80%D0%B2%D0%B5%D1%80\.quiz\.zip/);
  const blob = await exp.blob();
  const fd = new FormData();
  fd.append('file', blob, 'Сервер.quiz.zip');
  const imp = await fetch(srv.url + '/api/import', { method: 'POST', body: fd });
  assert.deepEqual(await imp.json(), { name: 'Сервер (2)' });
  const bad = new FormData();
  bad.append('file', new Blob(['not a zip']), 'x.zip');
  const r = await fetch(srv.url + '/api/import', { method: 'POST', body: bad });
  assert.equal(r.status, 400);
});

test('quizzes folder can be moved to a cloud folder', async () => {
  const first = await setup();
  servers.push(first.srv);
  const cloud = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-'));
  const put = (body) => fetch(first.srv.url + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put({ quizzesDir: path.join(cloud, 'nope') })).status, 400);
  assert.equal((await put({ quizzesDir: 'relative/path' })).status, 400);
  assert.equal((await put({ quizzesDir: `"${cloud}"`, copyExisting: true })).status, 200);
  const list = await (await fetch(first.srv.url + '/api/quizzes')).json();
  assert.deepEqual(list.map((q) => q.name), ['Сервер']);
  assert.ok(await fs.stat(path.join(cloud, 'Сервер', 'quiz.json')));
  await first.srv.close();
  const again = await createServer({ quizzesDir: first.quizzesDir, dataDir: first.dataDir, port: 0 });
  servers.push(again);
  const st = await (await fetch(again.url + '/api/settings')).json();
  assert.equal(st.quizzesDir, cloud);
  assert.equal(st.isDefault, false);
  assert.equal((await fetch(again.url + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quizzesDir: null }) })).status, 200);
  assert.equal((await (await fetch(again.url + '/api/settings')).json()).isDefault, true);
});

test('update endpoints: check, refuse during a game, apply then restart', async () => {
  const quizzesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qz-'));
  await saveQuiz(quizzesDir, 'Сервер', quiz);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qd-'));
  const calls = { applied: null, restarted: false };
  const info = { version: '9.0.0', notes: 'новое', zipUrl: 'z', shaUrl: 's' };
  const srv = await createServer({
    quizzesDir, dataDir, port: 0,
    update: {
      current: '1.0.0',
      check: async () => info,
      download: async (i, dir) => path.join(dir, 'u.zip'),
      apply: async (zip) => { calls.applied = zip; },
      restart: () => { calls.restarted = true; },
    },
  });
  servers.push(srv);
  const st = await (await fetch(`${srv.url}/api/update`)).json();
  assert.equal(st.current, '1.0.0');
  assert.equal(st.available.version, '9.0.0');
  const host = connect(srv.url);
  await emit(host, 'host:hello');
  await emit(host, 'host:cmd', { type: 'loadQuiz', name: 'Сервер' });
  await emit(host, 'host:cmd', { type: 'next' });
  const busy = await fetch(`${srv.url}/api/update`, { method: 'POST' });
  assert.equal(busy.status, 409);
  await emit(host, 'host:cmd', { type: 'finish' });
  const ok = await fetch(`${srv.url}/api/update`, { method: 'POST' });
  assert.equal(ok.status, 200);
  assert.match(calls.applied, /u\.zip$/);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(calls.restarted, true);
});

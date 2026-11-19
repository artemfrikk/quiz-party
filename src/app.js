// HTTP + Socket.IO. Всё состояние — в Game; здесь только транспорт, таймеры и сохранение.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { Game } from './game.js';
import { getLanAddresses } from './network.js';
import * as store from './quizStore.js';
import { exportQuiz, importQuiz } from './quizArchive.js';
import { validateQuiz } from '../public/shared/validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLocal = (addr) => LOOPBACK.has(addr);

function httpError(res, err) {
  const code = { BadName: 400, NotFound: 404, Exists: 409, InUse: 409, BadQuiz: 400, BadArchive: 400, BadFolder: 400 }[err.message] ?? 500;
  if (code === 500) console.error(err);
  res.status(code).json({ error: err.message });
}

// busboy иногда отдаёт UTF-8 имя, прочитанное как latin1, — перекодируем только тогда.
// macOS присылает «й», «ё» разложенными на букву + знак — приводим к NFC.
function decodeUploadName(name) {
  let s = String(name ?? '');
  if (!/[^\x00-\xff]/.test(s)) {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    if (!fixed.includes('\uFFFD')) s = fixed;
  }
  return s.normalize('NFC');
}

function safeFileName(original) {
  const ext = path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const base = path.basename(original, path.extname(original)).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'file';
  return { base, ext };
}

// Путь, вставленный из «Копировать как путь» (Windows) или Finder: убираем кавычки и пробелы
export function cleanFolderPath(p) {
  return String(p ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
}

// update: {current, check(), download(info, dir), apply(zip), restart()} — без него обновления выключены
export async function createServer({ quizzesDir: defaultQuizzesDir, dataDir, port = 3000, publicDir = path.join(ROOT, 'public'), update = null }) {
  await fsp.mkdir(defaultQuizzesDir, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* настроек ещё нет */ }
  let settingsWarning = null;
  let quizzesDir = defaultQuizzesDir;
  if (settings.quizzesDir) {
    if (fs.existsSync(settings.quizzesDir) && fs.statSync(settings.quizzesDir).isDirectory()) quizzesDir = settings.quizzesDir;
    else settingsWarning = `Папка с квизами не найдена: ${settings.quizzesDir}. Пока используется стандартная.`;
  }
  const savedFile = path.join(dataDir, 'game-state.json');

  let game = null;
  let hasSavedGame = fs.existsSync(savedFile);
  let baseUrl = null;
  let showQr = true; // QR-код для входа в углу экрана
  let videoError = null; // slideId, где не загрузилось видео
  let videoBlocked = null; // slideId, где браузер экрана не дал запустить видео
  let timer = null;

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e6 });

  // ---------- HTTP ----------
  const localOnly = (req, res, next) => (isLocal(req.socket.remoteAddress) ? next() : res.status(403).json({ error: 'LocalOnly' }));

  app.get('/', (req, res) => res.redirect(302, '/host/'));
  app.use(express.static(publicDir));

  app.get('/quizzes/:name/media/:file', (req, res) => {
    if (!store.isSafeName(req.params.name) || !store.isSafeName(req.params.file)) return res.sendStatus(400);
    res.sendFile(req.params.file, { root: store.mediaDir(quizzesDir, req.params.name), dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.sendStatus(404);
    });
  });

  app.get('/api/qr', async (req, res) => {
    const text = String(req.query.text ?? '').slice(0, 500);
    if (!text) return res.sendStatus(400);
    res.type('image/svg+xml').send(await QRCode.toString(text, { type: 'svg', margin: 1 }));
  });
  app.get('/api/addresses', (req, res) => res.json(getLanAddresses()));

  const api = express.Router();
  api.use(localOnly);
  api.use(express.json({ limit: '2mb' }));
  api.get('/quizzes', async (req, res) => {
    try { res.json(await store.listQuizzes(quizzesDir)); } catch (e) { httpError(res, e); }
  });
  api.get('/quizzes/:name', async (req, res) => {
    try { res.json(await store.loadQuiz(quizzesDir, req.params.name)); } catch (e) { httpError(res, e); }
  });
  api.put('/quizzes/:name', async (req, res) => {
    try {
      const q = req.body;
      if (!q || typeof q !== 'object' || !Array.isArray(q.slides)) throw new Error('BadQuiz');
      await store.saveQuiz(quizzesDir, req.params.name, q);
      res.json({ ok: true });
    } catch (e) { httpError(res, e); }
  });
  api.delete('/quizzes/:name', async (req, res) => {
    try {
      if (game?.quizName === req.params.name) throw new Error('InUse');
      await store.deleteQuiz(quizzesDir, req.params.name);
      res.json({ ok: true });
    } catch (e) { httpError(res, e); }
  });
  api.post('/quizzes/:name/duplicate', async (req, res) => {
    try { await store.duplicateQuiz(quizzesDir, req.params.name, req.body?.newName); res.json({ ok: true }); } catch (e) { httpError(res, e); }
  });
  api.post('/quizzes/:name/rename', async (req, res) => {
    try {
      await store.renameQuiz(quizzesDir, req.params.name, req.body?.newName);
      // загруженная игра продолжает видеть свои картинки и видео
      if (game?.quizName === req.params.name) { game.quizName = req.body.newName; changed(); }
      res.json({ ok: true });
    } catch (e) { httpError(res, e); }
  });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        try {
          const dir = store.mediaDir(quizzesDir, req.params.name);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        } catch (e) { cb(e); }
      },
      filename: (req, file, cb) => {
        const original = decodeUploadName(file.originalname);
        const { base, ext } = safeFileName(original);
        const dir = store.mediaDir(quizzesDir, req.params.name);
        let name = base + ext;
        for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}${ext}`;
        cb(null, name);
      },
    }),
    limits: { fileSize: 2 * 1024 ** 3 },
  });
  api.post('/quizzes/:name/media', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) return httpError(res, err);
      if (!req.file) return res.status(400).json({ error: 'NoFile' });
      res.json({ src: 'media/' + req.file.filename });
    });
  });
  api.get('/quizzes/:name/export', (req, res) => {
    let stream;
    try { stream = exportQuiz(quizzesDir, req.params.name); } catch (e) { return httpError(res, e); }
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="quiz.quiz.zip"; filename*=UTF-8''${encodeURIComponent(req.params.name)}.quiz.zip`);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
  const importUpload = multer({ dest: path.join(dataDir, 'tmp'), limits: { fileSize: 2 * 1024 ** 3 } });
  api.post('/import', (req, res) => {
    importUpload.single('file')(req, res, async (err) => {
      if (err) return httpError(res, err);
      if (!req.file) return res.status(400).json({ error: 'NoFile' });
      try {
        res.json(await importQuiz(quizzesDir, req.file.path, decodeUploadName(req.file.originalname)));
      } catch (e) {
        httpError(res, e);
      } finally {
        fsp.rm(req.file.path, { force: true }).catch(() => {});
      }
    });
  });
  api.get('/settings', (req, res) => res.json({ quizzesDir, defaultDir: defaultQuizzesDir, isDefault: quizzesDir === defaultQuizzesDir, warning: settingsWarning }));
  api.put('/settings', async (req, res) => {
    try {
      const raw = req.body?.quizzesDir;
      let next = defaultQuizzesDir;
      if (raw) {
        next = path.resolve(cleanFolderPath(raw));
        if (!path.isAbsolute(cleanFolderPath(raw)) || !fs.existsSync(next) || !fs.statSync(next).isDirectory()) throw new Error('BadFolder');
        if (path.resolve(next).startsWith(path.resolve(dataDir))) throw new Error('BadFolder');
      }
      if (req.body?.copyExisting && next !== quizzesDir) {
        for (const q of await store.listQuizzes(quizzesDir)) {
          if (!fs.existsSync(path.join(next, q.name))) await fsp.cp(path.join(quizzesDir, q.name), path.join(next, q.name), { recursive: true });
        }
      }
      quizzesDir = next;
      settingsWarning = null;
      settings = next === defaultQuizzesDir ? {} : { quizzesDir: next };
      await fsp.writeFile(settingsFile, JSON.stringify(settings, null, 2));
      res.json({ ok: true, quizzesDir });
    } catch (e) { httpError(res, e); }
  });
  api.get('/export.csv', (req, res) => {
    if (!game) return res.sendStatus(404);
    res.type('text/csv; charset=utf-8').attachment('results.csv').send(game.exportCsv());
  });
  // ---------- обновления ----------
  let updateState = { checkedAt: 0, available: null, error: null, busy: false };
  async function checkUpdate(force) {
    if (!update) return;
    if (!force && Date.now() - updateState.checkedAt < 10 * 60 * 1000) return;
    try {
      updateState.available = await update.check();
      updateState.error = null;
    } catch (e) {
      updateState.error = 'Не удалось проверить обновления (нет интернета?)';
    }
    updateState.checkedAt = Date.now();
  }
  checkUpdate(true).then(() => broadcast(), () => {});
  api.get('/update', async (req, res) => {
    if (!update) return res.json({ enabled: false });
    await checkUpdate(req.query.refresh === '1');
    res.json({ enabled: true, current: update.current, available: updateState.available, error: updateState.error, busy: updateState.busy });
  });
  api.post('/update', async (req, res) => {
    if (!update) return res.status(404).json({ error: 'NoUpdater' });
    if (game && !['lobby', 'final'].includes(game.phase)) return res.status(409).json({ error: 'GameRunning' });
    if (updateState.busy) return res.status(409).json({ error: 'Busy' });
    updateState.busy = true;
    try {
      if (!updateState.available) await checkUpdate(true);
      const info = updateState.available;
      if (!info) { updateState.busy = false; return res.status(404).json({ error: 'NoUpdate' }); }
      const zip = await update.download(info, path.join(dataDir, 'tmp'));
      await update.apply(zip);
      await fsp.rm(zip, { force: true }).catch(() => {});
      save();
      res.json({ ok: true, version: info.version });
      setTimeout(() => update.restart(), 500);
    } catch (e) {
      updateState.busy = false;
      console.error('Обновление не удалось:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
  app.use('/api', api);

  // ---------- состояние ----------
  function defaultBaseUrl() {
    const a = getLanAddresses()[0]?.address ?? 'localhost';
    return `http://${a}:${server.address().port}`;
  }

  function save() {
    if (!game) return;
    try {
      fs.writeFileSync(savedFile + '.tmp', JSON.stringify(game.toJSON()));
      fs.renameSync(savedFile + '.tmp', savedFile);
    } catch (e) { console.error('Не удалось сохранить игру:', e.message); }
  }

  function viewFor(socket) {
    const now = Date.now();
    const role = socket.data.role;
    if (role === 'host') {
      const extra = { showQr, appVersion: update?.current ?? null, updateAvailable: updateState.available?.version ?? null, baseUrl, addresses: getLanAddresses(), hasSavedGame, videoError: Boolean(game && videoError === game.slide?.id), videoBlocked: Boolean(game && videoBlocked === game.slide?.id), quizWarnings: game ? validateQuiz(game.quiz) : [] };
      return game ? { ...game.hostView(now), ...extra } : { noGame: true, ...extra };
    }
    if (role === 'screen') return game ? { ...game.screenView(now), baseUrl, showQr } : { noGame: true, baseUrl, showQr };
    if (role === 'player') {
      const v = game && socket.data.playerId ? game.playerView(socket.data.playerId, now) : null;
      return v ?? { noGame: !game, needJoin: true };
    }
    return null;
  }

  function broadcast() {
    for (const s of io.sockets.sockets.values()) {
      const v = viewFor(s);
      if (v) s.emit('state', v);
    }
  }

  function changed() {
    save();
    broadcast();
  }

  function scheduleTimer() {
    clearTimeout(timer);
    if (!game?.deadline) return;
    const slideId = game.slide.id;
    timer = setTimeout(() => {
      if (game?.phase === 'question' && game.slide?.id === slideId) {
        game.closeAnswers();
        changed();
      }
    }, Math.max(0, game.deadline - Date.now()) + 100);
  }

  function startQuestion() {
    if (game.startQuestion(Date.now())) scheduleTimer();
  }

  function newGame(quiz, name) {
    const old = game;
    game = new Game(quiz, name);
    if (old) {
      // переносим игроков и команды в новый квиз
      game.mode = old.mode;
      game.captainMode = old.captainMode;
      for (const [id, t] of old.teams) game.teams.set(id, { ...t });
      for (const [id, p] of old.players) game.players.set(id, { ...p });
    }
    videoError = null;
    videoBlocked = null;
    clearTimeout(timer);
  }

  const commands = {
    async loadQuiz({ name }) {
      const quiz = await store.loadQuiz(quizzesDir, name);
      // не теряем прошлую игру молча: оставляем копию
      if (!game && fs.existsSync(savedFile)) await fsp.copyFile(savedFile, path.join(dataDir, 'game-state.prev.json'));
      newGame(quiz, name);
      hasSavedGame = false;
    },
    async resume() {
      const data = JSON.parse(await fsp.readFile(savedFile, 'utf8'));
      game = Game.fromJSON(data);
      hasSavedGame = false;
      for (const s of io.sockets.sockets.values()) {
        if (s.data.role === 'player' && game.players.has(s.data.playerId)) game.setConnected(s.data.playerId, true);
      }
    },
    setBaseUrl({ url }) { baseUrl = String(url).slice(0, 200); },
    setShowQr({ on }) { showQr = Boolean(on); },
    setMode({ mode }) { game.setMode(mode); },
    setCaptainMode({ on }) { game.setCaptainMode(on); },
    setCaptain({ teamId, playerId }) { game.setCaptain(teamId, playerId); },
    createTeam({ name }) { game.createTeam(name); },
    renameTeam({ id, name }) { game.renameTeam(id, name); },
    deleteTeam({ id }) { game.deleteTeam(id); },
    assignPlayer({ playerId, teamId }) { game.assignPlayer(playerId, teamId ?? null); },
    renamePlayer({ id, name }) { game.renamePlayer(id, name); },
    removePlayer({ id }) {
      game.removePlayer(id);
      for (const s of io.sockets.sockets.values()) {
        if (s.data.playerId === id) { s.data.playerId = null; s.emit('removed'); }
      }
    },
    goTo({ index }) { game.goTo(index); clearTimeout(timer); },
    next() { game.next(); clearTimeout(timer); },
    prev() { game.prev(); clearTimeout(timer); },
    startQuestion() { startQuestion(); },
    closeAnswers() { game.closeAnswers(); clearTimeout(timer); },
    reveal() { game.reveal(); clearTimeout(timer); },
    showScores() { game.showScores(); },
    finish() { game.finish(); clearTimeout(timer); },
    override({ slideId, playerId, correct }) { game.overrideAnswer(slideId, playerId, correct); },
    adjust({ target, id, delta, note }) { game.adjustPoints({ target, id, delta, note }); },
    video({ action, t }) {
      if (!['play', 'pause', 'seek', 'restart'].includes(action)) throw new Error('BadAction');
      io.to('screen').emit('video', { action, t: Number(t) || 0 });
      return { noChange: true };
    },
  };
  const NEEDS_GAME = new Set(Object.keys(commands).filter((k) => !['loadQuiz', 'resume', 'setBaseUrl', 'setShowQr', 'video'].includes(k)));

  // ---------- сокеты ----------
  io.on('connection', (socket) => {
    const ack = (cb, v) => typeof cb === 'function' && cb(v);

    socket.on('host:hello', (_, cb) => {
      if (typeof _ === 'function') cb = _;
      if (!isLocal(socket.handshake.address)) return ack(cb, { ok: false, error: 'LocalOnly' });
      socket.data.role = 'host';
      socket.join('host');
      socket.emit('state', viewFor(socket));
      ack(cb, { ok: true });
    });

    socket.on('host:cmd', async (msg, cb) => {
      if (socket.data.role !== 'host') return ack(cb, { ok: false, error: 'NotHost' });
      const fn = commands[msg?.type];
      // защита от двойного нажатия: команда относится к состоянию, которое ведущий видел
      if (msg?.at && game && (msg.at.index !== game.index || msg.at.phase !== game.phase)) return ack(cb, { ok: false, error: 'Stale' });
      if (!fn) return ack(cb, { ok: false, error: 'UnknownCommand' });
      if (NEEDS_GAME.has(msg.type) && !game) return ack(cb, { ok: false, error: 'NoGame' });
      try {
        const r = await fn(msg);
        if (!r?.noChange) changed();
        ack(cb, { ok: true });
      } catch (e) {
        if (!/^[A-Z]\w+$/.test(e.message)) console.error(e);
        ack(cb, { ok: false, error: e.message });
      }
    });

    socket.on('screen:hello', (_, cb) => {
      if (typeof _ === 'function') cb = _;
      socket.data.role = 'screen';
      socket.join('screen');
      socket.emit('state', viewFor(socket));
      ack(cb, { ok: true });
    });

    socket.on('screen:video', (msg) => {
      // события видео принимаем только от экрана на самом ноутбуке
      if (socket.data.role !== 'screen' || !game || !isLocal(socket.handshake.address)) return;
      const s = game.slide;
      if (msg?.slideId && msg.slideId !== s?.id) return;
      if (msg?.event === 'error') videoError = s?.id ?? null;
      if (msg?.event === 'blocked') videoBlocked = s?.id ?? null;
      if (msg?.event === 'playing' && videoBlocked === s?.id) videoBlocked = null;
      if ((msg?.event === 'reachedPause' || msg?.event === 'error') && s?.type === 'question' && game.phase === 'slide') startQuestion();
      changed();
    });

    socket.on('player:join', (msg, cb) => {
      socket.data.role = 'player';
      if (!game) { socket.emit('state', viewFor(socket)); return ack(cb, { ok: false, error: 'NoGame' }); }
      try {
        const { playerId } = game.join({ playerId: msg?.playerId, name: msg?.name });
        socket.data.playerId = playerId;
        socket.join('players');
        ack(cb, { ok: true, playerId });
        changed();
      } catch (e) {
        ack(cb, { ok: false, error: e.message });
        socket.emit('state', viewFor(socket));
      }
    });

    socket.on('player:watch', () => {
      socket.data.role = 'player';
      socket.emit('state', viewFor(socket));
    });

    socket.on('player:answer', (msg, cb) => {
      const pid = socket.data.playerId;
      if (!game || !pid) return ack(cb, { accepted: false });
      const r = game.submitAnswer(pid, msg?.value, Date.now());
      ack(cb, { accepted: r.accepted, vote: Boolean(r.vote) });
      if (!r.accepted) return;
      if (r.allAnswered) { game.closeAnswers(); clearTimeout(timer); }
      changed();
    });

    socket.on('disconnect', () => {
      const pid = socket.data.playerId;
      if (!game || !pid) return;
      const stillHere = [...io.sockets.sockets.values()].some((s) => s !== socket && s.data.playerId === pid);
      if (!stillHere) { game.setConnected(pid, false); broadcast(); }
    });
  });

  await new Promise((resolve) => server.listen(port, resolve));
  baseUrl = defaultBaseUrl();
  const url = `http://localhost:${server.address().port}`;

  return {
    url,
    port: server.address().port,
    async close() {
      clearTimeout(timer);
      io.close();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

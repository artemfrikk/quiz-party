// Состояние игры. Чистый класс без сети и таймеров: время передаётся снаружи.
import { randomUUID } from 'node:crypto';
import { isTextCorrect } from './answers.js';

const SPEED_BONUS = 0.5;
const MAX_TEXT = 200;

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

export class Game {
  constructor(quiz, quizName) {
    this.quiz = quiz;
    this.quizName = quizName;
    this.players = new Map(); // id -> {id, name, teamId, connected}
    this.teams = new Map(); // id -> {id, name, captainId}
    this.mode = 'solo';
    this.captainMode = false; // в командах отвечает только капитан, остальные голосуют
    this.adjustments = []; // {target, id, delta, note, at}
    this.index = -1;
    this.phase = 'lobby';
    this.deadline = null;
    this.rounds = {}; // slideId -> {startedAt, points, timeLimit, answers: {pid: {value, at, autoCorrect, override}}}
    this.revealed = new Set();
    this.lastRevealed = null;
  }

  // ---------- игроки ----------

  uniqueName(base, exceptId = null) {
    const taken = new Set(
      [...this.players.values()].filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()),
    );
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  join({ playerId, name } = {}) {
    if (playerId && this.players.has(playerId)) {
      this.players.get(playerId).connected = true;
      return { playerId };
    }
    const clean = cleanName(name);
    if (!clean) throw new Error('EmptyName');
    const id = randomUUID();
    this.players.set(id, { id, name: this.uniqueName(clean), teamId: null, connected: true });
    return { playerId: id };
  }

  getPlayer(id) {
    const p = this.players.get(id);
    if (!p) throw new Error('NotFound');
    return p;
  }

  setConnected(playerId, connected) {
    const p = this.players.get(playerId);
    if (p) p.connected = Boolean(connected);
  }

  renamePlayer(id, name) {
    const p = this.getPlayer(id);
    const clean = cleanName(name);
    if (!clean) throw new Error('EmptyName');
    p.name = this.uniqueName(clean, id);
  }

  removePlayer(id) {
    const teamId = this.getPlayer(id).teamId;
    this.players.delete(id);
    if (teamId) this.fixCaptain(teamId);
    this.adjustments = this.adjustments.filter((a) => !(a.target === 'player' && a.id === id));
  }

  // ---------- команды ----------

  setMode(mode) {
    if (mode !== 'solo' && mode !== 'teams') throw new Error('BadMode');
    this.mode = mode;
  }

  createTeam(name) {
    const clean = cleanName(name) || `Команда ${this.teams.size + 1}`;
    const id = randomUUID();
    this.teams.set(id, { id, name: clean, captainId: null });
    return id;
  }

  getTeam(id) {
    const t = this.teams.get(id);
    if (!t) throw new Error('NotFound');
    return t;
  }

  renameTeam(id, name) {
    const clean = cleanName(name);
    if (!clean) throw new Error('EmptyName');
    this.getTeam(id).name = clean;
  }

  deleteTeam(id) {
    this.getTeam(id);
    this.teams.delete(id);
    for (const p of this.players.values()) if (p.teamId === id) p.teamId = null;
    this.adjustments = this.adjustments.filter((a) => !(a.target === 'team' && a.id === id));
  }

  assignPlayer(playerId, teamId) {
    const p = this.getPlayer(playerId);
    if (teamId != null) this.getTeam(teamId);
    const old = p.teamId;
    p.teamId = teamId ?? null;
    if (old && old !== p.teamId) this.fixCaptain(old);
    if (p.teamId) this.fixCaptain(p.teamId);
  }

  members(teamId) {
    return [...this.players.values()].filter((p) => p.teamId === teamId);
  }

  // капитан всегда участник команды: иначе — первый оставшийся
  fixCaptain(teamId) {
    const t = this.teams.get(teamId);
    if (!t) return;
    if (t.captainId && this.players.get(t.captainId)?.teamId === teamId) return;
    t.captainId = this.members(teamId)[0]?.id ?? null;
  }

  setCaptain(teamId, playerId) {
    const t = this.getTeam(teamId);
    if (this.getPlayer(playerId).teamId !== teamId) throw new Error('NotMember');
    t.captainId = playerId;
  }

  setCaptainMode(on) {
    this.captainMode = Boolean(on);
  }

  get captainsActive() {
    return this.mode === 'teams' && this.captainMode;
  }

  // ответ команды в раунде (его даёт капитан, хранится у ответившего с пометкой team)
  teamAnswer(slideId, teamId) {
    const r = this.rounds[slideId];
    if (!r) return null;
    for (const [pid, a] of Object.entries(r.answers)) if (a.team === teamId) return { pid, a };
    return null;
  }

  // ---------- очки ----------

  adjustPoints({ target, id, delta, note = '' }) {
    if (target === 'player') this.getPlayer(id);
    else if (target === 'team') this.getTeam(id);
    else throw new Error('BadTarget');
    const d = Math.round(Number(delta));
    if (!Number.isFinite(d) || d === 0) throw new Error('BadDelta');
    this.adjustments.push({ target, id, delta: d, note: String(note ?? '').slice(0, 100), at: Date.now() });
  }

  manualFor(target, id) {
    return this.adjustments.filter((a) => a.target === target && a.id === id).reduce((s, a) => s + a.delta, 0);
  }

  isCorrect(slideId, playerId) {
    const a = this.rounds[slideId]?.answers[playerId];
    if (!a) return false;
    return a.override ?? a.autoCorrect;
  }

  answerPoints(slideId, playerId) {
    if (!this.revealed.has(slideId) || !this.isCorrect(slideId, playerId)) return 0;
    const r = this.rounds[slideId];
    const a = r.answers[playerId];
    if (!r.timeLimit) return r.points;
    const frac = Math.max(0, 1 - (a.at - r.startedAt) / (r.timeLimit * 1000));
    return r.points + Math.round(r.points * SPEED_BONUS * frac);
  }

  // личные очки игрока (ответ за команду идёт в счёт команды)
  pointsFor(slideId, playerId) {
    if (this.rounds[slideId]?.answers[playerId]?.team) return 0;
    return this.answerPoints(slideId, playerId);
  }

  teamPointsFor(slideId, teamId) {
    const ta = this.teamAnswer(slideId, teamId);
    return ta ? this.answerPoints(slideId, ta.pid) : 0;
  }

  playerScore(id) {
    let s = this.manualFor('player', id);
    for (const slideId of this.revealed) s += this.pointsFor(slideId, id);
    return s;
  }

  teamScore(id) {
    let s = this.manualFor('team', id);
    for (const p of this.players.values()) if (p.teamId === id) s += this.playerScore(p.id);
    for (const slideId of this.revealed) s += this.teamPointsFor(slideId, id);
    return s;
  }

  scoreboard() {
    const last = this.lastRevealed;
    const lastDeltas = {};
    const players = [...this.players.values()]
      .map((p) => {
        const delta = last ? this.pointsFor(last, p.id) : 0;
        lastDeltas[p.id] = delta;
        return { id: p.id, name: p.name, teamId: p.teamId, score: this.playerScore(p.id), delta };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));
    const teams = [...this.teams.values()]
      .map((t) => {
        const delta = players.filter((p) => p.teamId === t.id).reduce((s, p) => s + p.delta, 0) + (last ? this.teamPointsFor(last, t.id) : 0);
        lastDeltas[t.id] = delta;
        return { id: t.id, name: t.name, score: this.teamScore(t.id), delta };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));
    return { mode: this.mode, teams, players, lastDeltas };
  }

  // ---------- ход игры ----------

  get slide() {
    return this.quiz.slides[this.index] ?? null;
  }

  goTo(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.quiz.slides.length) return false;
    this.index = index;
    this.deadline = null;
    const id = this.slide.id;
    if (this.revealed.has(id)) this.phase = 'reveal';
    else if (this.rounds[id]) this.phase = 'closed';
    else this.phase = 'slide';
    return true;
  }

  next() {
    if (this.phase === 'final') return false;
    if (this.index >= this.quiz.slides.length - 1) return this.finish();
    return this.goTo(this.index + 1);
  }

  prev() {
    if (this.phase === 'final') return this.goTo(this.quiz.slides.length - 1);
    if (this.index <= 0) return false;
    return this.goTo(this.index - 1);
  }

  startQuestion(now) {
    const s = this.slide;
    if (!s || s.type !== 'question' || this.phase !== 'slide' || this.rounds[s.id]) return false;
    const timeLimit = s.timeLimit ?? null;
    this.rounds[s.id] = { startedAt: now, points: s.points ?? 100, timeLimit, answers: {} };
    this.deadline = timeLimit ? now + timeLimit * 1000 : null;
    this.phase = 'question';
    return true;
  }

  connectedIds() {
    return [...this.players.values()].filter((p) => p.connected).map((p) => p.id);
  }

  // кто должен ответить: в режиме капитанов — команды (с кем-то на связи) и игроки без команды
  answerUnits(slideId) {
    const r = this.rounds[slideId];
    const units = new Map();
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      if (this.captainsActive && p.teamId && this.teams.has(p.teamId)) {
        units.set('t:' + p.teamId, Boolean(this.teamAnswer(slideId, p.teamId)));
      } else units.set('p:' + p.id, Boolean(r?.answers[p.id]));
    }
    return [...units.values()];
  }

  submitAnswer(playerId, value, now) {
    const no = { accepted: false, allAnswered: false };
    const s = this.slide;
    if (this.phase !== 'question' || !s || !this.players.has(playerId)) return no;
    const round = this.rounds[s.id];
    if (round.answers[playerId]) return no;
    if (this.deadline && now > this.deadline) return no;
    const p = this.players.get(playerId);
    const team = this.captainsActive && p.teamId ? this.teams.get(p.teamId) : null;
    if (team && this.teamAnswer(s.id, team.id)) return no;
    let autoCorrect;
    if (s.answerType === 'choice') {
      if (!Number.isInteger(value) || value < 0 || value >= s.options.length) return no;
      autoCorrect = value === s.correctIndex;
    } else {
      if (typeof value !== 'string') return no;
      value = value.trim().slice(0, MAX_TEXT);
      if (!value) return no;
      autoCorrect = isTextCorrect(value, s);
    }
    if (team && team.captainId !== playerId) {
      round.votes ??= {};
      round.votes[playerId] = { value, teamId: team.id };
      return { accepted: true, vote: true, allAnswered: false };
    }
    round.answers[playerId] = { value, at: now, autoCorrect, override: null, ...(team ? { team: team.id } : {}) };
    const units = this.answerUnits(s.id);
    const allAnswered = units.length > 0 && units.every(Boolean);
    return { accepted: true, allAnswered };
  }

  closeAnswers() {
    if (this.phase !== 'question') return false;
    this.phase = 'closed';
    this.deadline = null;
    return true;
  }

  reveal() {
    if (this.phase !== 'question' && this.phase !== 'closed') return false;
    this.phase = 'reveal';
    this.deadline = null;
    this.revealed.add(this.slide.id);
    this.lastRevealed = this.slide.id;
    return true;
  }

  showScores() {
    if (this.phase === 'lobby') return false;
    if (this.phase === 'question') this.closeAnswers();
    this.phase = 'scores';
    this.deadline = null;
    return true;
  }

  finish() {
    this.phase = 'final';
    this.deadline = null;
    return true;
  }

  overrideAnswer(slideId, playerId, correct) {
    const slide = this.quiz.slides.find((s) => s.id === slideId);
    const a = this.rounds[slideId]?.answers[playerId];
    if (!slide || slide.answerType !== 'text' || !a) throw new Error('NotFound');
    if (this.slide?.id === slideId && this.phase === 'question') throw new Error('StillOpen');
    a.override = Boolean(correct) === a.autoCorrect ? null : Boolean(correct);
  }

  // ---------- представления ----------

  publicSlide(s, withAnswer) {
    if (!s) return null;
    const out = { id: s.id, type: s.type, text: s.text ?? '', media: s.media ?? null };
    if (s.type === 'question') {
      out.answerType = s.answerType;
      out.options = s.answerType === 'choice' ? [...s.options] : [];
      out.points = s.points ?? 100;
      out.timeLimit = s.timeLimit ?? null;
      if (withAnswer) {
        out.correctIndex = s.correctIndex;
        out.accepted = [...(s.accepted ?? [])];
        out.numeric = Boolean(s.numeric);
      }
    }
    return out;
  }

  distribution() {
    const s = this.slide;
    if (!s || s.answerType !== 'choice' || !this.rounds[s.id]) return null;
    const d = s.options.map(() => 0);
    for (const a of Object.values(this.rounds[s.id].answers)) d[a.value]++;
    return d;
  }

  // голоса команды: для вариантов — счётчики по вариантам, для текста — сгруппированный список
  votesFor(teamId) {
    const s = this.slide;
    const r = s ? this.rounds[s.id] : null;
    if (!r || s.type !== 'question') return null;
    const vs = Object.entries(r.votes ?? {}).filter(([pid, v]) => v.teamId === teamId && this.players.get(pid)?.teamId === teamId).map(([, v]) => v);
    if (s.answerType === 'choice') {
      const d = s.options.map(() => 0);
      for (const v of vs) d[v.value]++;
      return d;
    }
    const groups = new Map();
    for (const v of vs) {
      const key = v.value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
      const g = groups.get(key) ?? { text: v.value.trim(), count: 0 };
      g.count++;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
  }

  common(now) {
    const s = this.slide;
    const round = s ? this.rounds[s.id] : null;
    return {
      quizName: this.quizName,
      quizTitle: this.quiz.title ?? this.quizName,
      phase: this.phase,
      index: this.index,
      total: this.quiz.slides.length,
      mode: this.mode,
      remainingMs: this.deadline ? Math.max(0, this.deadline - now) : null,
      answeredCount: round ? this.answerUnits(s.id).filter(Boolean).length : 0,
      totalCount: s ? this.answerUnits(s.id).length : this.connectedIds().length,
      captainMode: this.captainsActive,
    };
  }

  playersList() {
    return [...this.players.values()].map((p) => ({ ...p }));
  }

  teamsList() {
    return [...this.teams.values()].map((t) => ({ ...t }));
  }

  hostView(now = Date.now()) {
    const s = this.slide;
    const round = s ? this.rounds[s.id] : null;
    const answers = round
      ? Object.entries(round.answers).map(([pid, a]) => ({
          playerId: pid,
          name: a.team ? `${this.teams.get(a.team)?.name ?? '—'} (${this.players.get(pid)?.name ?? '—'})` : this.players.get(pid)?.name ?? '—',
          value: a.value,
          autoCorrect: a.autoCorrect,
          override: a.override,
          correct: a.override ?? a.autoCorrect,
        }))
      : [];
    return {
      ...this.common(now),
      slides: this.quiz.slides,
      slide: this.publicSlide(s, true),
      nextSlide: this.publicSlide(this.quiz.slides[this.index + 1], true),
      players: this.playersList().map((p) => ({ ...p, answered: Boolean(round?.answers[p.id]) || Boolean(round?.votes?.[p.id]) })),
      teams: this.teamsList().map((t) => ({
        ...t,
        answered: Boolean(s && this.teamAnswer(s.id, t.id)),
        votes: this.captainsActive ? this.votesFor(t.id) : null,
      })),
      captainModeSetting: this.captainMode,
      answers,
      distribution: this.distribution(),
      adjustments: this.adjustments.map((a) => ({
        ...a,
        name: (a.target === 'player' ? this.players.get(a.id)?.name : this.teams.get(a.id)?.name) ?? '—',
      })),
      scoreboard: this.scoreboard(),
      revealed: [...this.revealed],
    };
  }

  screenView(now = Date.now()) {
    const showAnswer = this.phase === 'reveal';
    const v = {
      ...this.common(now),
      slide: this.publicSlide(this.slide, showAnswer),
      players: this.playersList().map(({ id, name, teamId, connected }) => ({ id, name, teamId, connected })),
      teams: this.teamsList(),
    };
    if (showAnswer) v.distribution = this.distribution();
    if (this.phase === 'scores' || this.phase === 'final') v.scoreboard = this.scoreboard();
    return v;
  }

  playerView(playerId, now = Date.now()) {
    const p = this.players.get(playerId);
    if (!p) return null;
    const sb = this.scoreboard();
    const place = sb.players.findIndex((x) => x.id === playerId) + 1;
    const team = p.teamId ? this.teams.get(p.teamId) : null;
    const teamPlace = team ? sb.teams.findIndex((x) => x.id === team.id) + 1 : null;
    const s = this.slide;
    const inQuestion = ['question', 'closed', 'reveal'].includes(this.phase) && s?.type === 'question';
    const asTeam = this.captainsActive && team;
    const ta = inQuestion && asTeam ? this.teamAnswer(s.id, team.id) : null;
    const mine = inQuestion ? (asTeam ? ta?.a : this.rounds[s.id]?.answers[playerId]) : null;
    const isCaptain = Boolean(asTeam && team.captainId === playerId);
    const v = {
      ...this.common(now),
      me: {
        id: p.id,
        name: p.name,
        teamName: team?.name ?? null,
        score: this.playerScore(p.id),
        place,
        playerCount: sb.players.length,
        teamScore: team ? this.teamScore(team.id) : null,
        teamPlace,
        teamCount: sb.teams.length,
        isCaptain,
        captainName: asTeam ? this.players.get(team.captainId)?.name ?? null : null,
      },
      slide: inQuestion ? this.publicSlide(s, false) : null,
      myAnswer: mine ? mine.value : null,
    };
    if (inQuestion && asTeam) {
      if (isCaptain) v.votes = this.votesFor(team.id);
      else v.myVote = this.rounds[s.id]?.votes?.[playerId]?.value ?? null;
    }
    if (this.phase === 'reveal' && inQuestion) {
      v.result = {
        answered: Boolean(mine),
        correct: asTeam ? Boolean(ta && this.isCorrect(s.id, ta.pid)) : this.isCorrect(s.id, playerId),
        points: asTeam ? this.teamPointsFor(s.id, team.id) : this.pointsFor(s.id, playerId),
        correctText: s.answerType === 'choice' ? s.options[s.correctIndex] : (s.accepted ?? [])[0] ?? '',
      };
    }
    return v;
  }

  // ---------- сохранение и экспорт ----------

  toJSON() {
    return {
      version: 1,
      quiz: this.quiz,
      quizName: this.quizName,
      players: this.playersList(),
      teams: this.teamsList(),
      mode: this.mode,
      captainMode: this.captainMode,
      adjustments: this.adjustments,
      index: this.index,
      phase: this.phase,
      rounds: this.rounds,
      revealed: [...this.revealed],
      lastRevealed: this.lastRevealed,
    };
  }

  static fromJSON(data, quiz = data.quiz) {
    const g = new Game(quiz, data.quizName);
    for (const p of data.players) g.players.set(p.id, { ...p, connected: false });
    for (const t of data.teams) g.teams.set(t.id, { ...t });
    g.mode = data.mode;
    g.captainMode = Boolean(data.captainMode);
    for (const t of g.teams.values()) { t.captainId ??= null; g.fixCaptain(t.id); }
    g.adjustments = data.adjustments ?? [];
    g.index = data.index;
    g.phase = data.phase === 'question' ? 'closed' : data.phase; // таймер не переживает перезапуск
    g.rounds = data.rounds ?? {};
    g.revealed = new Set(data.revealed ?? []);
    g.lastRevealed = data.lastRevealed ?? null;
    return g;
  }

  exportCsv() {
    const esc = (v) => {
      let s = String(v ?? '');
      // Excel не должен выполнять «формулы» из имён и ответов игроков
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [['Игрок', 'Команда', 'Слайд', 'Ответ', 'Верно', 'Очки']];
    const teamName = (p) => (p.teamId ? this.teams.get(p.teamId)?.name ?? '' : '');
    this.quiz.slides.forEach((s, i) => {
      const round = this.rounds[s.id];
      if (!round) return;
      for (const [pid, a] of Object.entries(round.answers)) {
        const p = this.players.get(pid);
        if (!p) continue;
        const shown = s.answerType === 'choice' ? `${'ABCD'[a.value]}: ${s.options[a.value]}` : a.value;
        rows.push([a.team ? `${p.name} (капитан)` : p.name, a.team ? this.teams.get(a.team)?.name ?? '' : teamName(p), `${i + 1}. ${s.text}`, shown, this.isCorrect(s.id, pid) ? 'да' : 'нет', this.answerPoints(s.id, pid)]);
      }
    });
    rows.push([]);
    for (const a of this.adjustments) {
      const name = (a.target === 'player' ? this.players.get(a.id)?.name : this.teams.get(a.id)?.name) ?? '';
      rows.push(['Правка', name, '', a.note, '', a.delta]);
    }
    rows.push([]);
    rows.push(['Итог', 'Команда', '', '', '', 'Очки']);
    const sb = this.scoreboard();
    for (const p of sb.players) rows.push([p.name, p.teamId ? this.teams.get(p.teamId)?.name ?? '' : '', '', '', '', p.score]);
    for (const t of sb.teams) rows.push([`Команда: ${t.name}`, '', '', '', '', t.score]);
    return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
  }
}

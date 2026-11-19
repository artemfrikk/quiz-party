import { connect } from '/shared/socket.js';
import { h, $, LETTERS, plural } from '/shared/dom.js';
import { createPlayer } from '/shared/video-player.js';

const socket = connect();
let s = null;
let deadlineAt = null;
let currentSlideId = null;
let lastPhase = null;
let player = null;
let playerToken = 0;
let blocked = false;

// клик по экрану разрешает звук; если видео было заблокировано — продолжаем его
function unlockVideo() {
  if (!blocked) return;
  blocked = false;
  player?.play();
  if (currentSlideId) socket.emit('screen:video', { event: 'playing', slideId: currentSlideId });
}
document.addEventListener('click', unlockVideo);

$('#start').addEventListener('click', () => {
  $('#start').remove();
  unlockVideo();
  document.documentElement.requestFullscreen?.().catch(() => {});
});

socket.on('connect', () => { $('#offline').classList.add('hidden'); socket.emit('screen:hello'); });
socket.on('disconnect', () => $('#offline').classList.remove('hidden'));
socket.on('state', (st) => { s = st; deadlineAt = st.remainingMs != null ? Date.now() + st.remainingMs : null; render(); });
socket.on('video', ({ action, t }) => {
  if (!player) return;
  if (action === 'play') player.play();
  else if (action === 'pause') player.pause();
  else if (action === 'seek') player.seekBy(t);
  else if (action === 'restart') startSegment();
});

function show(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === id));
}

// QR в углу: на всех экранах, кроме лобби (там он большой); ведущий может скрыть
function renderCornerQr() {
  const on = Boolean(!s.noGame && s.showQr !== false && s.phase !== 'lobby' && s.baseUrl);
  $('#corner-qr').classList.toggle('hidden', !on);
  document.body.classList.toggle('qr-on', on);
  if (!on) return;
  const url = `${s.baseUrl}/play/`;
  const src = `/api/qr?text=${encodeURIComponent(url)}`;
  const img = $('#corner-qr-img');
  if (img.getAttribute('src') !== src) img.src = src;
  $('#corner-url').textContent = url.replace(/^https?:\/\//, '');
}

function render() {
  renderCornerQr();
  if (s.noGame) { show('waiting'); dropMedia(); return; }
  if (s.phase === 'lobby') { dropMedia(); renderLobby(); show('lobby'); }
  else if (s.phase === 'scores' || s.phase === 'final') { renderScores(); show('scores'); player?.pause(); }
  else { renderSlide(); show('slide'); }
  lastPhase = s.phase;
}

// ---------- лобби ----------
function renderLobby() {
  const url = `${s.baseUrl}/play/`;
  $('#lobby-title').textContent = s.quizTitle;
  const img = $('#qr');
  const qrSrc = `/api/qr?text=${encodeURIComponent(url)}`;
  if (img.getAttribute('src') !== qrSrc) img.src = qrSrc;
  $('#join-url').textContent = url.replace(/^https?:\/\//, '');
  const n = s.players.length;
  $('#lobby-count').textContent = n ? `${n} ${plural(n, 'игрок', 'игрока', 'игроков')}` : 'Пока никого нет';
  const box = $('#lobby-players');
  const chip = (p) => h('span', { class: 'chip' + (p.connected ? '' : ' off') }, p.name);
  if (s.mode === 'teams' && s.teams.length) {
    box.className = 'teams';
    const groups = s.teams.map((t) => h('div', { class: 'team-box' }, h('h3', {}, t.name), h('div', { class: 'chips' }, s.players.filter((p) => p.teamId === t.id).map(chip))));
    const rest = s.players.filter((p) => !p.teamId);
    if (rest.length) groups.push(h('div', { class: 'team-box' }, h('h3', { class: 'muted' }, 'Без команды'), h('div', { class: 'chips' }, rest.map(chip))));
    box.replaceChildren(...groups);
  } else {
    box.className = '';
    box.replaceChildren(...s.players.map(chip));
  }
}

// ---------- слайд ----------
function dropMedia() {
  playerToken++;
  player?.destroy();
  player = null;
  currentSlideId = null;
  $('#s-media').replaceChildren();
}

function startSegment() {
  const m = s?.slide?.media;
  if (!player || m?.kind !== 'video') return;
  const isQ = s.slide.type === 'question' && m.pauseAt != null;
  if (isQ && (s.phase === 'reveal')) player.playSegment(m.pauseAt, m.end ?? null);
  else if (isQ && s.phase !== 'slide') player.show(m.pauseAt);
  else player.playSegment(m.start ?? 0, isQ ? m.pauseAt : (m.end ?? null));
}

async function buildMedia(sl) {
  const box = $('#s-media');
  const m = sl.media;
  if (!m) return;
  if (m.kind === 'image') {
    box.replaceChildren(h('img', { src: `/quizzes/${encodeURIComponent(s.quizName)}/media/${encodeURIComponent(m.src.replace(/^media\//, ''))}`, alt: '' }));
    return;
  }
  const token = ++playerToken;
  const slideId = sl.id;
  try {
    const p = await createPlayer(box, m, s.quizName, {
      onPauseReached: () => socket.emit('screen:video', { event: 'reachedPause', slideId }),
      onEnded: () => socket.emit('screen:video', { event: 'ended', slideId }),
      onError: () => socket.emit('screen:video', { event: 'error', slideId }),
      onBlocked: () => { blocked = true; socket.emit('screen:video', { event: 'blocked', slideId }); },
    });
    if (token !== playerToken) { p.destroy(); return; }
    player = p;
    startSegment();
  } catch {
    if (token !== playerToken) return;
    box.replaceChildren();
    socket.emit('screen:video', { event: 'error', slideId });
  }
}

function renderSlide() {
  const sl = s.slide;
  const view = $('#slide');
  if (sl.id !== currentSlideId) {
    dropMedia();
    currentSlideId = sl.id;
    $('#s-text').textContent = sl.text;
    view.className = 'view on ' + sl.type + (sl.media ? '' : ' text-only');
    buildMedia(sl);
  } else if (s.phase === 'reveal' && lastPhase !== 'reveal' && sl.media?.kind === 'video' && sl.media.pauseAt != null) {
    startSegment();
  }
  view.classList.toggle('reveal', s.phase === 'reveal');

  // варианты
  const opts = $('#s-options');
  const isQ = sl.type === 'question';
  const asking = isQ && s.phase !== 'slide';
  if (!asking) opts.replaceChildren();
  else if (sl.answerType === 'choice') {
    const dist = s.distribution;
    const total = dist ? dist.reduce((a, b) => a + b, 0) : 0;
    opts.replaceChildren(...sl.options.map((o, i) => {
      const cls = s.phase === 'reveal' ? (i === sl.correctIndex ? ' right' : ' wrong') : '';
      return h('div', { class: `opt opt-${i}${cls}` },
        dist && h('div', { class: 'fill', style: { width: total ? `${(dist[i] / total) * 100}%` : '0%' } }),
        h('span', { class: 'l' }, LETTERS[i]), h('span', { class: 't' }, o),
        dist && h('span', { class: 'n' }, dist[i]));
    }));
  } else if (s.phase === 'reveal') {
    opts.replaceChildren(h('div', { class: 'text-reveal' }, (sl.accepted ?? []).join(' / ')));
  } else {
    opts.replaceChildren(h('div', { class: 'text-wait' }, 'Пишите ответ на телефоне ✍️'));
  }

  $('#s-count').textContent = asking ? `Ответили ${s.answeredCount} из ${s.totalCount}` : '';
  $('#s-num').textContent = `${s.index + 1} / ${s.total}`;
  tick();
}

function tick() {
  const el = $('#s-timer');
  if (!s || s.phase !== 'question' || !deadlineAt) { el.textContent = ''; return; }
  const left = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
  el.textContent = left;
  el.classList.toggle('low', left <= 5);
}
setInterval(tick, 200);

// ---------- очки ----------
function renderScores() {
  const sb = s.scoreboard;
  const teams = sb.mode === 'teams' && sb.teams.length;
  const list = teams ? sb.teams : sb.players;
  const final = s.phase === 'final';
  $('#scores-title').replaceChildren(final
    ? h('div', { class: 'winner' }, list[0] ? `🏆 Победа: ${list[0].name}!` : 'Игра окончена')
    : 'Таблица');
  $('#scores-list').replaceChildren(...list.slice(0, 10).map((r, i) => h('div', { class: 'row' + (i === 0 ? ' first' : ''), style: { animationDelay: `${i * 70}ms` } },
    h('span', { class: 'pl' }, i + 1),
    h('span', { class: 'nm' }, r.name),
    !final && r.delta ? h('span', { class: 'dl' + (r.delta < 0 ? ' neg' : '') }, (r.delta > 0 ? '+' : '') + r.delta) : h('span', { class: 'dl' }),
    h('span', { class: 'sc' }, r.score))));
  if (teams) {
    const top = sb.players.slice(0, 3).map((p, i) => `${i + 1}. ${p.name} — ${p.score}`).join('   ');
    const solo = sb.players.filter((p) => !p.teamId);
    $('#scores-top').textContent = (top ? `Лучшие игроки: ${top}` : '') + (solo.length ? `   ·   Без команды: ${solo.map((p) => `${p.name} ${p.score}`).join(', ')}` : '');
  } else $('#scores-top').textContent = '';
}

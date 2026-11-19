import { connect, emit } from '/shared/socket.js';
import { h, $, LETTERS, plural } from '/shared/dom.js';
import { mediaUrl } from '/shared/video-player.js';

const socket = connect();
let s = null;
let deadlineAt = null;

const ERRORS = {
  EmptyName: 'Имя не может быть пустым',
  NotFound: 'Не найдено',
  NoGame: 'Сначала загрузите квиз',
  LocalOnly: 'Пульт работает только на этом компьютере (адрес localhost)',
  StillOpen: 'Сначала закройте приём ответов',
  BadDelta: 'Введите число, не равное нулю',
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function cmd(type, args = {}) {
  const r = await emit(socket, 'host:cmd', { type, ...args });
  if (!r?.ok && r?.error !== 'Stale') toast(ERRORS[r?.error] ?? `Ошибка: ${r?.error ?? 'нет связи'}`);
  return r;
}

// навигация привязана к состоянию, которое видит ведущий: двойной клик не перескочит слайд
const nav = (type, args = {}) => cmd(type, { ...args, at: { index: s.index, phase: s.phase } });

socket.on('connect', async () => {
  const r = await emit(socket, 'host:hello');
  if (!r?.ok) toast(ERRORS[r?.error] ?? 'Нет доступа');
  loadQuizList();
});
socket.on('disconnect', () => toast('Нет связи с сервером. Проверьте окно с сервером.'));
let firstVersion = null;
socket.on('state', (st) => {
  // сервер перезапустился с новой версией — подтягиваем новый пульт
  if (st.appVersion) {
    if (firstVersion && st.appVersion !== firstVersion) return location.reload();
    firstVersion = st.appVersion;
  }
  renderUpdate(st);
  s = st;
  deadlineAt = st.remainingMs != null ? Date.now() + st.remainingMs : null;
  render();
});

// ---------- обновления ----------
function renderUpdate(st) {
  $('#check-update').textContent = st.appVersion ? `v${st.appVersion}` : '';
  $('#check-update').classList.toggle('hidden', !st.appVersion);
  const v = st.updateAvailable;
  $('#update').classList.toggle('hidden', !v || updating);
  if (v) $('#update-text').textContent = `Доступна новая версия ${v}.`;
}
let updating = false;
$('#check-update').addEventListener('click', async () => {
  try {
    const r = await (await fetch('/api/update?refresh=1')).json();
    if (r.error) toast(r.error);
    else if (r.available) { toast(`Есть версия ${r.available.version}`); s.updateAvailable = r.available.version; renderUpdate(s); }
    else toast(`Установлена последняя версия (${r.current})`);
  } catch { toast('Нет связи с сервером'); }
});
$('#update-btn').addEventListener('click', async () => {
  if (!confirm('Скачать и установить обновление? Квизы и сохранения останутся. Сервер перезапустится сам.')) return;
  updating = true;
  $('#update-btn').disabled = true;
  $('#update-text').textContent = 'Скачиваю и устанавливаю…';
  try {
    const r = await fetch('/api/update', { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    $('#update-text').textContent = `Версия ${j.version} установлена, перезапуск…`;
    // ждём, пока сервер поднимется, и перезагружаем пульт
    const wait = async () => { try { await fetch('/api/update'); location.reload(); } catch { setTimeout(wait, 1000); } };
    setTimeout(wait, 2500);
  } catch (e) {
    updating = false;
    $('#update-btn').disabled = false;
    $('#update-text').textContent = '';
    toast({ GameRunning: 'Обновить можно, когда игра не идёт (в лобби или после финала)', BadChecksum: 'Файл обновления повреждён, попробуйте ещё раз' }[e.message] ?? `Не удалось обновить: ${e.message}`);
    renderUpdate(s);
  }
});

// ---------- верхняя панель ----------
async function loadQuizList() {
  try {
    const list = await (await fetch('/api/quizzes')).json();
    const sel = $('#quiz-select');
    const cur = s?.quizName ?? sel.value;
    sel.replaceChildren(...list.map((q) => h('option', { value: q.name }, `${q.name} (${q.slideCount} ${plural(q.slideCount, 'слайд', 'слайда', 'слайдов')})`)));
    if (cur && list.some((q) => q.name === cur)) sel.value = cur;
  } catch { /* сервер недоступен */ }
}
$('#quiz-select').addEventListener('focus', loadQuizList);
$('#load-quiz').addEventListener('click', async () => {
  const name = $('#quiz-select').value;
  if (!name) return toast('Нет квизов — создайте в редакторе');
  if (s?.hasSavedGame && !confirm('Есть сохранённая прошлая игра. Начать новую? (Копия старой останется в data/game-state.prev.json)')) return;
  if (s && !s.noGame && s.phase !== 'lobby' && !confirm('Начать другой квиз? Игроки и команды останутся, текущий прогресс будет заменён.')) return;
  cmd('loadQuiz', { name });
});
$('#addr-select').addEventListener('change', (e) => cmd('setBaseUrl', { url: e.target.value }));
$('#open-screen').addEventListener('click', () => {
  const w = window.open('/screen/', 'quiz-screen', 'popup,width=1280,height=720');
  if (!w) toast('Браузер заблокировал окно — разрешите всплывающие окна');
});
$('#resume-btn').addEventListener('click', () => cmd('resume'));
$('#csv').addEventListener('click', (e) => { if (!s || s.noGame) { e.preventDefault(); toast('Игра ещё не загружена'); } });

// ---------- участники ----------
document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => cmd('setMode', { mode: b.dataset.mode })));
$('#add-team').addEventListener('click', () => {
  const name = prompt('Название команды', `Команда ${(s?.teams?.length ?? 0) + 1}`);
  if (name !== null) cmd('createTeam', { name });
});

$('#captain-mode').addEventListener('change', (e) => cmd('setCaptainMode', { on: e.target.checked }));

function playerCard(p, team) {
  const isCap = team && team.captainId === p.id;
  const capBtn = team && s.captainModeSetting && (isCap
    ? h('span', { class: 'crown', title: 'Капитан' }, '👑')
    : h('button', { class: 'make-cap', title: 'Сделать капитаном', onclick: () => cmd('setCaptain', { teamId: team.id, playerId: p.id }) }, '👑'));
  const card = h('div', { class: 'pcard' + (p.connected ? '' : ' off') + (isCap && s.captainModeSetting ? ' cap' : ''), draggable: 'true', title: p.connected ? 'на связи' : 'не на связи' },
    h('span', { class: 'dot' }), capBtn, h('span', {}, p.name),
    h('button', { title: 'Переименовать', onclick: () => { const n = prompt('Новое имя', p.name); if (n) cmd('renamePlayer', { id: p.id, name: n }); } }, '✎'),
    h('button', { title: 'Удалить', onclick: () => confirm(`Удалить игрока «${p.name}»?`) && cmd('removePlayer', { id: p.id }) }, '×'));
  card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/player', p.id); e.dataTransfer.effectAllowed = 'move'; });
  return card;
}

function dropZone(el, teamId) {
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/player')) { e.preventDefault(); el.classList.add('over'); } });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('over');
    const id = e.dataTransfer.getData('text/player');
    if (id) cmd('assignPlayer', { playerId: id, teamId });
  });
  return el;
}

let peopleKey = '';
let dragging = false;
document.addEventListener('dragstart', () => { dragging = true; });
document.addEventListener('dragend', () => { dragging = false; if (s && !s.noGame) renderPeople(); });

function renderPeople() {
  const teams = s.mode === 'teams';
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === s.mode));
  $('#team-tools').classList.toggle('hidden', !teams);
  $('#captain-mode').checked = Boolean(s.captainModeSetting);
  const online = s.players.filter((p) => p.connected).length;
  $('#people-count').textContent = `${online} на связи из ${s.players.length}`;
  // не перерисовываем колонки, пока что-то тащат или если ничего не изменилось
  const key = JSON.stringify([s.mode, s.captainModeSetting, s.teams.map((t) => [t.id, t.name, t.captainId]), s.players.map((p) => [p.id, p.name, p.teamId, p.connected]), s.scoreboard.teams.map((t) => t.score)]);
  if (dragging || key === peopleKey) return;
  peopleKey = key;
  const score = Object.fromEntries([...s.scoreboard.teams, ...s.scoreboard.players].map((x) => [x.id, x.score]));
  const cols = [];
  if (teams) {
    for (const t of s.teams) {
      cols.push(dropZone(h('div', { class: 'col' },
        h('div', { class: 'col-head' },
          h('span', { class: 'name', title: 'Двойной клик — переименовать', ondblclick: () => { const n = prompt('Название команды', t.name); if (n) cmd('renameTeam', { id: t.id, name: n }); } }, t.name),
          h('span', { class: 'pts' }, `${score[t.id] ?? 0} очк.`),
          h('button', { title: 'Удалить команду', onclick: () => confirm(`Удалить команду «${t.name}»? Игроки останутся без команды.`) && cmd('deleteTeam', { id: t.id }) }, '×')),
        h('div', { class: 'pcards' }, s.players.filter((p) => p.teamId === t.id).map((p) => playerCard(p, t)))), t.id));
    }
  }
  const rest = teams ? s.players.filter((p) => !p.teamId || !s.teams.some((t) => t.id === p.teamId)) : s.players;
  cols.push(dropZone(h('div', { class: 'col' },
    h('div', { class: 'col-head' }, h('span', { class: 'name muted' }, teams ? 'Без команды' : 'Игроки')),
    rest.length ? h('div', { class: 'pcards' }, rest.map((p) => playerCard(p))) : h('div', { class: 'muted small' }, s.players.length ? 'Все распределены' : 'Пока никто не вошёл. Покажите QR на экране.')), null));
  $('#columns').replaceChildren(...cols);
}

// ---------- ход игры ----------
const PHASE = { lobby: 'Лобби', slide: 'Показ слайда', question: 'Идёт приём ответов', closed: 'Приём закрыт', reveal: 'Ответ показан', scores: 'Таблица очков', final: 'Финал' };

function primaryAction() {
  const sl = s.slide;
  switch (s.phase) {
    case 'lobby': return ['Начать квиз', () => nav('next')];
    case 'slide':
      if (sl?.type === 'question') return ['Старт вопроса', () => nav('startQuestion')];
      return ['Дальше', () => nav('next')];
    case 'question': return ['Показать ответ', () => nav('reveal')];
    case 'closed': return ['Показать ответ', () => nav('reveal')];
    case 'reveal': return ['Таблица', () => nav('showScores')];
    case 'scores': return [s.index >= s.total - 1 ? 'Финал' : 'Следующий слайд', () => nav('next')];
    default: return ['—', null];
  }
}

function mediaLine(m) {
  if (!m) return null;
  if (m.kind === 'image') return h('img', { src: mediaUrl(s.quizName, m.src), alt: '' });
  const where = m.source === 'youtube' ? 'YouTube' : 'Видеофайл';
  const fmt = (t) => (t == null ? 'конец' : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`);
  return h('div', { class: 'media' }, `🎬 ${where}: ${fmt(m.start ?? 0)} → ${m.pauseAt != null ? `пауза ${fmt(m.pauseAt)} → ` : ''}${fmt(m.end)}`);
}

function renderGame() {
  const sl = s.slide;
  const inGame = s.index >= 0 && s.phase !== 'lobby';
  $('#slide-title').textContent = inGame ? `Слайд ${s.index + 1} из ${s.total} · ${PHASE[s.phase]}` : PHASE[s.phase];

  const jump = $('#jump');
  const jumpKey = JSON.stringify(s.slides.map((x) => [x.type, x.text]));
  if (jump.dataset.key !== jumpKey) {
    jump.dataset.key = jumpKey;
    jump.replaceChildren(h('option', { value: '' }, 'Перейти к слайду…'), ...s.slides.map((x, i) => h('option', { value: i }, `${i + 1}. ${x.type === 'info' ? 'ℹ ' : ''}${(x.text || '(без текста)').slice(0, 50)}`)));
    jump.value = '';
  }

  const card = $('#slide-card');
  if (!sl || s.phase === 'lobby') {
    card.replaceChildren(h('div', { class: 'q' }, s.quizTitle), h('div', { class: 'muted' }, 'Ждём игроков. Когда все вошли — «Начать квиз».'));
  } else if (s.phase === 'final') {
    card.replaceChildren(h('div', { class: 'q' }, '🏆 Финал'), h('div', { class: 'muted' }, 'На экране итоговая таблица. Скачайте результаты сверху.'));
  } else {
    const dist = s.distribution;
    card.replaceChildren(...[
      h('div', { class: 'q' }, sl.text || '(без текста)'),
      mediaLine(sl.media),
      sl.type === 'question' && sl.answerType === 'choice' && h('div', { class: 'hopts' }, sl.options.map((o, i) =>
        h('div', { class: `hopt opt-${i}${i === sl.correctIndex ? ' right' : ''}` }, h('b', {}, LETTERS[i]), o, i === sl.correctIndex ? ' ✓' : '', dist && h('span', { class: 'cnt' }, dist[i])))),
      sl.type === 'question' && sl.answerType === 'text' && h('div', {}, 'Правильно: ', h('span', { class: 'accepted' }, sl.accepted.join(' / ') || '—'), sl.numeric ? h('span', { class: 'muted' }, ' (сравнение по числу)') : ''),
      sl.type === 'question' && h('div', { class: 'muted small' }, `${sl.points} очков${sl.timeLimit ? `, ${sl.timeLimit} с` : ', без таймера'}`),
    ].filter(Boolean));
  }

  const isVideo = sl?.media?.kind === 'video' && !['lobby', 'final', 'scores'].includes(s.phase);
  $('#video-ctl').classList.toggle('hidden', !isVideo);
  $('#video-warn').classList.toggle('hidden', !s.videoError);
  $('#video-blocked').classList.toggle('hidden', !s.videoBlocked);
  const qw = $('#quiz-warn');
  qw.classList.toggle('hidden', !s.quizWarnings?.length);
  qw.replaceChildren(...(s.quizWarnings ?? []).map((w) => h('div', {}, `⚠ Слайд ${w.index + 1}: ${w.errors.join('; ')}`)));

  const asking = ['question', 'closed', 'reveal'].includes(s.phase) && sl?.type === 'question';
  $('#answered').textContent = asking ? `Ответили ${s.answeredCount} из ${s.totalCount}` : (s.phase === 'slide' && sl?.type === 'question' && sl.media?.kind === 'video' && sl.media.pauseAt != null ? 'Вопрос появится сам, когда видео дойдёт до паузы' : '');

  const [label, fn] = primaryAction();
  const primary = $('#primary');
  primary.textContent = label;
  primary.disabled = !fn;
  primary.onclick = fn;
  $('#prev').disabled = s.phase === 'lobby' || (s.index <= 0 && s.phase !== 'final');
  $('#close').classList.toggle('hidden', s.phase !== 'question');
  $('#reveal').classList.toggle('hidden', !(s.phase === 'question'));
  $('#scores').classList.toggle('hidden', ['lobby', 'scores', 'final', 'reveal'].includes(s.phase));
  $('#next').disabled = s.phase === 'final';
  $('#finish').classList.toggle('hidden', s.phase === 'final' || s.phase === 'lobby');

  // кто ответил
  $('#answer-chips').replaceChildren(...(!asking ? [] : s.captainMode ? captainChips(sl) : s.players.map((p) => h('span', { class: 'chip' + (p.answered ? ' yes' : '') + (p.connected ? '' : ' off') }, (p.answered ? '✓ ' : '… ') + p.name))));

  // свободные ответы
  const ta = $('#text-answers');
  if (asking && sl.answerType === 'text' && s.answers.length) {
    const canEdit = s.phase !== 'question';
    ta.replaceChildren(h('table', { class: 'tans' }, s.answers.map((a) => h('tr', {},
      h('td', {}, a.name),
      h('td', {}, a.value),
      h('td', { class: a.correct ? 'ok' : 'no' }, a.correct ? '✓ засчитан' : '✗ нет', a.override !== null ? ' (вручную)' : ''),
      h('td', {}, canEdit ? h('button', { onclick: () => cmd('override', { slideId: sl.id, playerId: a.playerId, correct: !a.correct }) }, a.correct ? 'Не засчитывать' : 'Засчитать') : '')))));
  } else ta.replaceChildren();

  const nx = s.nextSlide;
  $('#next-card').textContent = nx ? `Дальше: ${nx.type === 'info' ? 'инфо' : 'вопрос'} — ${nx.text || '(без текста)'}` : (s.phase === 'final' ? '' : 'Дальше: финал');
  tick();
}

// режим капитанов: галочка у команды и голоса участников
function captainChips(sl) {
  const out = [];
  for (const t of s.teams) {
    const members = s.players.filter((p) => p.teamId === t.id);
    if (!members.length) continue;
    const cap = members.find((p) => p.id === t.captainId);
    let votes = '';
    if (Array.isArray(t.votes) && sl.answerType === 'choice') votes = t.votes.map((n, i) => (n ? `${LETTERS[i]}:${n}` : '')).filter(Boolean).join(' ');
    else if (Array.isArray(t.votes)) votes = t.votes.slice(0, 3).map((v) => `«${v.text}» ${v.count}`).join(', ');
    out.push(h('span', { class: 'chip' + (t.answered ? ' yes' : '') }, (t.answered ? '✓ ' : '… ') + t.name, cap ? h('span', { class: 'muted' }, ` 👑 ${cap.name}`) : '', votes ? h('span', { class: 'muted' }, ` · голоса ${votes}`) : ''));
  }
  for (const p of s.players.filter((x) => !x.teamId)) out.push(h('span', { class: 'chip' + (p.answered ? ' yes' : '') + (p.connected ? '' : ' off') }, (p.answered ? '✓ ' : '… ') + p.name));
  return out;
}

$('#prev').addEventListener('click', () => nav('prev'));
$('#next').addEventListener('click', () => nav('next'));
$('#close').addEventListener('click', () => nav('closeAnswers'));
$('#reveal').addEventListener('click', () => nav('reveal'));
$('#scores').addEventListener('click', () => nav('showScores'));
$('#finish').addEventListener('click', () => confirm('Показать финал?') && nav('finish'));
$('#jump').addEventListener('change', (e) => { if (e.target.value !== '') nav('goTo', { index: Number(e.target.value) }); e.target.value = ''; });
document.querySelectorAll('#video-ctl button').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.v;
  if (v === 'back') cmd('video', { action: 'seek', t: -5 });
  else if (v === 'fwd') cmd('video', { action: 'seek', t: 5 });
  else cmd('video', { action: v });
}));

document.addEventListener('keydown', (e) => {
  if (!s || s.noGame || e.target.closest('input, textarea, select') || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); $('#primary').click(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); if (!$('#prev').disabled) nav('prev'); }
});

function tick() {
  const el = $('#timer');
  if (!s || s.phase !== 'question' || !deadlineAt) { el.textContent = ''; return; }
  el.textContent = `⏱ ${Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000))}`;
}
setInterval(tick, 250);

// ---------- очки ----------
function scoreRow(x, target) {
  const q = (d) => h('button', { type: 'button', onclick: () => cmd('adjust', { target, id: x.id, delta: d }) }, d > 0 ? `+${d}` : d);
  return h('div', { class: 'srow' + (target === 'team' ? ' team' : '') },
    h('div', { class: 'top-line' }, h('span', { class: 'nm' }, x.name), h('span', { class: 'sc' }, x.score)),
    h('div', { class: 'qb' }, q(-10), q(10), q(50), q(100)));
}

function renderScore() {
  const sb = s.scoreboard;
  const teams = s.mode === 'teams';
  const rows = [];
  if (teams && sb.teams.length) {
    rows.push(h('div', { class: 'sub' }, 'Команды'), ...sb.teams.map((t) => scoreRow(t, 'team')), h('div', { class: 'sub' }, 'Игроки'));
  }
  rows.push(...sb.players.map((p) => scoreRow(p, 'player')));
  if (!sb.players.length && !sb.teams.length) rows.push(h('div', { class: 'muted small' }, 'Пока пусто'));
  $('#score-list').replaceChildren(...rows);

  const sel = $('#adj-target');
  const prev = sel.value;
  const opts = [];
  if (teams) for (const t of sb.teams) opts.push(h('option', { value: `team:${t.id}` }, `Команда: ${t.name}`));
  for (const p of sb.players) opts.push(h('option', { value: `player:${p.id}` }, p.name));
  sel.replaceChildren(...opts);
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;

  $('#history').replaceChildren(...s.adjustments.slice().reverse().slice(0, 30).map((a) =>
    h('div', {}, `${a.delta > 0 ? '+' : ''}${a.delta} — ${a.target === 'team' ? 'команда ' : ''}${a.name}${a.note ? ` (${a.note})` : ''}`)));
}

$('#adjust').addEventListener('submit', async (e) => {
  e.preventDefault();
  const [target, id] = $('#adj-target').value.split(':');
  if (!id) return toast('Выберите, кому');
  const delta = Number($('#adj-delta').value);
  const r = await cmd('adjust', { target, id, delta, note: $('#adj-note').value });
  if (r?.ok) { $('#adj-delta').value = ''; $('#adj-note').value = ''; }
});

// ---------- общий рендер ----------
function render() {
  const addr = $('#addr-select');
  const urls = (s.addresses ?? []).map((a) => ({ url: `http://${a.address}:${location.port || 80}`, label: `${a.address} (${a.name})` }));
  if (s.baseUrl && !urls.some((u) => u.url === s.baseUrl)) urls.unshift({ url: s.baseUrl, label: s.baseUrl.replace('http://', '') });
  addr.replaceChildren(...urls.map((u) => h('option', { value: u.url }, u.label)));
  addr.value = s.baseUrl;

  $('#resume').classList.toggle('hidden', !s.hasSavedGame);
  $('#nogame').classList.toggle('hidden', !s.noGame);
  $('#main').classList.toggle('hidden', Boolean(s.noGame));
  if (s.noGame) return;
  if ($('#quiz-select').value !== s.quizName && [...$('#quiz-select').options].some((o) => o.value === s.quizName)) $('#quiz-select').value = s.quizName;
  renderPeople();
  renderGame();
  renderScore();
}

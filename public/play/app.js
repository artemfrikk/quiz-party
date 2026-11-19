import { connect, emit } from '/shared/socket.js';
import { h, $, storage, LETTERS } from '/shared/dom.js';

const socket = connect();
const app = $('#app');
const bar = $('#bar');

let playerId = storage('quiz.playerId');
let savedName = storage('quiz.name') || '';
let state = null;
let bodyKey = '';
let joining = false;
let deadlineAt = null;

function setId(id) {
  playerId = id;
  storage('quiz.playerId', id ?? null);
}

async function join(name) {
  if (joining) return;
  joining = true;
  const r = await emit(socket, 'player:join', { playerId, name });
  joining = false;
  if (r?.ok) { setId(r.playerId); return null; }
  if (r?.error === 'EmptyName') { setId(null); return 'Введите имя'; }
  if (r?.error === 'NoGame') return 'Ведущий ещё не выбрал квиз. Подождите немного.';
  return 'Не получилось войти, попробуйте ещё раз';
}

socket.on('connect', () => {
  $('#offline').classList.add('hidden');
  if (playerId) join(savedName);
  else socket.emit('player:watch');
});
socket.on('disconnect', () => $('#offline').classList.remove('hidden'));
socket.on('removed', () => { setId(null); savedName = ''; storage('quiz.name', null); bodyKey = ''; render({ needJoin: true }); });
socket.on('state', (s) => render(s));

function render(s) {
  state = s;
  deadlineAt = s.remainingMs != null ? Date.now() + s.remainingMs : null;
  if (s.needJoin || !s.me) {
    bar.classList.add('hidden');
    // если имя уже вводили, а игра появилась — входим сами
    if (!s.noGame && savedName && !joining) join(savedName);
    if (bodyKey !== 'join') { bodyKey = 'join'; app.replaceChildren(joinForm(s.noGame)); }
    return;
  }
  renderBar(s);
  const key = [s.phase, s.index, s.myAnswer !== null, s.result?.correct, s.result?.points, s.captainMode, s.me.isCaptain].join('|');
  if (key !== bodyKey) {
    bodyKey = key;
    app.replaceChildren(...body(s).filter(Boolean));
  }
  updateLive(s);
  tick();
}

function joinForm(noGame) {
  const input = h('input', { name: 'name', placeholder: 'Ваше имя', maxlength: 40, autocomplete: 'nickname', value: savedName, required: true });
  const err = h('div', { class: 'err' }, noGame && savedName ? 'Ведущий ещё не выбрал квиз. Подождите немного.' : '');
  const form = h('form', { class: 'join', onsubmit: async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) { err.textContent = 'Введите имя'; return; }
    savedName = name;
    storage('quiz.name', name);
    err.textContent = '';
    const msg = await join(name);
    if (msg) err.textContent = msg;
  } },
    h('div', { class: 'emoji', style: { textAlign: 'center' } }, '🎉'),
    h('h1', {}, 'Квиз'),
    input,
    h('button', { class: 'primary', type: 'submit' }, 'Войти'),
    err,
  );
  setTimeout(() => input.focus(), 50);
  return form;
}

function renderBar(s) {
  bar.classList.remove('hidden');
  const me = s.me;
  const teamLine = me.teamName ? `${me.teamName}: ${me.teamScore} очк., ${me.teamPlace} место` : (s.mode === 'teams' ? 'Ждём распределения по командам' : '');
  // в режиме капитанов личных очков нет — показываем командные
  const asTeam = s.captainMode && me.teamName;
  bar.replaceChildren(
    h('div', { class: 'who' }, h('div', { class: 'name' }, me.isCaptain ? '👑 ' : '', me.name), teamLine && h('div', { class: 'team' }, asTeam ? me.teamName : teamLine)),
    asTeam
      ? h('div', { class: 'score' }, h('b', {}, me.teamScore), h('small', {}, `${me.teamPlace} место из ${me.teamCount}`))
      : h('div', { class: 'score' }, h('b', {}, me.score), h('small', {}, `${me.place} место из ${me.playerCount}`)),
  );
}

const center = (...c) => h('div', { class: 'center' }, ...c);

function body(s) {
  const sl = s.slide;
  switch (s.phase) {
    case 'lobby':
      return [center(h('div', { class: 'emoji' }, '👋'), h('div', { class: 'big' }, 'Вы в игре!'), h('p', { class: 'muted' }, 'Смотрите на большой экран'))];
    case 'question':
      if (s.myAnswer === null) return answerUi(sl, s);
      return [center(h('div', { class: 'emoji' }, '✅'), h('div', { class: 'big' }, voting(s) ? 'Капитан ответил' : 'Ответ принят'), mine(sl, s.myAnswer), h('p', { class: 'muted' }, 'Ждём остальных…'))];
    case 'closed':
      return [center(h('div', { class: 'emoji' }, '⏳'), h('div', { class: 'big' }, 'Приём ответов закрыт'), s.myAnswer !== null ? mine(sl, s.myAnswer) : h('p', { class: 'muted' }, 'Вы не успели ответить'))];
    case 'reveal': {
      const r = s.result;
      if (!r) return [center(h('p', { class: 'muted' }, 'Смотрите на экран'))];
      return [center(
        h('div', { class: 'result ' + (r.correct ? 'good' : 'bad') },
          h('div', { class: 'emoji' }, r.correct ? '🎯' : r.answered ? '😕' : '💤'),
          h('div', { class: 'big' }, r.correct ? `Верно! +${r.points}` : r.answered ? 'Неверно' : 'Нет ответа'),
          !r.correct && r.correctText && h('p', {}, 'Правильный ответ: ', h('b', {}, r.correctText)),
        ),
      )];
    }
    case 'scores':
      return [center(h('div', { class: 'emoji' }, '📊'), h('div', { class: 'big' }, `${s.me.place} место`), h('p', { class: 'muted' }, `${s.me.score} очков`))];
    case 'final': {
      const place = s.mode === 'teams' && s.me.teamPlace ? s.me.teamPlace : s.me.place;
      return [center(h('div', { class: 'emoji' }, place === 1 ? '🏆' : place <= 3 ? '🥉' : '🎈'), h('div', { class: 'big' }, `Итог: ${place} место`), h('p', { class: 'muted' }, 'Спасибо за игру!'))];
    }
    default:
      return [center(h('div', { class: 'emoji' }, '👀'), h('div', { class: 'big' }, 'Смотрите на экран'))];
  }
}

function mine(sl, value) {
  if (sl?.answerType === 'choice') return h('div', { class: `mine opt opt-${value}` }, `${LETTERS[value]}: ${sl.options[value]}`);
  return h('div', { class: 'mine' }, String(value));
}

const voting = (s) => s.captainMode && s.me.teamName && !s.me.isCaptain;

async function send(value, btns) {
  btns.forEach((b) => (b.disabled = true));
  const r = await emit(socket, 'player:answer', { value });
  if (r?.vote) btns.forEach((b) => (b.disabled = false)); // голос можно поменять
  if (!r?.accepted) {
    btns.forEach((b) => (b.disabled = false));
    if (state?.phase !== 'question') return;
    alert('Ответ не принят — возможно, время вышло');
  }
}

// подсказка над вопросом в режиме капитанов
function roleHint(s) {
  if (!s.captainMode || !s.me.teamName) return null;
  if (s.me.isCaptain) return h('div', { class: 'role-hint captain' }, '👑 Вы капитан: ваш ответ — ответ команды. Рядом видно, за что голосует команда.');
  return h('div', { class: 'role-hint' }, `Отвечает капитан ${s.me.captainName ?? ''}. Голосуйте — капитан видит голоса.`);
}

function answerUi(sl, s) {
  const timer = h('div', { class: 'timer' }, h('i', { id: 'tbar', style: { width: '100%' } }));
  const hint = roleHint(s);
  if (sl.answerType === 'choice') {
    const btns = sl.options.map((o, i) => h('button', { class: `opt-${i}`, 'data-i': i, onclick: () => send(i, btns) }, h('span', { class: 'l' }, LETTERS[i]), h('span', {}, o), h('span', { class: 'votes' })));
    return [timer, hint, h('div', { class: 'q-text' }, sl.text), h('div', { class: 'choices' }, btns)];
  }
  const vote = voting(s);
  const input = h('input', { placeholder: vote ? 'Ваш вариант для капитана' : 'Ваш ответ', maxlength: 200, autocomplete: 'off', enterkeyhint: 'send' });
  const btn = h('button', { class: 'primary', type: 'submit' }, vote ? 'Предложить' : 'Отправить');
  const form = h('form', { class: 'text-answer', onsubmit: (e) => {
    e.preventDefault();
    if (input.value.trim()) send(input.value, [btn, input]);
  } }, input, btn);
  setTimeout(() => input.focus(), 50);
  const live = h('div', { id: 'live-votes', class: 'suggestions' });
  return [timer, hint, h('div', { class: 'q-text' }, sl.text), form, live];
}

// голоса обновляются без перерисовки, чтобы не сбрасывать набранный текст
function updateLive(s) {
  if (s.phase !== 'question' || s.myAnswer !== null) return;
  for (const b of app.querySelectorAll('.choices button')) {
    const i = Number(b.dataset.i);
    b.classList.toggle('voted', s.myVote === i);
    const n = Array.isArray(s.votes) ? s.votes[i] : 0;
    b.querySelector('.votes').textContent = n ? `${n} гол.` : '';
  }
  const live = document.getElementById('live-votes');
  if (!live) return;
  if (voting(s)) {
    live.replaceChildren(s.myVote ? h('p', { class: 'muted' }, 'Ваш вариант: ', h('b', {}, s.myVote), ' (можно изменить)') : '');
  } else if (s.me.isCaptain && s.votes?.length) {
    live.replaceChildren(h('p', { class: 'muted' }, 'Варианты команды (нажмите, чтобы ответить):'),
      ...s.votes.map((v) => h('button', { class: 'suggestion', onclick: (e) => { if (confirm(`Ответить «${v.text}»?`)) send(v.text, [e.currentTarget]); } }, v.text, h('span', { class: 'votes' }, `${v.count} гол.`))));
  } else live.replaceChildren();
}

function tick() {
  const bar = document.getElementById('tbar');
  if (!bar) return;
  const limit = state?.slide?.timeLimit;
  if (!deadlineAt || !limit) { bar.parentElement.classList.add('hidden'); return; }
  const left = Math.max(0, deadlineAt - Date.now());
  bar.style.width = `${(left / (limit * 1000)) * 100}%`;
}
setInterval(tick, 250);

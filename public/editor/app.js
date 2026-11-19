import { h, $, LETTERS, storage } from '/shared/dom.js';
import { createPlayer, youtubeId, mediaUrl } from '/shared/video-player.js';
import { slideErrors } from '/shared/validate.js';

let quizName = null;
let quiz = null;
let sel = -1;
let saveTimer = null;
let player = null;

const ERR = { BadArchive: 'Это не файл квиза', BadName: 'Недопустимое имя: нельзя / \\ : * ? " < > | и точку в начале', Exists: 'Квиз с таким именем уже есть', NotFound: 'Квиз не найден', InUse: 'Этот квиз сейчас загружен в игру на пульте. Загрузите другой квиз и попробуйте снова.', LocalOnly: 'Редактор работает только на этом компьютере' };

function toast(msg, ok = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (ok ? ' ok' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(ERR[data.error] ?? data.error ?? `Ошибка ${r.status}`);
  return data;
}
const qurl = (name) => `/api/quizzes/${encodeURIComponent(name)}`;

// ---------- сохранение ----------
function setSaveState(text, err = false) {
  const el = $('#save-state');
  el.textContent = text;
  el.classList.toggle('err', err);
}

function cleanQuiz(q) {
  return {
    ...q,
    slides: q.slides.map((s) => {
      if (s.type !== 'question') return s;
      const out = { ...s };
      if (s.answerType === 'choice') {
        const opts = [...s.options];
        while (opts.length > 2 && !String(opts[opts.length - 1] ?? '').trim()) opts.pop();
        out.options = opts.map((o) => String(o ?? '').trim());
      }
      out.accepted = (s.accepted ?? []).map((a) => a.trim()).filter(Boolean);
      return out;
    }),
  };
}

function changed() {
  setSaveState('Сохраняю…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
  renderSlideList();
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!quizName) return;
  try {
    await api('PUT', qurl(quizName), cleanQuiz(quiz));
    setSaveState('Сохранено ✓');
  } catch (e) {
    setSaveState('Ошибка сохранения: ' + e.message, true);
  }
}
window.addEventListener('beforeunload', (e) => { if (saveTimer) { saveNow(); e.preventDefault(); } });

// ---------- квизы ----------
async function loadList() {
  const list = await api('GET', '/api/quizzes');
  $('#quiz-list').replaceChildren(...list.map((q) => h('div', { class: 'item' + (q.name === quizName ? ' on' : ''), onclick: () => openQuiz(q.name) },
    h('span', { class: 'txt' }, q.name), h('span', { class: 'tag' }, q.slideCount))));
  if (!list.length) $('#quiz-list').replaceChildren(h('div', { class: 'muted' }, 'Пока нет квизов'));
}

async function openQuiz(name) {
  if (saveTimer) await saveNow();
  try {
    quiz = await api('GET', qurl(name));
  } catch (e) { toast(e.message); return; }
  quizName = name;
  storage('editor.quiz', name);
  quiz.slides ??= [];
  sel = quiz.slides.length ? 0 : -1;
  $('#quiz-actions').classList.remove('hidden');
  $('#slide-add').classList.remove('hidden');
  $('#title-wrap').classList.remove('hidden');
  $('#title-input').value = quiz.title ?? name;
  $('#quiz-title').textContent = name;
  setSaveState('');
  await loadList();
  renderSlideList();
  renderForm();
}

$('#title-input').addEventListener('input', (e) => { quiz.title = e.target.value; changed(); });

$('#new-quiz').addEventListener('click', async () => {
  const name = prompt('Название нового квиза');
  if (!name?.trim()) return;
  try {
    const list = await api('GET', '/api/quizzes');
    if (list.some((q) => q.name === name.trim())) throw new Error(ERR.Exists);
    await api('PUT', qurl(name.trim()), { title: name.trim(), slides: [] });
    await openQuiz(name.trim());
  } catch (e) { toast(e.message); }
});
$('#dup-quiz').addEventListener('click', async () => {
  const name = prompt('Название копии', `${quizName} (копия)`);
  if (!name?.trim()) return;
  try { await saveNow(); await api('POST', qurl(quizName) + '/duplicate', { newName: name.trim() }); await openQuiz(name.trim()); toast('Копия создана', true); } catch (e) { toast(e.message); }
});
$('#rename-quiz').addEventListener('click', async () => {
  const name = prompt('Новое название папки квиза', quizName);
  if (!name?.trim() || name.trim() === quizName) return;
  try {
    await saveNow();
    await api('POST', qurl(quizName) + '/rename', { newName: name.trim() });
    await openQuiz(name.trim());
  } catch (e) { toast(e.message); }
});
$('#del-quiz').addEventListener('click', async () => {
  if (!confirm(`Удалить квиз «${quizName}» вместе со всеми картинками и видео? Это нельзя отменить.`)) return;
  try {
    clearTimeout(saveTimer); saveTimer = null;
    await api('DELETE', qurl(quizName));
    quizName = null; quiz = null; sel = -1;
    storage('editor.quiz', null);
    $('#quiz-actions').classList.add('hidden');
    $('#slide-add').classList.add('hidden');
    $('#title-wrap').classList.add('hidden');
    $('#quiz-title').textContent = 'Слайды';
    $('#slide-list').replaceChildren();
    renderForm();
    loadList();
  } catch (e) { toast(e.message); }
});

// ---------- слайды ----------
const uid = () => crypto.randomUUID?.() ?? `s${Date.now()}${Math.random().toString(16).slice(2)}`;

function newQuestion() {
  return { id: uid(), type: 'question', text: '', media: null, answerType: 'choice', options: ['', '', '', ''], correctIndex: 0, accepted: [], numeric: false, points: 100, timeLimit: 30 };
}

let dragFrom = null;
function renderSlideList() {
  if (!quiz) return;
  const items = quiz.slides.map((s, i) => {
    const bad = slideErrors(s).length > 0;
    const icon = s.media?.kind === 'video' ? '🎬 ' : s.media?.kind === 'image' ? '🖼 ' : '';
    const el = h('div', { class: 'item' + (i === sel ? ' on' : '') + (bad ? ' bad' : ''), draggable: 'true', onclick: () => { sel = i; renderSlideList(); renderForm(); } },
      h('span', { class: 'num' }, i + 1),
      h('span', { class: 'txt' }, icon + (s.text?.trim() || '(без текста)')),
      h('span', { class: 'tag' }, s.type === 'info' ? 'инфо' : s.answerType === 'choice' ? 'ABCD' : 'текст'),
      h('span', { class: 'tools' },
        h('button', { title: 'Копия', onclick: (e) => { e.stopPropagation(); quiz.slides.splice(i + 1, 0, { ...structuredClone(s), id: uid() }); sel = i + 1; changed(); renderForm(); } }, '⧉'),
        h('button', { title: 'Удалить', onclick: (e) => { e.stopPropagation(); if (!confirm('Удалить слайд?')) return; quiz.slides.splice(i, 1); sel = Math.min(sel, quiz.slides.length - 1); changed(); renderForm(); } }, '🗑')));
    el.addEventListener('dragstart', () => { dragFrom = i; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => { if (dragFrom !== null) { e.preventDefault(); el.classList.add('drop-before'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-before');
      if (dragFrom === null || dragFrom === i) return;
      const curId = quiz.slides[sel]?.id;
      const [moved] = quiz.slides.splice(dragFrom, 1);
      quiz.slides.splice(dragFrom < i ? i - 1 : i, 0, moved);
      dragFrom = null;
      sel = quiz.slides.findIndex((x) => x.id === curId);
      changed();
    });
    return el;
  });
  if (!items.length) items.push(h('div', { class: 'muted' }, 'Добавьте первый слайд кнопками ниже'));
  $('#slide-list').replaceChildren(...items);
}

$('#add-q').addEventListener('click', () => { quiz.slides.splice(sel + 1, 0, newQuestion()); sel++; changed(); renderForm(); });
$('#add-info').addEventListener('click', () => { quiz.slides.splice(sel + 1, 0, { id: uid(), type: 'info', text: '', media: null }); sel++; changed(); renderForm(); });

// ---------- форма слайда ----------
function dropPlayer() {
  player?.destroy();
  player = null;
}

function renderForm() {
  dropPlayer();
  const form = $('#form');
  const s = quiz?.slides[sel];
  if (!s) { form.replaceChildren(h('div', { class: 'empty muted' }, quiz ? 'Добавьте слайд' : 'Выберите или создайте квиз слева')); return; }
  if (s.type === 'question' && s.answerType === 'choice') while (s.options.length < 4) s.options.push('');

  const errors = h('div', { class: 'errors' });
  const showErrors = () => { errors.replaceChildren(...slideErrors(s).map((e) => h('div', {}, '⚠ ' + e))); };
  const upd = () => { changed(); showErrors(); };

  const parts = [
    h('div', { class: 'seg' },
      h('button', { class: s.type === 'question' ? 'on' : '', onclick: () => { if (s.type !== 'question') { Object.assign(s, { ...newQuestion(), id: s.id, text: s.text, media: s.media }); upd(); renderForm(); } } }, 'Вопрос'),
      h('button', { class: s.type === 'info' ? 'on' : '', onclick: () => { if (s.type !== 'info') { for (const k of ['answerType', 'options', 'correctIndex', 'accepted', 'numeric', 'points', 'timeLimit']) delete s[k]; s.type = 'info'; upd(); renderForm(); } } }, 'Инфо-слайд (без ответа)')),
    h('label', {}, s.type === 'info' ? 'Текст на экране' : 'Вопрос', h('textarea', { maxlength: 500, value: s.text ?? '', oninput: (e) => { s.text = e.target.value; upd(); } })),
    mediaSection(s, upd),
  ];

  if (s.type === 'question') {
    parts.push(h('div', { class: 'fieldset' },
      h('h3', {}, 'Ответ'),
      h('div', { class: 'seg' },
        h('button', { class: s.answerType === 'choice' ? 'on' : '', onclick: () => { s.answerType = 'choice'; if (!s.options?.length) s.options = ['', '', '', '']; s.correctIndex ??= 0; upd(); renderForm(); } }, 'Варианты A–D'),
        h('button', { class: s.answerType === 'text' ? 'on' : '', onclick: () => { s.answerType = 'text'; s.accepted ??= []; upd(); renderForm(); } }, 'Свой ответ текстом')),
      s.answerType === 'choice' ? choiceEditor(s, upd) : textEditor(s, upd),
      h('div', { class: 'inline' },
        h('label', {}, 'Очки', h('input', { type: 'number', min: 0, max: 10000, step: 10, value: s.points ?? 100, oninput: (e) => { s.points = Math.max(0, Math.round(Number(e.target.value) || 0)); upd(); } })),
        h('label', {}, 'Время, сек', h('input', { type: 'number', min: 5, max: 600, value: s.timeLimit ?? 30, disabled: s.timeLimit == null, oninput: (e) => { s.timeLimit = Math.max(5, Math.round(Number(e.target.value) || 30)); upd(); } })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.timeLimit == null, onchange: (e) => { s.timeLimit = e.target.checked ? null : 30; upd(); renderForm(); } }), 'Без таймера')),
      h('div', { class: 'hint' }, 'За правильный ответ — указанные очки плюс до 50% бонуса за скорость (если есть таймер).')));
  }
  parts.push(errors);
  form.replaceChildren(...parts);
  showErrors();
}

function choiceEditor(s, upd) {
  return h('div', { class: 'opts' }, s.options.slice(0, 4).map((o, i) => h('div', { class: `opt-in opt-${i}` },
    h('span', { class: 'l' }, LETTERS[i]),
    h('input', { type: 'text', maxlength: 120, value: o, placeholder: i < 2 ? 'Вариант' : 'Вариант (необязательно)', oninput: (e) => { s.options[i] = e.target.value; upd(); } }),
    h('label', { title: 'Правильный' }, h('input', { type: 'radio', name: 'correct', checked: s.correctIndex === i, onchange: () => { s.correctIndex = i; upd(); } }), '✓'))));
}

function textEditor(s, upd) {
  return h('div', { class: 'fieldset' },
    h('label', {}, 'Правильные ответы — каждый с новой строки', h('textarea', { value: (s.accepted ?? []).join('\n'), placeholder: 'украли\nсворовали', oninput: (e) => { s.accepted = e.target.value.split('\n'); upd(); } })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(s.numeric), onchange: (e) => { s.numeric = e.target.checked; upd(); } }), 'Ответ — число (сравнивать только число: «10 лет» = «десять»)'),
    h('div', { class: 'hint' }, 'Регистр, ё/е, знаки препинания и мелкие опечатки не важны. «10» и «десять» считаются одинаково.'));
}

// ---------- медиа ----------
function mediaSection(s, upd) {
  const box = h('div', { class: 'fieldset' }, h('h3', {}, 'Картинка, гифка или видео'));
  const m = s.media;
  if (!m) {
    const input = h('input', { type: 'file', accept: 'image/*,video/*', class: 'hidden', onchange: (e) => e.target.files[0] && upload(e.target.files[0]) });
    const bar = h('div', { class: 'progress hidden' }, h('i'));
    const drop = h('div', { class: 'drop', onclick: () => input.click() }, 'Перетащите файл сюда или нажмите, чтобы выбрать', h('div', { class: 'hint' }, 'JPG, PNG, GIF, MP4, WebM'));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
    const yt = h('input', { placeholder: 'или ссылка на YouTube', style: { flex: 1 } });
    const addYt = () => {
      if (!youtubeId(yt.value)) return toast('Не похоже на ссылку YouTube');
      s.media = { kind: 'video', source: 'youtube', src: yt.value.trim(), start: 0, pauseAt: null, end: null };
      upd(); renderForm();
    };
    yt.addEventListener('keydown', (e) => { if (e.key === 'Enter') addYt(); });
    box.append(input, drop, bar, h('div', { class: 'inline' }, yt, h('button', { onclick: addYt }, 'Добавить видео')));

    function upload(file) {
      const isVideo = file.type.startsWith('video/');
      if (!isVideo && !file.type.startsWith('image/')) return toast('Нужна картинка или видео');
      const fd = new FormData();
      fd.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', qurl(quizName) + '/media');
      bar.classList.remove('hidden');
      xhr.upload.onprogress = (e) => { bar.firstChild.style.width = `${(e.loaded / e.total) * 100}%`; };
      xhr.onload = () => {
        bar.classList.add('hidden');
        if (xhr.status !== 200) return toast('Не удалось загрузить файл');
        const { src } = JSON.parse(xhr.responseText);
        s.media = isVideo ? { kind: 'video', source: 'file', src, start: 0, pauseAt: null, end: null } : { kind: 'image', src };
        upd(); renderForm();
      };
      xhr.onerror = () => { bar.classList.add('hidden'); toast('Ошибка загрузки'); };
      xhr.send(fd);
    }
    return box;
  }

  const remove = h('button', { class: 'danger', onclick: () => { s.media = null; upd(); renderForm(); } }, 'Убрать медиа');
  if (m.kind === 'image') {
    box.append(h('img', { class: 'preview-img', src: mediaUrl(quizName, m.src), alt: '' }), h('div', { class: 'inline' }, h('span', { class: 'hint' }, m.src.replace('media/', '')), remove));
    return box;
  }

  // видео
  const holder = h('div', { class: 'player' });
  const fmt = (v) => (v == null ? '' : String(v));
  const numIn = (key, ph) => h('input', { type: 'number', min: 0, step: 0.1, value: fmt(m[key]), placeholder: ph, oninput: (e) => { m[key] = e.target.value === '' ? (key === 'start' ? 0 : null) : Math.max(0, Number(e.target.value)); upd(); } });
  const inputs = { start: numIn('start', '0'), pauseAt: numIn('pauseAt', 'нет'), end: numIn('end', 'до конца') };
  const here = (key) => () => {
    if (!player) return toast('Плеер ещё загружается');
    const t = Math.round(player.currentTime() * 10) / 10;
    m[key] = t;
    inputs[key].value = t;
    upd();
  };
  const mark = (key, title, btn) => h('div', { class: 'mark' }, h('span', { class: 'hint' }, title), inputs[key], h('button', { onclick: here(key) }, btn));
  const marks = [mark('start', 'Начало, сек', 'Начало здесь')];
  if (s.type === 'question') marks.push(mark('pauseAt', 'Пауза + вопрос, сек', 'Пауза здесь'));
  marks.push(mark('end', 'Конец, сек', 'Конец здесь'));

  box.append(
    holder,
    h('div', { class: 'hint' }, s.type === 'question'
      ? 'Ролик играет от «начала» до «паузы», замирает, и появляется вопрос. После «Показать ответ» он продолжается до «конца». Найдите момент в плеере и нажмите кнопку.'
      : 'Ролик играет от «начала» до «конца».'),
    h('div', { class: 'marks' }, marks),
    h('div', { class: 'inline' },
      h('button', { onclick: () => player?.playSegment(m.start ?? 0, s.type === 'question' ? (m.pauseAt ?? m.end) : m.end) }, s.type === 'question' ? '▶ Проверить до паузы' : '▶ Проверить'),
      s.type === 'question' && h('button', { onclick: () => player?.playSegment(m.pauseAt ?? 0, m.end) }, '▶ Проверить продолжение'),
      h('span', { class: 'hint' }, m.source === 'youtube' ? `YouTube: ${m.src}` : m.src.replace('media/', '')),
      remove),
  );
  const slideId = s.id;
  setTimeout(async () => {
    try {
      const p = await createPlayer(holder, m, quizName, { controls: true, onError: () => {} });
      if (quiz?.slides[sel]?.id !== slideId || !holder.isConnected) { p.destroy(); return; }
      player = p;
    } catch {
      holder.replaceChildren(h('div', { class: 'hint', style: { padding: '16px' } }, m.source === 'youtube' ? 'Не удалось загрузить YouTube (нет интернета или видео запрещено встраивать). Время можно ввести вручную.' : 'Не удалось открыть видео.'));
    }
  });
  return box;
}

// ---------- старт ----------
loadList().then(() => {
  const last = storage('editor.quiz');
  if (last) openQuiz(last).catch(() => {});
}).catch((e) => toast(e.message));

// ---------- перенос квизов ----------
$('#export-quiz').addEventListener('click', async () => {
  if (!quizName) return;
  await saveNow();
  const a = h('a', { href: qurl(quizName) + '/export', download: `${quizName}.quiz.zip` });
  document.body.append(a);
  a.click();
  a.remove();
});

function importFile(file) {
  if (!/\.zip$/i.test(file.name)) return toast('Нужен файл .quiz.zip');
  const bar = $('#import-progress');
  const fd = new FormData();
  fd.append('file', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/import');
  bar.classList.remove('hidden');
  xhr.upload.onprogress = (e) => { bar.firstChild.style.width = `${(e.loaded / e.total) * 100}%`; };
  xhr.onload = async () => {
    bar.classList.add('hidden');
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* пусто */ }
    if (xhr.status !== 200) return toast(data.error === 'BadArchive' ? 'Это не файл квиза (или он повреждён)' : `Не удалось загрузить: ${data.error ?? xhr.status}`);
    toast(`Квиз «${data.name}» загружен`, true);
    await openQuiz(data.name);
  };
  xhr.onerror = () => { bar.classList.add('hidden'); toast('Ошибка загрузки'); };
  xhr.send(fd);
}
$('#import-quiz').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; });
const qlist = $('#quiz-list');
qlist.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); qlist.classList.add('drop-over'); } });
qlist.addEventListener('dragleave', () => qlist.classList.remove('drop-over'));
qlist.addEventListener('drop', (e) => {
  e.preventDefault();
  qlist.classList.remove('drop-over');
  const f = e.dataTransfer.files[0];
  if (f) importFile(f);
});

// ---------- папка с квизами ----------
async function loadSettings() {
  const st = await api('GET', '/api/settings');
  $('#folder-path').textContent = st.isDefault ? 'Стандартная (рядом с приложением)' : st.quizzesDir;
  $('#folder-path').title = st.quizzesDir;
  $('#folder-default').classList.toggle('hidden', st.isDefault);
  $('#folder-warn').classList.toggle('hidden', !st.warning);
  $('#folder-warn').textContent = st.warning ?? '';
}

async function setFolder(quizzesDir, copyExisting) {
  await saveNow();
  try {
    await api('PUT', '/api/settings', { quizzesDir, copyExisting });
  } catch (e) {
    return toast(e.message === 'BadFolder' ? 'Такой папки нет. Вставьте полный путь к существующей папке.' : e.message);
  }
  quizName = null; quiz = null; sel = -1;
  storage('editor.quiz', null);
  $('#quiz-actions').classList.add('hidden');
  $('#slide-add').classList.add('hidden');
  $('#title-wrap').classList.add('hidden');
  $('#quiz-title').textContent = 'Слайды';
  $('#slide-list').replaceChildren();
  renderForm();
  await Promise.all([loadList(), loadSettings()]);
  toast('Папка с квизами изменена', true);
}

$('#folder-change').addEventListener('click', () => {
  const p = prompt('Вставьте полный путь к папке (например, в Яндекс Диске или iCloud).\n\nWindows: Shift + правый клик по папке → «Копировать как путь».\nMac: правый клик по папке с зажатой Option → «Скопировать путь до…».');
  if (!p?.trim()) return;
  const copy = confirm('Скопировать туда квизы, которых там ещё нет?\n\nОК — скопировать, Отмена — просто переключиться.');
  setFolder(p.trim(), copy);
});
$('#folder-default').addEventListener('click', () => setFolder(null, false));
loadSettings().catch(() => {});

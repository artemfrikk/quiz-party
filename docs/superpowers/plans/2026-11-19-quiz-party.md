# Quiz Party Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Локальное веб-приложение для живых квизов: сервер на ноутбуке ведущего, пульт, экран для проектора, телефоны игроков по QR, редактор квизов с видео-вопросами.

**Architecture:** Node.js-сервер (Express + Socket.IO) хранит всё состояние игры в чистом классе `Game` без сетевого кода; слой сокетов только транслирует команды в `Game` и рассылает каждой роли своё «представление» состояния. Фронтенд — обычные HTML + ES-модули без сборки. Квизы — папки `quizzes/<имя>/quiz.json` + `media/`.

**Tech Stack:** Node.js 24 (ESM), express 4, socket.io 4 (+ socket.io-client для тестов), qrcode, multer; тесты — встроенный `node:test` + `node:assert/strict`; YouTube IFrame Player API на экране.

**Spec:** `docs/superpowers/specs/2026-11-19-quiz-design.md`

## Global Constraints

- Весь интерфейс на русском.
- Работает без интернета (кроме YouTube-слайдов): никаких CDN — socket.io-клиент отдаётся сервером, QR генерируется на сервере.
- Порт по умолчанию `3000`, переопределяется `PORT`.
- Правильный ответ (`correctIndex`, `accepted`) не попадает в данные экрана и телефонов до `reveal`.
- Очки по умолчанию `points = 100`, бонус за скорость до 50% от `points`, `timeLimit` по умолчанию 30 с, `null` = без таймера и без бонуса.
- Запуск для ведущего — только двойной клик по `start.bat`.
- Проект в `W:\ClaudeProject\Ozon\quiz-party` (все пути ниже — относительно этой папки).

## Review Focus

1. Телефон уснул/вкладку перезагрузили → игрок возвращается тем же (`playerId` из localStorage), очки на месте, дубля в списке нет. Тест: Task 3 `rejoin keeps score`.
2. Два игрока ввели одинаковое имя или пустое имя → второе становится «Имя (2)», пустое отклоняется. Тест: Task 3 `duplicate and empty names`.
3. Ответ после закрытия приёма, повторный ответ, ответ на info-слайд → отклоняется. Тест: Task 4 `rejects late and repeated answers`.
4. Имя квиза с `..`, `/`, `\` → отказ; кириллица и пробелы → работают. Тест: Task 5 `rejects unsafe quiz names`.
5. Удалили команду, где были игроки и ручные очки команды → игроки без команды со своими очками, ручные очки команды пропадают, таблица не ломается. Тест: Task 3 `deleteTeam unassigns players`.

---

## File Structure

```
quiz-party/
  package.json            ESM, scripts: start, test
  start.bat               npm install при первом запуске, node server.js, открыть /host
  server.js               точка входа: createServer().listen
  src/answers.js          нормализация, русские числительные, проверка свободного ответа
  src/game.js             класс Game: игроки, команды, ход игры, очки, представления, CSV, toJSON/fromJSON
  src/quizStore.js        список/чтение/запись/дублирование/удаление квизов, безопасные имена
  src/network.js          локальные IPv4-адреса
  src/app.js              createServer({quizzesDir, dataDir, port}): express-роуты + socket.io + таймеры + автосохранение
  public/shared/socket.js     подключение к socket.io (/socket.io/socket.io.esm.min.js)
  public/shared/video-player.js  единый плеер для файла и YouTube
  public/shared/base.css
  public/play/   index.html app.js style.css
  public/screen/ index.html app.js style.css
  public/host/   index.html app.js style.css
  public/editor/ index.html app.js style.css
  quizzes/Пример/quiz.json + media/  демо-квиз
  data/                   game-state.json (в .gitignore)
  tests/*.test.js
```

## Модель квиза (используется всеми задачами)

```json
{
  "title": "Пример",
  "slides": [
    {
      "id": "s1",
      "type": "question",
      "text": "Что сделали с тапком?",
      "media": { "kind": "video", "source": "file", "src": "media/tapok.mp4", "start": 0, "pauseAt": 12.5, "end": null },
      "answerType": "choice",
      "options": ["Съели", "Оседлали", "Украли", "Потеряли"],
      "correctIndex": 2,
      "accepted": [],
      "numeric": false,
      "points": 100,
      "timeLimit": 30
    }
  ]
}
```
`type`: `"info" | "question"`. `media`: `null` | `{kind:"image", src}` | `{kind:"video", source:"file"|"youtube", src, start, pauseAt, end}` (у info-видео `pauseAt: null`). `answerType`: `"choice"` (2–4 `options`, `correctIndex`) | `"text"` (`accepted: string[]`, `numeric: boolean`).

---

### Task 1: Каркас проекта и проверка свободных ответов

**Files:**
- Create: `package.json`, `.gitignore`, `src/answers.js`
- Test: `tests/answers.test.js`

**Interfaces:**
- Produces:
  - `normalize(s: string): string` — нижний регистр, `ё→е`, пунктуация → пробел, схлопнуть пробелы, trim, последовательности русских числительных → цифры.
  - `ruWordsToNumber(words: string[]): number | null` — 0…999 999; `null`, если не все слова — числительные.
  - `extractNumber(s: string): number | null` — первое число в нормализованной строке.
  - `isTextCorrect(answer: string, slide: {accepted: string[], numeric: boolean}): boolean`

- [ ] **Step 1:** `git init`, `package.json` (`"type": "module"`, scripts `"start": "node server.js"`, `"test": "node --test tests/"`), `npm i express@4 socket.io@4 qrcode multer@1` и `npm i -D socket.io-client@4`. `.gitignore`: `node_modules/`, `data/`.

- [ ] **Step 2: Написать падающие тесты** `tests/answers.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, ruWordsToNumber, isTextCorrect } from '../src/answers.js';

const t = (accepted, numeric = false) => ({ accepted, numeric });

test('normalize', () => {
  assert.equal(normalize('  УКРАЛИ!! '), 'украли');
  assert.equal(normalize('Ёлка, «зелёная»'), 'елка зеленая');
  assert.equal(normalize('двадцать пять яблок'), '25 яблок');
});
test('ruWordsToNumber', () => {
  assert.equal(ruWordsToNumber(['десять']), 10);
  assert.equal(ruWordsToNumber(['одна', 'тысяча', 'двести']), 1200);
  assert.equal(ruWordsToNumber(['две', 'тысячи', 'сорок', 'два']), 2042);
  assert.equal(ruWordsToNumber(['ноль']), 0);
  assert.equal(ruWordsToNumber(['кот']), null);
});
test('text answers', () => {
  assert.equal(isTextCorrect('  УКРАЛИ! ', t(['украли'])), true);
  assert.equal(isTextCorrect('своровали', t(['украли', 'своровали'])), true);
  assert.equal(isTextCorrect('Ёлка', t(['елка'])), true);
  assert.equal(isTextCorrect('10', t(['десять'])), true);
  assert.equal(isTextCorrect('десять', t(['10'])), true);
  assert.equal(isTextCorrect('укралли', t(['украли'])), true);          // 1 опечатка, длина ≥5
  assert.equal(isTextCorrect('кот', t(['кит'])), false);               // короткое — без опечаток
  assert.equal(isTextCorrect('достоевскей', t(['достоевский'])), true);
  assert.equal(isTextCorrect('дастаевскей', t(['достоевский'])), true); // 2 опечатки, длина ≥10
  assert.equal(isTextCorrect('11', t(['10'])), false);                 // цифры — без опечаток
  assert.equal(isTextCorrect('10 лет', t(['10'], true)), true);
  assert.equal(isTextCorrect('примерно одиннадцать', t(['10'], true)), false);
  assert.equal(isTextCorrect('', t(['украли'])), false);
});
```

- [ ] **Step 3:** `npm test` → FAIL (модуль не найден).

- [ ] **Step 4: Реализовать `src/answers.js`.** Словари: единицы с родами (`один/одна/одно=1`, `два/две=2`, … `девятнадцать=19`), десятки (`двадцать…девяносто`), сотни (`сто, двести, триста, четыреста, пятьсот…девятьсот`), множитель `тысяча/тысячи/тысяч`. Алгоритм: накапливать `current`, на «тысяч*» `total += (current||1)*1000; current = 0`; итог `total + current`. В `normalize` заменять каждую максимальную подряд идущую группу слов-числительных на число. Порог опечаток (Левенштейн): длина ожидаемого ≥10 → 2, ≥5 → 1, иначе 0; если в ожидаемом есть цифра — 0. `numeric: true` → сравнивать `extractNumber(answer) === extractNumber(expected)`.

- [ ] **Step 5:** `npm test` → PASS.

- [ ] **Step 6: Commit** `feat: answer normalization and checking`.

---

### Task 2: Хранилище квизов

**Files:**
- Create: `src/quizStore.js`, `quizzes/Пример/quiz.json`
- Test: `tests/quizStore.test.js`

**Interfaces:**
- Produces (все асинхронные, `dir` — корень `quizzes/`):
  - `isSafeName(name: string): boolean` — непусто, ≤80 символов, нет `/ \ : * ? " < > |`, не `.`/`..`, не начинается с точки.
  - `listQuizzes(dir): Promise<{name, title, slideCount}[]>`
  - `loadQuiz(dir, name): Promise<Quiz>` — ошибка `NotFound` если нет.
  - `saveQuiz(dir, name, quiz): Promise<void>` — создаёт папку и `media/`, пишет `quiz.json` (2 пробела отступа).
  - `duplicateQuiz(dir, name, newName)`, `deleteQuiz(dir, name)`
  - `mediaDir(dir, name): string`
  - Все функции бросают `Error('BadName')` при `!isSafeName`.

- [ ] **Step 1: Тесты** (во временной папке через `fs.mkdtemp`): `rejects unsafe quiz names` — `isSafeName('..')`, `'a/b'`, `'a\\b'`, `''`, `'.hidden'` → false; `'Новогодний квиз 2026'` → true; `loadQuiz(dir,'../x')` rejects `BadName`. `save/load roundtrip` — сохранённый объект равен загруженному. `list` возвращает `{name, title, slideCount}`. `duplicate` копирует и `media/`. `delete` удаляет папку.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Реализовать `src/quizStore.js` (`fs/promises`, `fs.cp(..., {recursive:true})` для дубликата).
- [ ] **Step 4:** Создать демо-квиз `quizzes/Пример/quiz.json`: info-слайд «Добро пожаловать», choice-вопрос с картинкой-плейсхолдером (без медиа, если картинки нет), text-вопрос «Сколько будет 5+5?» с `accepted:["10"], numeric:true`, YouTube-вопрос с любой публичной ссылкой и `pauseAt`.
- [ ] **Step 5:** `npm test` → PASS. **Commit** `feat: quiz storage`.

---

### Task 3: Game — игроки, команды, ручные очки

**Files:**
- Create: `src/game.js`
- Test: `tests/game.players.test.js`

**Interfaces:**
- Consumes: формат квиза (выше).
- Produces — `export class Game`:
  - `constructor(quiz, quizName)`; поля `players: Map<playerId, {id, name, teamId|null, connected:boolean}>`, `teams: Map<teamId, {id, name}>`, `mode: 'solo'|'teams'`, `adjustments: {target:'player'|'team', id, delta, note, at}[]`.
  - `join({playerId?, name}): {playerId}` — если `playerId` известен: обновить `connected=true`, имя не менять. Иначе новое `id` (`crypto.randomUUID()`), имя trim, пустое → `throw Error('EmptyName')`, совпадение → суффикс ` (2)`, ` (3)`…
  - `setConnected(playerId, bool)`, `renamePlayer(id, name)`, `removePlayer(id)`
  - `setMode('solo'|'teams')`
  - `createTeam(name): teamId`, `renameTeam(id, name)`, `deleteTeam(id)` (игроки → `teamId=null`, ручные правки этой команды удаляются), `assignPlayer(playerId, teamId|null)`
  - `adjustPoints({target, id, delta, note?})` — `delta` любое целое (можно отрицательное), неизвестный id → `throw Error('NotFound')`.
  - `playerScore(id): number` — сумма начисленных за вопросы (Task 4) + ручные правки игрока.
  - `teamScore(id): number` — сумма `playerScore` её игроков + ручные правки команды.

- [ ] **Step 1: Тесты:**
  - `rejoin keeps score`: join → adjustPoints(+50) → join({playerId, name:'Другое'}) возвращает тот же id, `players.size===1`, `playerScore===50`, имя прежнее.
  - `duplicate and empty names`: два `join({name:'Аня'})` → имена `'Аня'`, `'Аня (2)'`; `join({name:'   '})` бросает `EmptyName`.
  - `team score includes members and manual`: два игрока в команде с +10 и +20, команде +5 → `teamScore===35`; перевести игрока с +20 в другую команду → первая `15`.
  - `negative adjustments`: `adjustPoints({target:'team', id, delta:-30})` → `teamScore===-30`.
  - `deleteTeam unassigns players`: удалить команду с игроком (+10) и ручными +100 → игрок `teamId===null`, `playerScore===10`, в `adjustments` нет записей этой команды.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Реализовать перечисленное в `src/game.js`.
- [ ] **Step 4:** `npm test` → PASS. **Commit** `feat: game players, teams, manual points`.

---

### Task 4: Game — ход игры, ответы, очки, представления, сохранение, CSV

**Files:**
- Modify: `src/game.js`
- Test: `tests/game.flow.test.js`

**Interfaces:**
- Consumes: `isTextCorrect` (Task 1), игроки/команды (Task 3).
- Produces — методы `Game`:
  - Поля: `index` (−1 = лобби), `phase: 'lobby'|'slide'|'question'|'closed'|'reveal'|'scores'|'final'`, `questionStartedAt`, `deadline` (ms|null), `answers: {[slideId]: {[playerId]: {value, at, autoCorrect:boolean, override:boolean|null}}}`, `revealed: Set<slideId>`.
  - `goTo(index)`, `next()`, `prev()` → `phase='slide'` (вне диапазона игнор). `next()` с последнего слайда → `finish()`.
  - `startQuestion(now: number)` — только если текущий слайд `question` и фаза `slide`; `phase='question'`, `deadline = timeLimit ? now + timeLimit*1000 : null`.
  - `submitAnswer(playerId, value, now): {accepted:boolean, allAnswered:boolean}` — отклонить, если фаза не `question`, игрок уже ответил, `deadline && now > deadline`, неизвестный игрок. `value` — число 0–3 для choice, строка ≤200 для text. `allAnswered` = ответили все `connected` игроки.
  - `closeAnswers()` (`question → closed`), `reveal()` (`question|closed → reveal`, добавить в `revealed`), `showScores()`, `finish()`.
  - `overrideAnswer(slideId, playerId, correct:boolean)` — только для text, разрешено в `closed`/`reveal`/`scores`.
  - `isCorrect(slideId, playerId): boolean` — `override ?? autoCorrect`.
  - `pointsFor(slideId, playerId): number` — 0, если слайд не в `revealed` или неверно; иначе `points + round(points * 0.5 * max(0, 1 - (at - startedAt) / (timeLimit*1000)))`, без таймера — `points`. Хранить `startedAt` и параметры в `answers` слайда, чтобы пересчёт после ухода со слайда работал.
  - `playerScore` = Σ `pointsFor` + ручные правки (дополнить Task 3).
  - `scoreboard(): {mode, teams:[{id,name,score}], players:[{id,name,teamId,score}], lastDeltas:{[id]:number}}` — сортировка по убыванию.
  - `hostView()` — всё, включая правильный ответ, ответы игроков с `correct`, историю `adjustments`.
  - `screenView()` — текущий слайд **без `correctIndex`/`accepted`** до `reveal`; при `reveal` — `correctIndex`/`accepted` и `distribution: number[]` (для choice); `answeredCount`, `totalCount`, `deadline`, имена игроков/команды, `scoreboard()` в фазах `scores`/`final`.
  - `playerView(playerId)` — имя, команда, свой счёт и место, текущий вопрос без правильного ответа (только `text`, `answerType`, `options`), `myAnswer`, после `reveal` — `{correct, points}`.
  - `toJSON()` / `static fromJSON(data, quiz)` — полный снимок (Map/Set → массивы); после восстановления все игроки `connected=false`.
  - `exportCsv(): string` — разделитель `;`, BOM `\uFEFF` (для Excel), строки: `Игрок;Команда;Слайд;Ответ;Верно;Очки`, затем строки ручных правок `Правка;<имя>;;<note>;;<delta>`, затем итог по игрокам.

- [ ] **Step 1: Тесты** (квиз из 3 слайдов в коде теста: info, choice `points 100 timeLimit 10`, text `accepted:['десять'] timeLimit null`):
  - `scoring with speed bonus`: старт в `t=0`; ответ правильный на `t=0` → после reveal 150; на `t=5000` → 125; неверный → 0; до `reveal` `pointsFor` = 0.
  - `rejects late and repeated answers`: второй ответ того же игрока → `accepted:false`; ответ на `t=10001` → false; ответ в фазе `slide` (info) → false; после `closeAnswers` → false.
  - `allAnswered`: два подключённых игрока, третий `connected=false` → после второго ответа `allAnswered===true`.
  - `screen view hides answer`: в фазе `question` `JSON.stringify(screenView())` не содержит `correctIndex` и `accepted`; `playerView` тоже; после `reveal` `screenView().slide.correctIndex===1` и `distribution` правильной длины.
  - `override text answer`: ответ `'не знаю'` → `isCorrect===false`; после `reveal` и `overrideAnswer(slideId, playerId, true)` → `pointsFor===100` (без таймера — без бонуса), `playerScore` вырос на 100; `overrideAnswer(..., false)` возвращает 0.
  - `snapshot roundtrip`: после пары ответов и правок `Game.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), quiz)` даёт те же `scoreboard()`.
  - `csv`: начинается с `\uFEFF`, содержит имя игрока и строку правки.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Реализовать методы.
- [ ] **Step 4:** `npm test` → PASS (вместе с Task 3). **Commit** `feat: game flow, scoring, views`.

---

### Task 5: Сервер — HTTP, сокеты, QR, автосохранение, запуск

**Files:**
- Create: `src/network.js`, `src/app.js`, `server.js`, `start.bat`
- Test: `tests/app.test.js`

**Interfaces:**
- Consumes: `quizStore` (Task 2), `Game` (Tasks 3–4).
- Produces:
  - `getLanAddresses(): {name, address}[]` — IPv4, не internal; порядок: `192.168.*`, `10.*`, `172.16–31.*`, прочие.
  - `createServer({quizzesDir, dataDir, port}): Promise<{url, close()}>` (port `0` в тестах).
  - HTTP: `GET /` → 302 `/host/`; статика `public/`; `GET /quizzes/:name/media/*`; `GET /api/quizzes`; `GET|PUT|DELETE /api/quizzes/:name` (PUT тело — quiz JSON, лимит 2 МБ); `POST /api/quizzes/:name/duplicate {newName}`; `POST /api/quizzes/:name/media` (multer, поле `file`, лимит 2 ГБ, имя файла: латиница/кириллица/цифры/`-_.`, конфликт → суффикс) → `{src:"media/<file>"}`; `GET /api/qr?text=` → SVG; `GET /api/export.csv`; `GET /api/addresses`. `BadName` → 400, `NotFound` → 404.
  - Socket.IO события. Клиент → сервер:
    - `player:join {playerId?, name}` ack `{ok, playerId?, error?}`; `player:answer {value}` ack `{accepted}`.
    - `screen:hello`; `screen:video {event:'reachedPause'|'error'|'ended'}`.
    - `host:hello`; `host:cmd {type, ...args}` ack `{ok, error?}`; `type` ∈ `loadQuiz{name}`, `resume`, `setBaseUrl{url}`, `setMode{mode}`, `createTeam{name}`, `renameTeam{id,name}`, `deleteTeam{id}`, `assignPlayer{playerId,teamId}`, `renamePlayer{id,name}`, `removePlayer{id}`, `goTo{index}`, `next`, `prev`, `startQuestion`, `closeAnswers`, `reveal`, `showScores`, `finish`, `override{slideId,playerId,correct}`, `adjust{target,id,delta,note}`, `video{action:'play'|'pause'|'seek', t?}`. Неизвестный `type` → `{ok:false, error:'UnknownCommand'}`.
  - Сервер → клиент: `state` (по роли: `hostView()+{baseUrl, addresses, quizName, hasSavedGame, videoError}`, `screenView()+{baseUrl}`, `playerView(id)`); `video {action, t?}` только экрану; `removed` игроку при удалении.
  - Правила: после каждой изменяющей команды — разослать `state` всем и записать `dataDir/game-state.json`. Таймер: при `startQuestion` `setTimeout` до `deadline` → `closeAnswers`. `allAnswered` → `closeAnswers`. `screen:video reachedPause` в фазе `slide` на вопросе → `startQuestion(Date.now())`; `error` → пометить `videoError` для хоста и, если слайд-вопрос, `startQuestion`. Отключение сокета игрока → `setConnected(false)`. На старте, если есть `game-state.json`, `hasSavedGame=true`; `resume` → `Game.fromJSON`.

- [ ] **Step 1: Тест** `tests/app.test.js` (временные папки, маленький квиз в формате из раздела «Модель квиза», `socket.io-client`):
  - `full round`: host `loadQuiz`, два игрока `join`, `goTo(1)`, `startQuestion`, оба отвечают → host получает `phase==='closed'` (автозакрытие); `reveal` → у игрока в `state` `result.correct===true`.
  - `screen never sees answer before reveal`: собирать все `state` экрана до `reveal`, ни в одном нет `correctIndex`.
  - `adjust command`: `adjust {target:'player', id, delta:-7}` → `scoreboard` игрока `-7`.
  - `http`: `GET /api/quizzes` 200 с массивом; `GET /api/quizzes/..%2Fx` → 400; `GET /api/qr?text=http://x` → `content-type` `image/svg+xml`.
  - `resume`: после команд закрыть сервер, поднять снова с тем же `dataDir` → `hasSavedGame===true`, после `resume` счёт тот же.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Реализовать `network.js`, `app.js`; `server.js` вызывает `createServer({quizzesDir:'quizzes', dataDir:'data', port: process.env.PORT||3000})`, печатает адреса. Socket.io-клиент для браузера отдаётся самим socket.io (`/socket.io/socket.io.esm.min.js`).
- [ ] **Step 4:** `start.bat`: `cd /d %~dp0`, если нет `node_modules` → `npm install`, `start "" http://localhost:3000/host/`, `node server.js`, `pause` (окно не закрывается при ошибке).
- [ ] **Step 5:** `npm test` → PASS. Запустить `node server.js`, открыть `http://localhost:3000/api/addresses` → JSON. **Commit** `feat: server, sockets, autosave`.

---

### Task 6: Телефон игрока (`/play`)

**Files:**
- Create: `public/shared/socket.js`, `public/shared/base.css`, `public/play/index.html`, `public/play/app.js`, `public/play/style.css`

**Interfaces:**
- Consumes: события `player:join`, `player:answer`, `state`, `removed` (Task 5); `playerView` (Task 4).
- Produces: `public/shared/socket.js` → `export function connect(): Socket` (импорт `/socket.io/socket.io.esm.min.js`); `base.css` — переменные цветов A/B/C/D: `--a:#e74c3c; --b:#3498db; --c:#f1c40f; --d:#2ecc71`, общий шрифт системный.

- [ ] **Step 1:** Экран ввода имени (одно поле, кнопка «Войти»); `playerId` хранится в `localStorage['quiz.playerId']` (в try/catch); при загрузке, если id есть — автоматический `player:join` с ним. При `removed` — очистить id, показать ввод имени.
- [ ] **Step 2:** Шапка всегда: имя, команда, очки, место. Состояния по `phase`: ожидание («Смотрите на экран»), choice — 4 крупные кнопки 2×2 цвета `--a…--d` с буквой и текстом (кнопок по числу `options`), text — поле + «Отправить» (`maxlength=200`, Enter отправляет), после ответа — «Ответ принят», после `reveal` — «Верно! +N» / «Неверно», `scores`/`final` — своё место.
- [ ] **Step 3:** Ручная проверка: `npm start`, открыть `/play/` в двух вкладках браузера с разными именами (одна — в режиме инкогнито), убедиться, что оба появились в `GET`-состоянии хоста (через Task 7 или лог сервера); перезагрузить вкладку — тот же игрок. На ширине 360 px кнопки помещаются без горизонтальной прокрутки.
- [ ] **Step 4: Commit** `feat: player phone page`.

---

### Task 7: Экран для проектора (`/screen`) и общий видеоплеер

**Files:**
- Create: `public/shared/video-player.js`, `public/screen/index.html`, `public/screen/app.js`, `public/screen/style.css`
- Test: `tests/video-segment.test.js`

**Interfaces:**
- Consumes: `screenView`, события `state`, `video`, `screen:hello`, `screen:video`, `/api/qr`.
- Produces: `public/shared/video-player.js`:
  - `export function createPlayer(container: HTMLElement, media: VideoMedia, baseMediaUrl: string, {onPauseReached, onEnded, onError}): Promise<Player>`
  - `Player`: `playSegment(from: number, to: number|null): void` (остановиться на `to`, вызвать `onPauseReached` или `onEnded` если `to===null` и ролик кончился), `play()`, `pause()`, `seek(t)`, `currentTime(): number`, `destroy()`.
  - `export function shouldStop(current: number, to: number|null): boolean` — `to !== null && current >= to - 0.05` (чистая функция для теста).
  - YouTube: id из `youtu.be/ID`, `watch?v=ID`, `shorts/ID`; `export function youtubeId(url): string|null`. IFrame API грузится один раз; не загрузился за 5 с или `onError` → `onError()`.

- [ ] **Step 1: Тест** `tests/video-segment.test.js` (импортирует только чистые функции): `shouldStop(12.44, 12.5)===true`, `shouldStop(12.3, 12.5)===false`, `shouldStop(99, null)===false`; `youtubeId('https://youtu.be/abc123XYZ_-')==='abc123XYZ_-'`, `watch?v=…&t=5` и `shorts/…` → id, `'https://example.com'` → null. Чистые функции вынести так, чтобы модуль импортировался в Node без `window` (DOM-код только внутри функций).
- [ ] **Step 2:** `npm test` → FAIL; реализовать; → PASS.
- [ ] **Step 3:** Остановка точно на `pauseAt`: опрос `currentTime` через `requestAnimationFrame` (+ `timeupdate` для файлов), при `shouldStop` → `pause()` и `seek(to)`.
- [ ] **Step 4:** Экран: при открытии оверлей «Нажмите, чтобы начать» (разблокирует звук), затем `screen:hello`. Фазы: лобби — большой QR (`/api/qr?text=<baseUrl>/play/`), адрес текстом, имена (сгруппированы по командам в режиме команд); `slide` — текст и медиа на весь экран (видео: `playSegment(start, pauseAt ?? end)`, по `onPauseReached` → `screen:video reachedPause`); `question` — текст, варианты A–D цветными плашками, обратный отсчёт по `deadline`, «Ответили N из M» (видео остаётся замершим кадром на фоне); `reveal` — столбики `distribution`, подсветка правильного, для text — правильный ответ крупно; у видео-вопроса — `playSegment(pauseAt, end)`; `scores` — таблица (команды, ниже топ-3 игроков, `+дельта` за вопрос); `final` — победитель и таблица. Команды `video` с пульта → `play/pause/seek` плеера.
- [ ] **Step 5:** Ручная проверка с демо-квизом: в лобби QR сканируется телефоном в той же сети; видео-вопрос останавливается на `pauseAt` (сверить по секундам) и продолжается после «показать ответ»; без интернета YouTube-слайд показывает вопрос, а хост получает `videoError`.
- [ ] **Step 6: Commit** `feat: projector screen and video player`.

---

### Task 8: Пульт ведущего (`/host`)

**Files:**
- Create: `public/host/index.html`, `public/host/app.js`, `public/host/style.css`

**Interfaces:**
- Consumes: `hostView`, `host:cmd` (все типы из Task 5), `/api/quizzes`, `/api/export.csv`, `/api/addresses`.

- [ ] **Step 1: Старт:** если `hasSavedGame` — плашка «Продолжить прошлую игру?» (`resume`); выбор квиза из списка (`loadQuiz`); выпадающий список адресов (`setBaseUrl`), по умолчанию первый; кнопка «Открыть экран» → `window.open('/screen/', 'quiz-screen', 'popup')` с подсказкой «перетащите на проектор и нажмите F11».
- [ ] **Step 2: Лобби и команды:** переключатель «Каждый сам за себя / Команды» (`setMode`); колонки «Без команды» + по команде; карточки игроков (имя, точка online/offline) перетаскиваются HTML5 drag-and-drop → `assignPlayer`; «+ Команда» (`createTeam`), переименование по двойному клику, удаление с подтверждением; переименование/удаление игрока из меню карточки.
- [ ] **Step 3: Ход игры:** текущий слайд (текст, медиа-превью, **правильный ответ**), следующий слайд мелко; кнопки «Назад», «Старт вопроса» (для вопросов без видео), «Закрыть приём», «Показать ответ», «Таблица», «Дальше», «Финал» — доступность по `phase`; горячие клавиши: `→`/Пробел — следующее логичное действие, `←` — назад. Для видео: play/pause/±5 с (`video`). Таймер и «Ответили N из M»; список игроков с галочками ✓ (ответил) / … (ждём) / серые (offline). Предупреждение при `videoError`.
- [ ] **Step 4: Свободные ответы:** таблица «игрок — ответ — засчитан» с переключателем → `override`.
- [ ] **Step 5: Очки:** боковая панель «Очки» — каждая команда и игрок с текущим счётом, кнопки `−10 / +10 / +50 / +100` и поле «±число» + «Применить» (`adjust`), поле «за что» (необязательно); история правок; кнопка «Скачать результаты (CSV)».
- [ ] **Step 6: Ручная проверка:** полный проход демо-квиза: 2 вкладки-игрока, 2 команды, перетаскивание, видео-вопрос, ответ текстом с опечаткой и ручным засчитыванием, `+50` команде и `−10` игроку отображаются на экране в таблице, CSV открывается в Excel с кириллицей.
- [ ] **Step 7: Commit** `feat: host control panel`.

---

### Task 9: Редактор квизов (`/editor`)

**Files:**
- Create: `public/editor/index.html`, `public/editor/app.js`, `public/editor/style.css`
- Modify: `public/host/index.html` (ссылка «Редактор»)

**Interfaces:**
- Consumes: HTTP API квизов и медиа (Task 5), `createPlayer`, `youtubeId` (Task 7), модель квиза.

- [ ] **Step 1: Список квизов:** создать (имя → `PUT` пустого квиза `{title, slides:[]}`), переименовать (= `duplicate` + `delete`), дублировать, удалить с подтверждением. Невалидное имя → сообщение из ответа 400.
- [ ] **Step 2: Слайды:** список слева с перетаскиванием для порядка, «+ Вопрос» / «+ Инфо», дублировать/удалить слайд. Форма справа: текст; тип ответа choice/text; для choice — 2–4 поля вариантов и радиокнопка «правильный»; для text — список принимаемых ответов (добавить/удалить) и флажок «Ответ — число»; очки (по умолчанию 100); таймер (по умолчанию 30, флажок «без таймера» → `null`). `id` слайда — `crypto.randomUUID()`.
- [ ] **Step 3: Медиа:** перетаскивание файла или выбор → `POST .../media` с прогрессом (XHR `upload.onprogress`); картинка/гифка → `{kind:'image'}`, видео → `{kind:'video', source:'file'}`; поле «Ссылка YouTube» → `{source:'youtube'}` (проверка `youtubeId`). Для видео — плеер `createPlayer` и кнопки «Начало здесь», «Пауза здесь», «Конец здесь» (берут `currentTime()`, округляют до 0.1 с) плюс числовые поля; «Проверить» проигрывает `start → pauseAt`.
- [ ] **Step 4:** Автосохранение: `PUT` через 800 мс после последнего изменения, индикатор «Сохранено/Сохраняю…/Ошибка». Валидация перед сохранением не блокирует, но слайд с ошибкой (нет вариантов, нет правильного, `pauseAt` ≤ `start`) помечается красным.
- [ ] **Step 5: Ручная проверка:** собрать квиз из 4 слайдов (картинка, гифка, видео-файл с паузой, YouTube), перезагрузить страницу — всё на месте; сыграть его через пульт.
- [ ] **Step 6: Commit** `feat: quiz editor`.

---

### Task 10: Финальная проверка

- [ ] **Step 1:** `npm test` → все PASS.
- [ ] **Step 2:** Запуск через двойной клик по `start.bat` на чистой копии (без `node_modules`) — ставит зависимости, открывает пульт.
- [ ] **Step 3:** Проход с реальным телефоном в той же Wi-Fi: QR → имя → ответы; блокировка экрана телефона на 30 с и возврат — тот же игрок с теми же очками; перезапуск сервера посреди игры → «Продолжить прошлую игру» восстанавливает счёт.
- [ ] **Step 4:** Короткий `README.md` на русском: как запустить, как вывести экран на проектор, что делать при вопросе Windows о сети, где лежат квизы. **Commit** `docs: readme`.

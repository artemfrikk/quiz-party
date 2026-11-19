// Проверка слайдов. Используется и редактором (в браузере), и сервером (предупреждения на пульте).

const filled = (v) => String(v ?? '').trim() !== '';

export function slideErrors(s) {
  const e = [];
  const m = s.media;
  if (!filled(s.text) && !m) e.push('Пустой слайд: добавьте текст или медиа');
  if (s.type === 'question') {
    if (s.answerType === 'choice') {
      const opts = s.options ?? [];
      if (opts.filter(filled).length < 2) e.push('Нужно хотя бы 2 варианта');
      if (!filled(opts[s.correctIndex])) e.push('Правильный вариант пустой');
      const last = opts.reduce((acc, o, i) => (filled(o) ? i : acc), -1);
      if (opts.slice(0, last).some((o) => !filled(o))) e.push('Пропущен вариант в середине');
    } else if (!(s.accepted ?? []).some(filled)) e.push('Добавьте хотя бы один правильный ответ');
  }
  if (m?.kind === 'video') {
    if (m.pauseAt != null && m.pauseAt <= (m.start ?? 0)) e.push('Пауза должна быть позже начала');
    if (m.end != null && m.end <= (m.pauseAt ?? m.start ?? 0)) e.push('Конец должен быть позже паузы/начала');
  }
  return e;
}

export function validateQuiz(quiz) {
  return (quiz?.slides ?? [])
    .map((s, index) => ({ index, id: s.id, errors: slideErrors(s) }))
    .filter((x) => x.errors.length);
}

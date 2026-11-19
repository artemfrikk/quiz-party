// Нормализация и проверка свободных ответов.

const UNITS = {
  ноль: 0, нуль: 0,
  один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
};
const TENS = {
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
  шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
};
const HUNDREDS = {
  сто: 100, двести: 200, триста: 300, четыреста: 400, пятьсот: 500,
  шестьсот: 600, семьсот: 700, восемьсот: 800, девятьсот: 900,
};
const THOUSAND = new Set(['тысяча', 'тысячи', 'тысяч', 'тысячу']);

const isNumWord = (w) => w in UNITS || w in TENS || w in HUNDREDS || THOUSAND.has(w);

export function ruWordsToNumber(words) {
  if (!words.length) return null;
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (w in UNITS) current += UNITS[w];
    else if (w in TENS) current += TENS[w];
    else if (w in HUNDREDS) current += HUNDREDS[w];
    else if (THOUSAND.has(w)) { total += (current || 1) * 1000; current = 0; }
    else return null;
  }
  return total + current;
}

export function normalize(s) {
  const base = String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(\d)[\s  ](?=\d{3}(?!\d))/g, '$1') // «1 000» → «1000»
    .replace(/(\d),(\d)/g, '$1.$2') // «1,5» → «1.5»
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ') // точка остаётся только внутри числа
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .trim();
  if (!base) return '';
  const out = [];
  let group = [];
  const flush = () => {
    if (group.length) { out.push(String(ruWordsToNumber(group))); group = []; }
  };
  for (const w of base.split(' ')) {
    if (isNumWord(w)) group.push(w);
    else { flush(); out.push(w); }
  }
  flush();
  return out.join(' ');
}

export function extractNumber(s) {
  const m = normalize(s).match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function allowedTypos(expected) {
  if (/\d/.test(expected)) return 0;
  if (expected.length >= 10) return 2;
  if (expected.length >= 5) return 1;
  return 0;
}

export function isTextCorrect(answer, slide) {
  const a = normalize(answer);
  if (!a) return false;
  const accepted = slide?.accepted ?? [];
  if (slide?.numeric) {
    const n = extractNumber(a);
    return n !== null && accepted.some((x) => extractNumber(x) === n);
  }
  return accepted.some((x) => {
    const e = normalize(x);
    if (!e) return false;
    if (a === e) return true;
    if (/\d/.test(a) && /\d/.test(e)) return false;
    return levenshtein(a, e) <= allowedTypos(e);
  });
}

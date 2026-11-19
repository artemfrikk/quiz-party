// Квизы: папки quizzes/<имя>/quiz.json + media/
import fs from 'node:fs/promises';
import path from 'node:path';

export function isSafeName(name) {
  if (typeof name !== 'string') return false;
  if (!name.trim() || name.length > 80) return false;
  if (name !== name.trim()) return false;
  if (name.startsWith('.') || name.endsWith('.')) return false;
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) return false;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) return false;
  return true;
}

function check(name) {
  if (!isSafeName(name)) throw new Error('BadName');
}

const quizDir = (dir, name) => path.join(dir, name);
export const mediaDir = (dir, name) => { check(name); return path.join(dir, name, 'media'); };

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function listQuizzes(dir) {
  await fs.mkdir(dir, { recursive: true });
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !isSafeName(e.name)) continue;
    try {
      const q = JSON.parse(await fs.readFile(path.join(dir, e.name, 'quiz.json'), 'utf8'));
      out.push({ name: e.name, title: q.title ?? e.name, slideCount: q.slides?.length ?? 0 });
    } catch { /* не квиз */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export async function loadQuiz(dir, name) {
  check(name);
  const file = path.join(quizDir(dir, name), 'quiz.json');
  if (!(await exists(file))) throw new Error('NotFound');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function saveQuiz(dir, name, quiz) {
  check(name);
  await fs.mkdir(mediaDir(dir, name), { recursive: true });
  const file = path.join(quizDir(dir, name), 'quiz.json');
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(quiz, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export async function duplicateQuiz(dir, name, newName) {
  check(name); check(newName);
  if (!(await exists(quizDir(dir, name)))) throw new Error('NotFound');
  if (await exists(quizDir(dir, newName))) throw new Error('Exists');
  await fs.cp(quizDir(dir, name), quizDir(dir, newName), { recursive: true });
}

export async function deleteQuiz(dir, name) {
  check(name);
  if (!(await exists(quizDir(dir, name)))) throw new Error('NotFound');
  await fs.rm(quizDir(dir, name), { recursive: true, force: true });
}

export async function renameQuiz(dir, name, newName) {
  check(name); check(newName);
  if (!(await exists(quizDir(dir, name)))) throw new Error('NotFound');
  if (name.toLowerCase() !== newName.toLowerCase() && (await exists(quizDir(dir, newName)))) throw new Error('Exists');
  await fs.rename(quizDir(dir, name), quizDir(dir, newName));
}

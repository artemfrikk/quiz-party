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
  assert.equal(isTextCorrect('укралли', t(['украли'])), true);
  assert.equal(isTextCorrect('кот', t(['кит'])), false);
  assert.equal(isTextCorrect('достоевскей', t(['достоевский'])), true);
  assert.equal(isTextCorrect('дастоевскей', t(['достоевский'])), true);
  assert.equal(isTextCorrect('11', t(['10'])), false);
  assert.equal(isTextCorrect('10 лет', t(['10'], true)), true);
  assert.equal(isTextCorrect('примерно одиннадцать', t(['10'], true)), false);
  assert.equal(isTextCorrect('', t(['украли'])), false);
});

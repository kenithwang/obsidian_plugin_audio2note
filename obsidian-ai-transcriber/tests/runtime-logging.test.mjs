import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const transcriber = readFileSync(new URL('../src/services/transcriber.ts', import.meta.url), 'utf8');

test('plugin load and audio processing entrypoints are visible in the console', () => {
  assert.match(main, /console\.info\('\[AI Transcriber\] Plugin loaded\.'/);
  assert.match(main, /console\.info\('\[AI Transcriber\] Processing audio blob\.'/);
});

test('Gemini diarization path logs start and speaker discovery completion', () => {
  assert.match(transcriber, /console\.info\('\[AI Transcriber\] Gemini diarization requested\.'/);
  assert.match(transcriber, /console\.info\('\[AI Transcriber\] Gemini speaker discovery complete\.'/);
});

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const types = readFileSync(new URL('../src/settings/types.ts', import.meta.url), 'utf8');
const settingsTab = readFileSync(new URL('../src/settings/settingsTab.ts', import.meta.url), 'utf8');
const transcriber = readFileSync(new URL('../src/services/transcriber.ts', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../src/services/editor.ts', import.meta.url), 'utf8');

test('OpenRouter is exposed as a first-class provider in settings and services', () => {
  assert.match(types, /'openrouter'/);
  assert.match(settingsTab, /addOption\('openrouter', 'OpenRouter'\)/);
  assert.match(transcriber, /settings\.provider === 'openrouter'/);
  assert.match(transcriber, /OPENROUTER_BASE_URL/);
  assert.match(editor, /settings\.provider === 'openrouter'/);
  assert.match(editor, /OPENROUTER_BASE_URL/);
});

test('OpenAI-compatible clients send requests through Obsidian requestUrl', () => {
  assert.match(transcriber, /createObsidianFetch/);
  assert.match(transcriber, /fetch:\s*createObsidianFetch\(requestUrl\)/);
  assert.match(editor, /createObsidianFetch/);
  assert.match(editor, /fetch:\s*createObsidianFetch\(requestUrl\)/);
});

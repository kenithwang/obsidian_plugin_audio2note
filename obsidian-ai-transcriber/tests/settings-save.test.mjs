import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const settingsTab = readFileSync(new URL('../src/settings/settingsTab.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');

test('settings tab uses an explicit save button instead of automatic debounced persistence', () => {
  assert.match(settingsTab, /private markDirty\(\): void/);
  assert.match(settingsTab, /private async handleSaveClick\(\): Promise<void>/);
  assert.match(settingsTab, /setButtonText\('Save Settings'\)/);
  assert.match(settingsTab, /this\.saveButton\.setDisabled\(!this\.hasUnsavedChanges\)/);
  assert.doesNotMatch(settingsTab, /scheduleSave/);
  assert.doesNotMatch(settingsTab, /flushPendingSave/);
});

test('closing the settings tab does not save unsaved draft changes', () => {
  assert.match(settingsTab, /hide\(\): void\s*{\s*this\.draftSettings = null;\s*this\.hasUnsavedChanges = false;\s*this\.saveButton = null;\s*super\.hide\(\);/s);
});

test('settings are persisted and restored through Obsidian plugin data', () => {
  assert.match(main, /const savedData = await this\.loadData\(\)/);
  assert.match(main, /await this\.saveData\(this\.settings\)/);
});

test('Gemini diarization does not require preselected participants', () => {
  assert.match(main, /private shouldUseGeminiDiarization\(\): boolean/);
  assert.match(main, /this\.settings\.transcriber\.provider === 'gemini'/);
  assert.match(main, /this\.settings\.diarization\.mode === 'gemini'/);
  assert.doesNotMatch(main, /participants\.length > 0/);
});

test('speaker confirmation is skipped when there are no candidate participants', () => {
  assert.match(main, /if \(!participants\.length\) {\s*await this\.fileService\.updateText\(rawPath, session\.text\);\s*return session\.text;\s*}/s);
});

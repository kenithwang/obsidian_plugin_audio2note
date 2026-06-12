import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const modal = readFileSync(new URL('../src/ui/SystemPromptTemplateSelectionModal.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const recordModal = readFileSync(new URL('../src/ui/recordModal.ts', import.meta.url), 'utf8');
const transcriber = readFileSync(new URL('../src/services/transcriber.ts', import.meta.url), 'utf8');

test('participant hints are not selected until the user explicitly toggles them on', () => {
  assert.match(modal, /this\.selectedParticipantIds = new Set<string>\(\);/);
  assert.doesNotMatch(modal, /plugin\.settings\.editor\.participants\.map\(participant => participant\.id\)/);
  assert.doesNotMatch(modal, /participants\.push\(participant\);\s*this\.selectedParticipantIds\.add\(participant\.id\);/);
});

test('recorded audio passes known duration into transcription options', () => {
  assert.match(main, /durationSec\?: number/);
  assert.match(recordModal, /durationSec: result\.duration/);
  assert.match(transcriber, /durationSec\?: number/);
});

test('Gemini diarization has a short-audio single-call path before speaker discovery', () => {
  const fastPathIndex = transcriber.indexOf('this.shouldUseGeminiShortFastPath(options)');
  const discoveryIndex = transcriber.indexOf('this.discoverGeminiSpeakers(');
  assert.notEqual(fastPathIndex, -1);
  assert.notEqual(discoveryIndex, -1);
  assert.ok(fastPathIndex < discoveryIndex);
  assert.match(transcriber, /private async transcribeGeminiShortDiarization\(/);
});

test('Gemini diarization reports timing and cleanup is not tied to aborted task signals', () => {
  assert.match(transcriber, /withTiming<.*>\(/s);
  assert.match(transcriber, /durationMs/);
  assert.doesNotMatch(transcriber, /deleteGeminiFile\(genAI, uploadedFullAudio, options\.signal\)/);
  assert.doesNotMatch(transcriber, /deleteGeminiFile\(genAI, uploadedChunk, workerSignal\)/);
});

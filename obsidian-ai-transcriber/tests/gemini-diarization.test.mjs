import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import esbuild from 'esbuild';

async function loadTranscriberService() {
  const outdir = new URL('./.tmp/', import.meta.url).pathname;
  mkdirSync(outdir, { recursive: true });
  const outfile = join(outdir, `transcriber-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await esbuild.build({
    entryPoints: [new URL('../src/services/transcriber.ts', import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['openai', '@google/genai'],
    sourcemap: false,
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

test('Gemini speaker discovery retries malformed JSON before failing the transcription', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = () => {};
  console.info = () => {};
  let attempts = 0;
  let firstGenerateParams;
  try {
    const genAI = {
      models: {
        async generateContent(params) {
          attempts++;
          firstGenerateParams ??= params;
          if (attempts === 1) {
            return {
              text: '{"speakers":[{"id":"SPEAKER_00","voiceDescription":"host"}],"timeline":[{"speakerId":"SPEAKER_00","start":"00:00","end":"00:10"',
              candidates: [{ finishReason: 'MAX_TOKENS' }],
              usageMetadata: { candidatesTokenCount: 8192, totalTokenCount: 9000 },
            };
          }
          return {
            text: JSON.stringify({
              speakers: [{ id: 'SPEAKER_00', voiceDescription: 'host' }],
              timeline: [{ speakerId: 'SPEAKER_00', start: '00:00', end: '00:10' }],
            }),
            candidates: [{ finishReason: 'STOP' }],
          };
        },
      },
    };

    const result = await service.discoverGeminiSpeakers(
      genAI,
      { uri: 'file://audio' },
      'audio/webm',
      { provider: 'gemini', apiKey: 'test-key', model: 'gemini-test' },
      { OBJECT: 'object', ARRAY: 'array', STRING: 'string' },
      {},
    );

    assert.equal(attempts, 2);
    assert.equal(firstGenerateParams.config.maxOutputTokens, 65536);
    assert.deepEqual(result.speakers, [{ id: 'SPEAKER_00', voiceDescription: 'host', candidateName: null }]);
    assert.deepEqual(result.timeline, [{ speakerId: 'SPEAKER_00', startSec: 0, endSec: 10, confidence: 'high' }]);
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
});

test('Gemini 3.5 structured JSON calls use minimal thinking', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();
  const originalInfo = console.info;
  console.info = () => {};
  let firstGenerateParams;
  try {
    const genAI = {
      models: {
        async generateContent(params) {
          firstGenerateParams ??= params;
          return {
            text: JSON.stringify({
              speakers: [{ id: 'SPEAKER_00', voiceDescription: 'host' }],
              timeline: [{ speakerId: 'SPEAKER_00', start: '00:00', end: '00:10' }],
            }),
            candidates: [{ finishReason: 'STOP' }],
          };
        },
      },
    };

    await service.discoverGeminiSpeakers(
      genAI,
      { uri: 'file://audio' },
      'audio/webm',
      { provider: 'gemini', apiKey: 'test-key', model: 'gemini-3.5-flash' },
      { OBJECT: 'object', ARRAY: 'array', STRING: 'string' },
      {},
    );

    assert.deepEqual(firstGenerateParams.config.thinkingConfig, { thinkingLevel: 'minimal' });
  } finally {
    console.info = originalInfo;
  }
});

test('Gemini JSON diagnostics include thinking token usage', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();

  assert.throws(
    () => service.parseJsonResponse(
      '{"segments":[{"speakerId":"SPEAKER_00","start":"00:00","end":"00:01","text":"unfinished',
      'Gemini chunk transcription',
      {
        candidates: [{ finishReason: 'MAX_TOKENS' }],
        usageMetadata: {
          promptTokenCount: 27749,
          candidatesTokenCount: 2606,
          thoughtsTokenCount: 62915,
          totalTokenCount: 93270,
        },
      },
    ),
    error => {
      assert.match(error.message, /finishReason=MAX_TOKENS/);
      assert.match(error.message, /tokens:prompt=27749,candidates=2606,thoughts=62915,total=93270/);
      return true;
    },
  );
});

test('Gemini diarization chunks long recordings into five-minute ranges', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();
  const originalInfo = console.info;
  console.info = () => {};
  let observedMaxDurationSeconds;
  try {
    service.uploadGeminiFile = async () => ({ name: 'files/full', uri: 'file://audio' });
    service.waitForGeminiFileReady = async (_genAI, file) => file;
    service.discoverGeminiSpeakers = async () => ({
      speakers: [{ id: 'SPEAKER_00', voiceDescription: 'host', candidateName: null }],
      timeline: [{ speakerId: 'SPEAKER_00', startSec: 0, endSec: 900, confidence: 'high' }],
    });
    service.preprocessForGeminiWithOffsets = async (_blob, maxDurationSeconds) => {
      observedMaxDurationSeconds = maxDurationSeconds;
      return [];
    };
    service.deleteGeminiFile = async () => {};

    await service.transcribeWithGeminiDiarization(
      new Blob(['audio'], { type: 'audio/webm' }),
      { provider: 'gemini', apiKey: 'test-key', model: 'gemini-3.5-flash' },
      { durationSec: 900 },
    );

    assert.equal(observedMaxDurationSeconds, 5 * 60);
  } finally {
    console.info = originalInfo;
  }
});

test('Gemini diarization can reuse the full uploaded audio for short recordings', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();

  assert.equal(service.shouldUseGeminiShortFastPath({ durationSec: 240 }), true);
  assert.equal(service.shouldUseGeminiShortFastPath({ durationSec: 301 }), false);
  assert.equal(service.shouldUseGeminiShortFastPath({}), false);
});

test('Gemini speaker IDs are rendered as human-friendly labels', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();

  assert.equal(service.getSpeakerDisplayLabel('SPEAKER_00'), 'Speaker 1');
  assert.equal(service.getSpeakerDisplayLabel('SPEAKER_01'), 'Speaker 2');
  assert.equal(service.getSpeakerDisplayLabel('SPEAKER_UNKNOWN'), 'SPEAKER_UNKNOWN');
});

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
    plugins: [
      {
        name: 'stub-obsidian',
        setup(build) {
          build.onResolve({ filter: /^obsidian$/ }, () => ({
            path: 'obsidian',
            namespace: 'obsidian-stub',
          }));
          build.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({
            contents: 'export function requestUrl() { throw new Error("requestUrl is not available in tests"); }',
            loader: 'js',
          }));
        },
      },
    ],
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

test('Gemini chunk transcription splits a chunk after MAX_TOKENS truncates JSON', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = () => {};
  console.info = () => {};
  const sampleRate = 16000;
  const chunkDurationSec = 120;
  const samples = new Float32Array(sampleRate * chunkDurationSec).fill(0.25);
  const chunk = {
    blob: new Blob([service.float32ToWavBuffer(samples, sampleRate)], { type: 'audio/wav' }),
    startSec: 0,
    endSec: chunkDurationSec,
  };
  const uploadLabels = [];
  let generateCalls = 0;

  try {
    service.uploadGeminiFile = async (_genAI, _blob, _mimeType, label) => {
      uploadLabels.push(label);
      return { name: `files/${uploadLabels.length}`, uri: `file://chunk-${uploadLabels.length}` };
    };
    service.waitForGeminiFileReady = async (_genAI, file) => file;
    service.deleteGeminiFile = async () => {};

    const genAI = {
      models: {
        async generateContent() {
          generateCalls++;
          if (generateCalls === 1) {
            return {
              text: '{"segments":[{"speakerId":"SPEAKER_00","start":"00:00","end":"00:01","text":"unfinished',
              candidates: [{ finishReason: 'MAX_TOKENS' }],
              usageMetadata: { candidatesTokenCount: 65521, totalTokenCount: 73656 },
            };
          }
          return {
            text: JSON.stringify({
              segments: [{
                speakerId: 'SPEAKER_00',
                start: '00:00',
                end: '00:01',
                text: generateCalls === 2 ? 'first half' : 'second half',
              }],
            }),
            candidates: [{ finishReason: 'STOP' }],
          };
        },
      },
    };

    const result = await service.transcribeGeminiChunkAdaptive(
      genAI,
      chunk,
      1,
      1,
      {
        speakers: [{ id: 'SPEAKER_00', voiceDescription: 'host', candidateName: null }],
        timeline: [{ speakerId: 'SPEAKER_00', startSec: 0, endSec: chunkDurationSec, confidence: 'high' }],
      },
      { provider: 'gemini', apiKey: 'test-key', model: 'gemini-3.5-flash' },
      { OBJECT: 'object', ARRAY: 'array', STRING: 'string' },
      {},
    );

    assert.equal(generateCalls, 3);
    assert.deepEqual(uploadLabels, ['chunk 1/1', 'chunk 1/1 split 1/2', 'chunk 1/1 split 2/2']);
    assert.deepEqual(result.map(segment => [segment.startSec, segment.endSec, segment.text]), [
      [0, 1, 'first half'],
      [60, 61, 'second half'],
    ]);
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
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

test('Gemini upload finalization failures use the longer retry delay and recover', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  console.info = () => {};
  const delays = [];
  let attempts = 0;

  try {
    service.sleep = async delayMs => delays.push(delayMs);
    const uploaded = await service.uploadGeminiFile(
      {
        files: {
          async upload() {
            attempts++;
            if (attempts === 1) {
              throw new Error('Failed to upload file: Upload status is not finalized.');
            }
            return { name: 'files/recovered', uri: 'file://recovered' };
          },
        },
      },
      new Blob(['audio'], { type: 'audio/webm' }),
      'audio/webm',
      'chunk 2/6',
    );

    assert.deepEqual(uploaded, { name: 'files/recovered', uri: 'file://recovered' });
    assert.equal(attempts, 2);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 2000 && delays[0] <= 2500, `unexpected delay: ${delays[0]}`);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0][1], {
      label: 'Gemini upload chunk 2/6',
      attempt: 1,
      maxAttempts: 3,
      delayMs: delays[0],
      uploadLabel: 'chunk 2/6',
      mimeType: 'audio/webm',
      sizeBytes: 5,
      classification: 'upload_finalization',
    });
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
});

test('exhausted Gemini upload finalization failures include safe actionable diagnostics', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = () => {};
  console.info = () => {};
  const blob = new Blob(['diagnostic-audio'], { type: 'audio/webm' });

  try {
    service.sleep = async () => {};
    await assert.rejects(
      () => service.uploadGeminiFile(
        {
          files: {
            async upload() {
              throw new Error('Failed to upload file: Upload status is not finalized.');
            },
          },
        },
        blob,
        'audio/webm',
        'full audio',
      ),
      error => {
        assert.match(error.message, /full audio/);
        assert.match(error.message, /mimeType=audio\/webm/);
        assert.match(error.message, new RegExp(`sizeBytes=${blob.size}`));
        assert.match(error.message, /attempts=3/);
        assert.match(error.message, /classification=upload_finalization/);
        assert.match(error.message, /Failed to upload file: Upload status is not finalized\./);
        return true;
      },
    );
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
});

test('Gemini uploads propagate aborts without retrying', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = () => {};
  console.info = () => {};
  let attempts = 0;
  let sleeps = 0;

  try {
    service.sleep = async () => { sleeps++; };
    await assert.rejects(
      () => service.uploadGeminiFile(
        {
          files: {
            async upload() {
              attempts++;
              const error = new Error('The operation was aborted.');
              error.name = 'AbortError';
              throw error;
            },
          },
        },
        new Blob(['audio'], { type: 'audio/webm' }),
        'audio/webm',
        'full audio',
      ),
      error => error.name === 'AbortError',
    );
    assert.equal(attempts, 1);
    assert.equal(sleeps, 0);
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
});

test('Gemini diarization transcribes uploaded chunks serially', async () => {
  const { TranscriberService } = await loadTranscriberService();
  const service = new TranscriberService();
  const originalInfo = console.info;
  console.info = () => {};
  let activeChunks = 0;
  let maxActiveChunks = 0;

  try {
    service.uploadGeminiFile = async () => ({ name: 'files/full', uri: 'file://audio' });
    service.waitForGeminiFileReady = async (_genAI, file) => file;
    service.discoverGeminiSpeakers = async () => ({
      speakers: [{ id: 'SPEAKER_00', voiceDescription: 'host', candidateName: null }],
      timeline: [{ speakerId: 'SPEAKER_00', startSec: 0, endSec: 600, confidence: 'high' }],
    });
    service.preprocessForGeminiWithOffsets = async () => [
      { blob: new Blob(['first'], { type: 'audio/wav' }), startSec: 0, endSec: 300 },
      { blob: new Blob(['second'], { type: 'audio/wav' }), startSec: 300, endSec: 600 },
    ];
    service.transcribeGeminiChunkAdaptive = async () => {
      activeChunks++;
      maxActiveChunks = Math.max(maxActiveChunks, activeChunks);
      await new Promise(resolve => setTimeout(resolve, 10));
      activeChunks--;
      return [];
    };
    service.deleteGeminiFile = async () => {};

    await service.transcribeWithGeminiDiarization(
      new Blob(['audio'], { type: 'audio/webm' }),
      { provider: 'gemini', apiKey: 'test-key', model: 'gemini-3.5-flash' },
      { durationSec: 600 },
    );

    assert.equal(maxActiveChunks, 1);
  } finally {
    console.info = originalInfo;
  }
});

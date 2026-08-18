import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import esbuild from 'esbuild';

async function loadObsidianFetch() {
  const outdir = new URL('./.tmp/', import.meta.url).pathname;
  mkdirSync(outdir, { recursive: true });
  const outfile = join(outdir, `obsidian-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await esbuild.build({
    entryPoints: [new URL('../src/services/obsidianFetch.ts', import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    sourcemap: false,
    logLevel: 'silent',
    external: ['obsidian'],
  });
  return import(pathToFileURL(outfile).href);
}

function textBuffer(value) {
  return new TextEncoder().encode(value).buffer;
}

test('JSON POST is forwarded to requestUrl and returned as a fetch Response', async () => {
  const { createObsidianFetch } = await loadObsidianFetch();
  const calls = [];
  const fetchImpl = createObsidianFetch(async (params) => {
    calls.push(params);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      arrayBuffer: textBuffer('{"id":"chatcmpl-1"}'),
      text: '{"id":"chatcmpl-1"}',
      json: { id: 'chatcmpl-1' },
    };
  });

  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'google/gemini-3.5-flash' }),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].throw, false);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-key');
  assert.match(calls[0].headers['Content-Type'] || calls[0].headers['content-type'] || calls[0].contentType, /application\/json/);
  assert.equal(calls[0].body, JSON.stringify({ model: 'google/gemini-3.5-flash' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'chatcmpl-1' });
});

test('HTTP error status is preserved instead of thrown', async () => {
  const { createObsidianFetch } = await loadObsidianFetch();
  const fetchImpl = createObsidianFetch(async () => ({
    status: 401,
    headers: { 'content-type': 'application/json' },
    arrayBuffer: textBuffer('{"error":{"message":"Invalid API key"}}'),
    text: '{"error":{"message":"Invalid API key"}}',
    json: { error: { message: 'Invalid API key' } },
  }));

  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    body: '{}',
  });

  assert.equal(response.status, 401);
  assert.equal(response.ok, false);
  assert.deepEqual(await response.json(), { error: { message: 'Invalid API key' } });
});

test('FormData is encoded as multipart for requestUrl', async () => {
  const { createObsidianFetch } = await loadObsidianFetch();
  const calls = [];
  const fetchImpl = createObsidianFetch(async (params) => {
    calls.push(params);
    return {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      arrayBuffer: textBuffer('ok'),
      text: 'ok',
      json: null,
    };
  });

  const form = new FormData();
  form.append('model', 'gpt-4o-transcribe');
  form.append('file', new File([new Uint8Array([1, 2, 3, 4])], 'audio.wav', { type: 'audio/wav' }));

  const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    body: form,
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].throw, false);
  const contentType = calls[0].headers['Content-Type'] || calls[0].headers['content-type'] || calls[0].contentType;
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  assert.ok(calls[0].body instanceof ArrayBuffer);
  const encoded = new TextDecoder().decode(calls[0].body);
  assert.match(encoded, /name="model"/);
  assert.match(encoded, /gpt-4o-transcribe/);
  assert.match(encoded, /filename="audio.wav"/);
  assert.match(encoded, /Content-Type: audio\/wav/);
  assert.match(encoded, /\x01\x02\x03\x04/);
});

test('unsafe Electron headers such as content-length are not forwarded to requestUrl', async () => {
  const { createObsidianFetch } = await loadObsidianFetch();
  const calls = [];
  const fetchImpl = createObsidianFetch(async (params) => {
    calls.push(params);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      arrayBuffer: textBuffer('{"ok":true}'),
      text: '{"ok":true}',
      json: { ok: true },
    };
  });

  await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
      'content-length': '1234',
      'Content-Length': '1234',
      Host: 'openrouter.ai',
      Connection: 'keep-alive',
      'User-Agent': 'OpenAI/JS 4.97.0',
      Accept: 'application/json',
    },
    body: JSON.stringify({ model: 'google/gemini-3.5-flash' }),
  });

  assert.equal(calls.length, 1);
  const headerNames = Object.keys(calls[0].headers).map((name) => name.toLowerCase());
  assert.equal(headerNames.includes('content-length'), false);
  assert.equal(headerNames.includes('host'), false);
  assert.equal(headerNames.includes('connection'), false);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-key');
  assert.equal(calls[0].headers.Accept, 'application/json');
  assert.match(calls[0].headers['Content-Type'] || calls[0].headers['content-type'], /application\/json/);
});

test('an already-aborted signal fails before requestUrl is called', async () => {
  const { createObsidianFetch } = await loadObsidianFetch();
  let called = false;
  const fetchImpl = createObsidianFetch(async () => {
    called = true;
    return {
      status: 200,
      headers: {},
      arrayBuffer: textBuffer(''),
      text: '',
      json: null,
    };
  });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => fetchImpl('https://openrouter.ai/api/v1/chat/completions', { signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(called, false);
});

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import esbuild from 'esbuild';

async function loadSpeakerMapping() {
  const outdir = new URL('./.tmp/', import.meta.url).pathname;
  mkdirSync(outdir, { recursive: true });
  const outfile = join(outdir, `speaker-mapping-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await esbuild.build({
    entryPoints: [new URL('../src/services/speakerMapping.ts', import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    sourcemap: false,
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

test('candidate speaker names are mapped to selected participants without manual confirmation', async () => {
  const { createCandidateNameSpeakerMapping } = await loadSpeakerMapping();
  const mapping = createCandidateNameSpeakerMapping(
    [
      { id: 'SPEAKER_00', candidateName: 'Ken Wang' },
      { id: 'SPEAKER_01', candidateName: 'Acme / Jane' },
      { id: 'SPEAKER_02', candidateName: 'Unknown Guest' },
    ],
    [
      { id: 'p1', name: 'Ken Wang', org: '', intro: '' },
      { id: 'p2', name: 'Jane', org: 'Acme', intro: '' },
    ],
  );

  assert.deepEqual(mapping, {
    SPEAKER_00: 'p1',
    SPEAKER_01: 'p2',
  });
});

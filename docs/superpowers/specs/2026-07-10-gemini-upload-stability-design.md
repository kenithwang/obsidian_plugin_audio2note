# Gemini Upload Stability Design

## Goal

Reduce intermittent Gemini Files API upload failures in the Obsidian AI Transcriber while preserving the existing transcription and diarization behavior, and make any remaining failure actionable from the Obsidian notice and developer console.

## Context and confirmed failure chain

The deployed plugin uses Gemini with `gemini-3.5-flash` and Gemini diarization. The diarization flow uploads the complete recording for speaker discovery, then recordings longer than five minutes are converted into five-minute WAV chunks and uploaded again for transcription. Two chunk workers currently run in parallel.

The bundled `@google/genai` uploader divides a Blob into 8 MiB requests. It throws `Failed to upload file: Upload status is not finalized.` when the final response does not contain `x-goog-upload-status: final`. The plugin retries the whole `files.upload()` call three times with short delays, then aborts the transcription task. The current UI surfaces the final exception but does not make the failed upload label, size, classification, and retry history easy to distinguish.

## Considered approaches

### A. Targeted upload hardening (selected)

Keep the existing transcription architecture, serialize Gemini diarization chunk uploads, classify the SDK finalization error, give it a longer jittered retry schedule, and enrich the final error and logs with safe metadata.

This is the smallest change that directly addresses the observed failure mode. It does not change transcript prompts, speaker mapping, output files, or the full-audio discovery behavior.

### B. Dependency upgrade only

Upgrade `@google/genai` from 2.8.0 to the newest release and retain current plugin behavior. This is rejected because the current upstream SDK still contains the same finalization check and unresolved TODO; an upgrade alone does not address the failure.

### C. Redesign long-audio diarization

Avoid the full-audio-plus-chunks upload pattern by reusing one uploaded file for time-range model calls or by persisting chunk checkpoints. This could substantially reduce upload volume, but it changes speaker consistency, recovery semantics, and storage behavior. It is intentionally deferred until the targeted fix has production evidence.

## Design

### Upload retry policy

`TranscriberService` will recognize the two SDK messages that mean upload finalization did not complete:

- `Failed to upload file: Upload status is not finalized.`
- `All content has been uploaded, but the upload status is not finalized.`

These errors will retain three plugin-level upload attempts. After attempts one and two, the delay will be `2000 * 2^(attempt - 1)` milliseconds plus an integer jitter from 0 through 500 milliseconds, producing waits of 2.0-2.5 seconds and 4.0-4.5 seconds. Other retryable errors keep the existing general retry behavior. Abort errors remain non-retryable and immediately stop the task.

The retry helper will accept a delay strategy so production code can select the upload-finalization schedule while tests replace waiting with a deterministic no-op. No API keys, response bodies, audio content, or user context will be logged.

### Concurrency

Gemini diarization chunk transcription will use one worker instead of two. Each chunk still follows the existing upload, readiness polling, transcription, and deletion sequence. Standard OpenAI and OpenRouter concurrency is unchanged. The non-diarization Gemini path is unchanged in this patch.

Serializing only the failing path reduces simultaneous resumable-upload sessions without changing chunk boundaries or transcript ordering.

### Diagnostics and user-facing errors

Every Gemini upload failure will carry:

- upload label, such as `full audio` or `chunk 2/6`;
- MIME type;
- size in bytes;
- attempt count;
- whether the error was classified as upload finalization failure;
- the original SDK message.

The console will receive structured safe metadata on each failed attempt. After the final failed attempt, the thrown error message will contain the label, human-readable size, attempt count, and original message, so the existing Obsidian error notice becomes actionable without exposing secrets.

Successful uploads and transcription output remain unchanged.

## Tests

Tests will exercise `TranscriberService` through the existing bundled-test pattern:

1. A Gemini upload that fails once with the SDK finalization error and then succeeds must retry and return the uploaded file.
2. The special error must select the longer upload-finalization delay policy; the test stubs waiting and asserts the selected delays without sleeping.
3. Exhausted retries must include upload label, size, attempt count, classification, and original SDK message in the final error.
4. Gemini diarization chunk mapping must use one worker, verified with controlled in-flight upload counters.
5. Abort errors must not be retried.

The full test suite, TypeScript check, and production build must pass. The generated `main.js` must be verified against the source build before deployment.

## Deployment and verification

After implementation verification, publish `main.js`, `manifest.json`, and `styles.css` to the synced transfer folder:

`Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/Transcript/`

Verify the remote SHA-256 hashes against the local artifacts. Do not upload directly to the remote `.obsidian/plugins/obsidian-ai-transcriber/` directory because local sync excludes it; publication to `Transcript/` does not by itself prove that the active local plugin was replaced.

Live Gemini API mutation is outside this patch's automated verification because it would upload user data or incur external API usage. Production evidence should be collected from the new structured logs during normal use.

## Non-goals

- Changing Gemini models, prompts, diarization output, speaker mapping, or editor behavior.
- Adding durable on-disk transcription checkpoints.
- Removing the full-audio speaker-discovery upload.
- Changing OpenAI or OpenRouter behavior.
- Logging API keys, audio content, meeting context, participant names, or server response bodies.

# Gemini Upload Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Gemini diarization uploads resilient to the SDK's intermittent non-finalized upload response and expose actionable, secret-safe diagnostics.

**Architecture:** Extend the existing `TranscriberService` retry helper with an error-aware delay selector, keep the behavior local to the shared Gemini upload helper, and serialize only Gemini diarization chunk workers. Preserve all existing transcription prompts and output behavior.

**Tech Stack:** TypeScript 4.7, Node test runner, esbuild, Obsidian plugin runtime, `@google/genai` Files API.

---

### Task 1: Add upload-finalization regression coverage

**Files:**
- Modify: `obsidian-ai-transcriber/tests/gemini-diarization.test.mjs`
- Test: `obsidian-ai-transcriber/tests/gemini-diarization.test.mjs`

- [ ] **Step 1: Write a failing retry-success test**

Add a test that loads `TranscriberService`, replaces `sleep` with a delay collector, and supplies a fake `files.upload()` that throws `Failed to upload file: Upload status is not finalized.` once before returning `{name, uri}`. Assert two attempts, one delay between 2000 and 2500 milliseconds, and the returned file.

- [ ] **Step 2: Write a failing exhausted-retry diagnostics test**

Supply a fake upload that always throws the finalization error. Assert that the final error contains `full audio`, `audio/webm`, the exact Blob byte count, `attempts=3`, `classification=upload_finalization`, and the original SDK message.

- [ ] **Step 3: Write a failing abort test**

Supply an upload that throws an error named `AbortError`. Assert one attempt, zero sleeps, and that the original abort error is propagated.

- [ ] **Step 4: Write a failing serialized-diarization test**

Stub the full-audio upload, readiness, discovery, preprocessing, and chunk transcription boundaries. Run two chunk jobs while tracking active workers and assert the maximum in-flight chunk transcription count is one.

- [ ] **Step 5: Run the focused tests and verify RED**

Run:

```bash
cd obsidian-ai-transcriber
node --test tests/gemini-diarization.test.mjs
```

Expected: the new retry policy, enriched error, and serialized-worker assertions fail against the existing implementation.

### Task 2: Implement error-aware Gemini upload retry

**Files:**
- Modify: `obsidian-ai-transcriber/src/services/transcriber.ts`
- Test: `obsidian-ai-transcriber/tests/gemini-diarization.test.mjs`

- [ ] **Step 1: Extend retry options**

Add this optional selector to `RetryOptions`:

```ts
getRetryDelayMs?: (error: unknown, attempt: number) => number;
```

- [ ] **Step 2: Add finalization classification and delay helpers**

Add private methods with these behaviors:

```ts
private isGeminiUploadFinalizationError(error: unknown): boolean {
  return /(?:Upload status is not finalized|upload status is not finalized)/i
    .test((error as Error)?.message ?? '');
}

private getGeminiUploadRetryDelayMs(error: unknown, attempt: number): number {
  if (!this.isGeminiUploadFinalizationError(error)) {
    return 500 * Math.pow(2, attempt - 1);
  }
  return 2000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 501);
}
```

- [ ] **Step 3: Use the selected delay in `withRetries`**

Replace the fixed sleep calculation with:

```ts
const delayMs = options.getRetryDelayMs?.(error, attempt)
  ?? 500 * Math.pow(2, attempt - 1);
await this.sleep(delayMs, options.signal);
```

- [ ] **Step 4: Enrich `uploadGeminiFile` diagnostics**

Pass `getRetryDelayMs` into the upload's `withRetries` call. Catch its exhausted error and throw a new error in this stable format:

```text
Gemini upload <label> failed (mimeType=<mime>, sizeBytes=<bytes>, attempts=3, classification=<upload_finalization|other>): <original message>
```

Keep `withTiming` structured logs, do not include API keys, audio content, prompts, or server response bodies, and preserve `AbortError` without wrapping it.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
cd obsidian-ai-transcriber
node --test tests/gemini-diarization.test.mjs
```

Expected: all tests in the file pass.

### Task 3: Serialize Gemini diarization chunk uploads

**Files:**
- Modify: `obsidian-ai-transcriber/src/services/transcriber.ts`
- Test: `obsidian-ai-transcriber/tests/gemini-diarization.test.mjs`

- [ ] **Step 1: Change only diarization chunk concurrency**

In `transcribeWithGeminiDiarization`, change the `mapWithConcurrency` worker count for the five-minute chunks from `2` to `1`. Do not change OpenAI, OpenRouter, or standard Gemini concurrency.

- [ ] **Step 2: Run focused tests**

Run:

```bash
cd obsidian-ai-transcriber
node --test tests/gemini-diarization.test.mjs
```

Expected: all tests pass, including maximum in-flight chunk transcription count of one.

### Task 4: Verify and build the complete plugin

**Files:**
- Generated: `obsidian-ai-transcriber/main.js`

- [ ] **Step 1: Run the full test suite**

```bash
cd obsidian-ai-transcriber
npm test
```

Expected: zero failed tests.

- [ ] **Step 2: Run TypeScript checking**

```bash
npx tsc -noEmit -skipLibCheck
```

Expected: exit code 0 and no diagnostics.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```

Expected: exit code 0 and a freshly generated `main.js`.

- [ ] **Step 4: Inspect the scoped diff**

Confirm that source changes are restricted to retry handling and diarization concurrency, tests cover the new behavior, and the generated bundle contains the same change. Preserve all unrelated pre-existing edits.

### Task 5: Publish and verify the plugin build artifacts

**Files:**
- Deploy: `obsidian-ai-transcriber/main.js`
- Deploy: `obsidian-ai-transcriber/manifest.json`
- Deploy: `obsidian-ai-transcriber/styles.css`

- [ ] **Step 1: Copy artifacts to the synced Transcript transfer folder**

```bash
rclone copy obsidian-ai-transcriber/main.js "Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/Transcript/"
rclone copy obsidian-ai-transcriber/manifest.json "Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/Transcript/"
rclone copy obsidian-ai-transcriber/styles.css "Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/Transcript/"
```

- [ ] **Step 2: Verify hashes**

Compute SHA-256 for each local file and for `rclone cat` of each remote file. All three local/remote pairs must match.

- [ ] **Step 3: Report runtime boundary**

State that transfer-folder publication and artifact identity are verified. Do not claim the active local plugin was deployed, because `.obsidian/plugins/` is excluded from local sync. Do not claim a live Gemini upload succeeded because the verification deliberately does not upload user audio or spend external API quota.

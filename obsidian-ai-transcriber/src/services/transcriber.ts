import OpenAI from 'openai';
import { TranscriberSettings } from '../settings/types';

const TARGET_SAMPLE_RATE = 16000;
const SILENCE_THRESHOLD = 0.01;
const SILENCE_WINDOW_SECONDS = 0.3;
const SEARCH_RANGE_SECONDS = 5;
const MIN_CHUNK_SECONDS = 1;
const DEFAULT_TRANSCRIBE_CONCURRENCY = 3;
const GEMINI_FILE_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const DIRECT_GEMINI_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

type TranscriptionStage = 'preprocess' | 'upload' | 'processing' | 'transcribe' | 'done';

export interface TranscriptionProgress {
	provider: 'openai' | 'gemini';
	stage: TranscriptionStage;
	currentChunk?: number;
	totalChunks?: number;
	completedChunks?: number;
}

export interface TranscribeOptions {
	context?: string;
	signal?: AbortSignal;
	onProgress?: (progress: TranscriptionProgress) => void;
}

interface WorkerPreprocessOptions {
	trimLongSilence: boolean;
	minSilenceTrimSamples: number;
	maxDurationSeconds: number;
	targetSampleRate: number;
	silenceThreshold: number;
	silenceWindowSeconds: number;
	searchRangeSeconds: number;
	minChunkSeconds: number;
}

interface RetryOptions {
	label: string;
	signal?: AbortSignal;
	maxRetries?: number;
}

export class TranscriberService {
	private openAIClients = new Map<string, OpenAI>();
	private decodeAudioCtx: AudioContext | null = null;
	private static audioWorkerUrl: string | null = null;

	public async dispose(): Promise<void> {
		if (this.decodeAudioCtx && this.decodeAudioCtx.state !== 'closed') {
			await this.decodeAudioCtx.close();
		}
		this.decodeAudioCtx = null;
	}

	/**
	 * Transcribe audio blob using OpenAI or Gemini API based on settings.
	 * Supports cancellation and progress updates.
	 */
	async transcribe(
		blob: Blob,
		settings: TranscriberSettings,
		contextOrOptions?: string | TranscribeOptions
	): Promise<string> {
		const options = this.normalizeOptions(contextOrOptions);

		if (!settings.apiKey) {
			throw new Error('Transcriber API key is not configured');
		}

		console.info('[AI Transcriber] Transcription requested.', {
			provider: settings.provider,
			model: settings.model,
			mimeType: blob.type || 'unknown',
			sizeBytes: blob.size,
		});

		this.throwIfAborted(options.signal);

		if (settings.provider === 'openai') {
			return this.transcribeWithOpenAI(blob, settings, options);
		}

		if (settings.provider === 'gemini') {
			return this.transcribeWithGemini(blob, settings, options);
		}

		throw new Error(`Unsupported transcription provider: ${settings.provider}`);
	}

	private normalizeOptions(contextOrOptions?: string | TranscribeOptions): TranscribeOptions {
		if (typeof contextOrOptions === 'string') {
			return { context: contextOrOptions };
		}
		return contextOrOptions ?? {};
	}

	private emitProgress(options: TranscribeOptions, progress: TranscriptionProgress): void {
		options.onProgress?.(progress);
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) {
			throw this.createAbortError();
		}
	}

	private createAbortError(): Error {
		try {
			return new DOMException('The operation was aborted.', 'AbortError');
		} catch {
			const err = new Error('The operation was aborted.');
			err.name = 'AbortError';
			return err;
		}
	}

	private isAbortError(error: unknown): boolean {
		return (
			(error as Error)?.name === 'AbortError' ||
			((error as Error)?.message ?? '').toLowerCase().includes('aborted')
		);
	}

	private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (!signal) {
			await new Promise(resolve => setTimeout(resolve, ms));
			return;
		}
		await new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(this.createAbortError());
				return;
			}
			const timer = window.setTimeout(() => {
				signal.removeEventListener('abort', onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				window.clearTimeout(timer);
				signal.removeEventListener('abort', onAbort);
				reject(this.createAbortError());
			};
			signal.addEventListener('abort', onAbort);
		});
	}

	private async withRetries<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
		const maxRetries = options.maxRetries ?? 3;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			this.throwIfAborted(options.signal);
			try {
				return await operation();
			} catch (error) {
				lastError = error;
				if (this.isAbortError(error)) {
					throw error;
				}
				if (attempt >= maxRetries) {
					break;
				}
				console.warn(`[AI Transcriber] ${options.label} failed (attempt ${attempt}/${maxRetries}). Retrying...`, error);
				await this.sleep(500 * Math.pow(2, attempt - 1), options.signal);
			}
		}

		throw new Error(
			`[AI Transcriber] ${options.label} failed after ${maxRetries} attempts: ${
				(lastError as Error)?.message ?? 'Unknown error'
			}`,
		);
	}

	private async mapWithConcurrency<T, R>(
		items: T[],
		concurrency: number,
		signal: AbortSignal | undefined,
		worker: (item: T, index: number, workerSignal?: AbortSignal) => Promise<R>,
	): Promise<R[]> {
		const limitedConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
		const results = new Array<R>(items.length);
		if (!items.length) {
			return results;
		}

		const localAbortController = new AbortController();
		const merged = this.mergeAbortSignals(signal, localAbortController.signal);
		let nextIndex = 0;
		let firstError: unknown;

		const runners = Array.from({ length: limitedConcurrency }, async () => {
			while (true) {
				this.throwIfAborted(merged.signal);
				const index = nextIndex++;
				if (index >= items.length) return;
				try {
					results[index] = await worker(items[index], index, merged.signal);
				} catch (error) {
					if (firstError === undefined) {
						firstError = error;
						localAbortController.abort();
					}
					throw error;
				}
			}
		});

		try {
			await Promise.all(runners);
			return results;
		} catch (error) {
			throw firstError ?? error;
		} finally {
			merged.cleanup();
		}
	}

	private mergeAbortSignals(
		primary?: AbortSignal,
		secondary?: AbortSignal,
	): { signal?: AbortSignal; cleanup: () => void } {
		if (!primary) return { signal: secondary, cleanup: () => {} };
		if (!secondary) return { signal: primary, cleanup: () => {} };

		const mergedController = new AbortController();
		const onAbort = () => {
			if (!mergedController.signal.aborted) {
				mergedController.abort();
			}
		};

		primary.addEventListener('abort', onAbort);
		secondary.addEventListener('abort', onAbort);
		if (primary.aborted || secondary.aborted) {
			mergedController.abort();
		}

		return {
			signal: mergedController.signal,
			cleanup: () => {
				primary.removeEventListener('abort', onAbort);
				secondary.removeEventListener('abort', onAbort);
			},
		};
	}

	private getOpenAIClient(apiKey: string): OpenAI {
		const cached = this.openAIClients.get(apiKey);
		if (cached) return cached;
		const client = new OpenAI({
			apiKey,
			dangerouslyAllowBrowser: true,
		});
		this.openAIClients.set(apiKey, client);
		return client;
	}

	private getDecodeAudioContext(): AudioContext {
		const AudioCtx = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AudioCtx) {
			throw new Error('Web Audio API is not supported in this browser.');
		}
		if (!this.decodeAudioCtx || this.decodeAudioCtx.state === 'closed') {
			this.decodeAudioCtx = new AudioCtx();
		}
		return this.decodeAudioCtx;
	}

	private async transcribeWithOpenAI(
		blob: Blob,
		settings: TranscriberSettings,
		options: TranscribeOptions,
	): Promise<string> {
		const openai = this.getOpenAIClient(settings.apiKey);

		this.emitProgress(options, { provider: 'openai', stage: 'preprocess' });
		const chunks = await this.preprocess(blob, undefined, options);
		console.info('[AI Transcriber] OpenAI preprocess done.', {
			chunks: chunks.length,
			chunkBytes: chunks.map(chunk => chunk.size),
		});

		if (!chunks.length) {
			return '';
		}

		let completedChunks = 0;
		const results = await this.mapWithConcurrency(
			chunks,
			DEFAULT_TRANSCRIBE_CONCURRENCY,
			options.signal,
			async (chunk, index, workerSignal) => {
				this.emitProgress(options, {
					provider: 'openai',
					stage: 'transcribe',
					currentChunk: index + 1,
					totalChunks: chunks.length,
				});

				const transcription = await this.withRetries(
					async () => {
						this.throwIfAborted(workerSignal);
						let prompt = settings.prompt || '';
						if (options.context && options.context.trim()) {
							const contextBlock =
								'【用户提供的会议背景（仅用于提高识别准确性）】\n' +
								options.context.trim() +
								'\n【使用规则】\n- 仅用于人名/组织/术语识别\n- 不要添加音频中未出现的内容';
							prompt = prompt ? `${prompt}\n\n${contextBlock}` : contextBlock;
						}

						return await openai.audio.transcriptions.create(
							{
								file: new File([chunk], 'audio.wav', { type: 'audio/wav' }),
								model: settings.model,
								response_format: 'text',
								...(prompt ? { prompt } : {}),
							},
							{
								signal: workerSignal,
							},
						);
					},
					{
						label: `OpenAI chunk ${index + 1}/${chunks.length}`,
						signal: workerSignal,
					},
				);

				completedChunks++;
				this.emitProgress(options, {
					provider: 'openai',
					stage: 'transcribe',
					currentChunk: index + 1,
					totalChunks: chunks.length,
					completedChunks,
				});
				return transcription;
			},
		);

		const fullText = results.join('\n').trim();
		this.emitProgress(options, { provider: 'openai', stage: 'done', totalChunks: chunks.length, completedChunks });
		console.info('[AI Transcriber] OpenAI transcription complete.', { textLength: fullText.length });
		return fullText;
	}

	private async transcribeWithGemini(
		blob: Blob,
		settings: TranscriberSettings,
		options: TranscribeOptions,
	): Promise<string> {
		const { GoogleGenAI } = await import('@google/genai');
		const genAI = new GoogleGenAI({ apiKey: settings.apiKey });

		const MAX_DURATION_SECONDS = 15 * 60;
		const forceWavPreprocess = settings.preferQualityWav || blob.size > DIRECT_GEMINI_UPLOAD_MAX_BYTES;

		let chunks: Blob[];
		if (forceWavPreprocess) {
			this.emitProgress(options, { provider: 'gemini', stage: 'preprocess' });
			chunks = await this.preprocessForGemini(blob, MAX_DURATION_SECONDS, options);
		} else {
			chunks = [blob];
		}

		console.info('[AI Transcriber] Gemini chunks ready.', {
			chunks: chunks.length,
			chunkBytes: chunks.map(chunk => chunk.size),
			mimeTypes: chunks.map(chunk => chunk.type || 'unknown'),
		});

		if (!chunks.length) {
			return '';
		}

		let completedChunks = 0;
		const results = await this.mapWithConcurrency(
			chunks,
			2,
			options.signal,
			async (chunk, index, workerSignal) => {
				const chunkIndex = index + 1;
				const mimeType = chunk.type || 'audio/webm';
				let uploadedFile: { name?: string; uri?: string; state?: string } | null = null;

				try {
					this.emitProgress(options, {
						provider: 'gemini',
						stage: 'upload',
						currentChunk: chunkIndex,
						totalChunks: chunks.length,
					});

					uploadedFile = await this.withRetries(
						async () => {
							this.throwIfAborted(workerSignal);
							return await genAI.files.upload({
								file: chunk,
								config: {
									mimeType,
									abortSignal: workerSignal,
								},
							});
						},
						{
							label: `Gemini upload chunk ${chunkIndex}/${chunks.length}`,
							signal: workerSignal,
						},
					);

					if (!uploadedFile?.name || !uploadedFile?.uri) {
						throw new Error('Gemini File API upload failed: no file URI returned');
					}

					uploadedFile = await this.waitForGeminiFileReady(genAI, uploadedFile, chunkIndex, chunks.length, {
						...options,
						signal: workerSignal,
					});

					this.emitProgress(options, {
						provider: 'gemini',
						stage: 'transcribe',
						currentChunk: chunkIndex,
						totalChunks: chunks.length,
					});

					const result = await this.withRetries(
						async () => {
							this.throwIfAborted(workerSignal);
							let enhancedPrompt =
								settings.prompt ||
								'You are a professional multilingual transcriber. Your task is to transcribe the audio file VERBATIM (word-for-word) into text.\n\n' +
									'**CRITICAL REQUIREMENTS:**\n' +
									'- **TRANSCRIBE THE ENTIRE AUDIO FROM START TO FINISH.** Do NOT skip, truncate, or omit any part.\n' +
									'- **DO NOT SUMMARIZE.** Every single word must be transcribed.\n' +
									'- **OUTPUT MUST BE IN THE SAME LANGUAGE AS SPOKEN IN THE AUDIO.** NEVER translate to any other language.\n' +
									'- If the audio is long, you MUST continue transcribing until the very end. Never stop early.\n\n' +
									'**GUIDELINES:**\n' +
									'1. **Languages:** The audio may contain **Mandarin Chinese**, **English**, and/or **Japanese**.\n' +
									'   - Transcribe exactly as spoken in the original language.\n' +
									'   - **DO NOT TRANSLATE.**\n' +
									'2. **Speaker Identification:** Identify different speakers. Label them as "**Speaker 1:**", "**Speaker 2:**", etc. Start a new paragraph every time the speaker changes.\n' +
									'3. **Accuracy:** Do not correct grammar. Do not paraphrase. Include every detail, every word, every sentence.\n' +
									'4. **Format:** Output plain text with clear paragraph breaks.\n' +
									'5. **Noise:** Ignore non-speech sounds.\n\n' +
									'Begin transcription now and continue until the audio ends.';

							if (options.context && options.context.trim()) {
								enhancedPrompt +=
									'\n\n【用户提供的会议背景（仅用于提高识别准确性）】\n' +
									options.context.trim() +
									'\n【使用规则】\n- 仅用于人名/组织/术语识别\n- 不要添加音频中未出现的内容';
							}

							const response = await genAI.models.generateContent({
								model: settings.model,
								contents: [
									{
										role: 'user',
										parts: [{ text: enhancedPrompt }, { fileData: { fileUri: uploadedFile!.uri!, mimeType } }],
									},
								],
								config: {
									temperature: settings.temperature,
									maxOutputTokens: 65536,
									abortSignal: workerSignal,
								},
							});

							const text = response.text;
							if (typeof text !== 'string') {
								throw new Error('Gemini transcription error: No text content in response');
							}
							return text;
						},
						{
							label: `Gemini transcription chunk ${chunkIndex}/${chunks.length}`,
							signal: workerSignal,
						},
					);

					completedChunks++;
					this.emitProgress(options, {
						provider: 'gemini',
						stage: 'transcribe',
						currentChunk: chunkIndex,
						totalChunks: chunks.length,
						completedChunks,
					});
					return result;
				} finally {
					if (uploadedFile?.name) {
						try {
							await genAI.files.delete({
								name: uploadedFile.name,
								config: { abortSignal: workerSignal },
							});
						} catch (error) {
							if (!this.isAbortError(error)) {
								console.warn('[AI Transcriber] Failed to delete uploaded Gemini file:', error);
							}
						}
					}
				}
			},
		);

		const fullText = results.join('\n').trim();
		this.emitProgress(options, { provider: 'gemini', stage: 'done', totalChunks: chunks.length, completedChunks });
		console.info('[AI Transcriber] Gemini transcription complete.', { textLength: fullText.length });
		return fullText;
	}

	private async waitForGeminiFileReady(
		genAI: { files: { get: (params: { name: string; config?: { abortSignal?: AbortSignal } }) => Promise<{ name?: string; uri?: string; state?: string }> } },
		initialFile: { name?: string; uri?: string; state?: string },
		currentChunk: number,
		totalChunks: number,
		options: TranscribeOptions,
	): Promise<{ name?: string; uri?: string; state?: string }> {
		let file = initialFile;
		const startedAt = Date.now();

		while (file.state === 'PROCESSING') {
			this.throwIfAborted(options.signal);

			if (Date.now() - startedAt > GEMINI_FILE_PROCESSING_TIMEOUT_MS) {
				throw new Error(`Gemini file processing timeout for chunk ${currentChunk}/${totalChunks}`);
			}

			this.emitProgress(options, {
				provider: 'gemini',
				stage: 'processing',
				currentChunk,
				totalChunks,
			});

			await this.sleep(1000, options.signal);
			file = await genAI.files.get({
				name: file.name!,
				config: { abortSignal: options.signal },
			});
		}

		if (file.state === 'FAILED') {
			throw new Error(`Gemini file processing failed for chunk ${currentChunk}/${totalChunks}`);
		}

		return file;
	}

	/**
	 * Gemini preprocessing: resample, no silence trimming, chunk at silence boundaries.
	 */
	private async preprocessForGemini(
		blob: Blob,
		maxDurationSeconds: number,
		options: TranscribeOptions,
	): Promise<Blob[]> {
		console.info('[AI Transcriber] Gemini preprocess (WAV chunking) start.', { maxDurationSeconds, sizeBytes: blob.size });
		const data = await this.decodeAndResample(blob, options.signal);
		const chunks = await this.processResampledData(data, {
			trimLongSilence: false,
			minSilenceTrimSamples: 0,
			maxDurationSeconds,
			targetSampleRate: TARGET_SAMPLE_RATE,
			silenceThreshold: SILENCE_THRESHOLD,
			silenceWindowSeconds: SILENCE_WINDOW_SECONDS,
			searchRangeSeconds: SEARCH_RANGE_SECONDS,
			minChunkSeconds: MIN_CHUNK_SECONDS,
		}, options);
		console.info('[AI Transcriber] Gemini preprocess done.', { chunks: chunks.length, chunkBytes: chunks.map(chunk => chunk.size) });
		return chunks;
	}

	/**
	 * OpenAI preprocessing: resample, trim silence, chunk at silence boundaries.
	 */
	private async preprocess(
		blob: Blob,
		maxSecsInput: number | undefined,
		options: TranscribeOptions,
	): Promise<Blob[]> {
		const MAX_CHUNK_SECONDS = maxSecsInput ?? 600;
		const MIN_SILENCE_DURATION_SECONDS = 2;
		const MIN_SILENCE_TRIM_SAMPLES = Math.floor(MIN_SILENCE_DURATION_SECONDS * TARGET_SAMPLE_RATE);

		console.info('[AI Transcriber] OpenAI preprocess (WAV chunking) start.', { maxSecsInput, sizeBytes: blob.size });
		const rawData = await this.decodeAndResample(blob, options.signal);
		const chunks = await this.processResampledData(rawData, {
			trimLongSilence: true,
			minSilenceTrimSamples: MIN_SILENCE_TRIM_SAMPLES,
			maxDurationSeconds: MAX_CHUNK_SECONDS,
			targetSampleRate: TARGET_SAMPLE_RATE,
			silenceThreshold: SILENCE_THRESHOLD,
			silenceWindowSeconds: SILENCE_WINDOW_SECONDS,
			searchRangeSeconds: SEARCH_RANGE_SECONDS,
			minChunkSeconds: MIN_CHUNK_SECONDS,
		}, options);
		console.info('[AI Transcriber] OpenAI preprocess done.', { chunks: chunks.length, chunkBytes: chunks.map(chunk => chunk.size) });
		return chunks;
	}

	/**
	 * Decode audio blob and resample to 16kHz mono Float32Array.
	 */
	private async decodeAndResample(blob: Blob, signal?: AbortSignal): Promise<Float32Array> {
		this.throwIfAborted(signal);
		const arrayBuffer = await blob.arrayBuffer();
		this.throwIfAborted(signal);

		const decodeCtx = this.getDecodeAudioContext();
		const originalBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
		this.throwIfAborted(signal);

		const targetLength = Math.ceil(originalBuffer.duration * TARGET_SAMPLE_RATE);
		const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
		const source = offlineCtx.createBufferSource();
		source.buffer = originalBuffer;
		source.connect(offlineCtx.destination);
		source.start();
		const resampled = await offlineCtx.startRendering();
		this.throwIfAborted(signal);
		return new Float32Array(resampled.getChannelData(0));
	}

	private async processResampledData(
		rawData: Float32Array,
		workerOptions: WorkerPreprocessOptions,
		options: TranscribeOptions,
	): Promise<Blob[]> {
		this.throwIfAborted(options.signal);

		if (typeof Worker !== 'undefined') {
			try {
				return await this.processWithWorker(rawData, workerOptions, options);
			} catch (error) {
				if (!this.isAbortError(error)) {
					console.warn('[AI Transcriber] Worker preprocessing failed, falling back to main thread.', error);
				} else {
					throw error;
				}
			}
		}

		return this.processLocally(rawData, workerOptions, options.signal);
	}

	private async processWithWorker(
		rawData: Float32Array,
		options: WorkerPreprocessOptions,
		transcribeOptions: TranscribeOptions,
	): Promise<Blob[]> {
		const workerUrl = this.getAudioWorkerUrl();
		const worker = new Worker(workerUrl);

		return await new Promise<Blob[]>((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				worker.terminate();
				transcribeOptions.signal?.removeEventListener('abort', onAbort);
				fn();
			};

			const onAbort = () => finish(() => reject(this.createAbortError()));

			worker.onmessage = event => {
				const payload = event.data as {
					type: 'progress' | 'result' | 'error';
					chunks?: ArrayBuffer[];
					error?: string;
				};

				if (payload.type === 'error') {
					finish(() => reject(new Error(payload.error || 'Worker preprocessing failed.')));
					return;
				}

				if (payload.type === 'result') {
					const chunks = (payload.chunks || []).map(buffer => new Blob([buffer], { type: 'audio/wav' }));
					finish(() => resolve(chunks));
				}
			};

			worker.onerror = event => {
				finish(() => reject(new Error(event.message || 'Worker preprocessing error.')));
			};

			if (transcribeOptions.signal) {
				transcribeOptions.signal.addEventListener('abort', onAbort);
			}

			const workerInput = rawData.buffer.slice(0);
			worker.postMessage(
				{
					type: 'process',
					data: workerInput,
					options,
				},
				[workerInput],
			);
		});
	}

	private processLocally(
		rawData: Float32Array,
		options: WorkerPreprocessOptions,
		signal?: AbortSignal,
	): Blob[] {
		this.throwIfAborted(signal);
		const data = options.trimLongSilence
			? this.trimSilence(rawData, options.minSilenceTrimSamples, options.silenceThreshold)
			: rawData;
		return this.splitAtSilenceToWav(data, options, signal);
	}

	private getAudioWorkerUrl(): string {
		if (TranscriberService.audioWorkerUrl) {
			return TranscriberService.audioWorkerUrl;
		}

		const workerSource = `
self.onmessage = (event) => {
	const payload = event.data || {};
	if (payload.type !== 'process') return;
	try {
		const options = payload.options;
		const input = new Float32Array(payload.data);
		const data = options.trimLongSilence
			? trimSilence(input, options.minSilenceTrimSamples, options.silenceThreshold)
			: input;
		const chunks = splitAtSilenceToWavBuffers(data, options);
		self.postMessage({ type: 'result', chunks }, chunks);
	} catch (error) {
		const message = (error && error.message) ? error.message : String(error);
		self.postMessage({ type: 'error', error: message });
	}
};

function trimSilence(rawData, minSilenceTrimSamples, silenceThreshold) {
	let samplesToKeep = 0;
	let silentCount = 0;
	for (let i = 0; i < rawData.length; i++) {
		if (Math.abs(rawData[i]) <= silenceThreshold) {
			silentCount++;
		} else {
			if (silentCount > 0 && silentCount < minSilenceTrimSamples) {
				samplesToKeep += silentCount;
			}
			silentCount = 0;
			samplesToKeep++;
		}
	}

	const data = new Float32Array(samplesToKeep);
	let idx = 0;
	silentCount = 0;
	for (let i = 0; i < rawData.length; i++) {
		if (Math.abs(rawData[i]) <= silenceThreshold) {
			silentCount++;
		} else {
			if (silentCount > 0 && silentCount < minSilenceTrimSamples) {
				for (let j = i - silentCount; j < i; j++) {
					data[idx++] = rawData[j];
				}
			}
			silentCount = 0;
			data[idx++] = rawData[i];
		}
	}
	return data;
}

function findSilenceSplitPoint(data, desiredSplit, totalSamples, silenceWindowSamples, searchRangeSamples, silenceThreshold) {
	const backwardStart = Math.max(silenceWindowSamples, desiredSplit - searchRangeSamples);
	for (let i = desiredSplit; i >= backwardStart; i--) {
		let silent = true;
		for (let j = i - silenceWindowSamples; j < i; j++) {
			if (Math.abs(data[j]) > silenceThreshold) {
				silent = false;
				break;
			}
		}
		if (silent) return i - silenceWindowSamples;
	}

	const forwardEnd = Math.min(totalSamples, desiredSplit + searchRangeSamples);
	for (let i = desiredSplit; i < forwardEnd; i++) {
		let silent = true;
		for (let j = i; j < i + silenceWindowSamples && j < totalSamples; j++) {
			if (Math.abs(data[j]) > silenceThreshold) {
				silent = false;
				break;
			}
		}
		if (silent) return i;
	}

	return null;
}

function splitAtSilenceToWavBuffers(data, options) {
	const maxSamples = Math.floor(options.maxDurationSeconds * options.targetSampleRate);
	const minChunkSamples = Math.floor(options.minChunkSeconds * options.targetSampleRate);
	const silenceWindowSamples = Math.floor(options.silenceWindowSeconds * options.targetSampleRate);
	const searchRangeSamples = Math.floor(options.searchRangeSeconds * options.targetSampleRate);
	const chunks = [];

	let startSample = 0;
	const totalSamples = data.length;
	while (startSample < totalSamples) {
		let endSample = Math.min(startSample + maxSamples, totalSamples);

		if (endSample < totalSamples) {
			const splitPoint = findSilenceSplitPoint(
				data,
				endSample,
				totalSamples,
				silenceWindowSamples,
				searchRangeSamples,
				options.silenceThreshold
			);
			if (splitPoint !== null && splitPoint > startSample) {
				endSample = splitPoint;
			}
		}

		const segmentSamples = endSample - startSample;
		if (segmentSamples >= minChunkSamples) {
			const segment = data.subarray(startSample, endSample);
			chunks.push(float32ToWavBuffer(segment, options.targetSampleRate));
		}

		startSample = endSample;
	}

	return chunks;
}

function float32ToWavBuffer(samples, sampleRate) {
	const dataSize = samples.length * 2;
	const wavBuffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(wavBuffer);

	writeString(view, 0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeString(view, 8, 'WAVE');
	writeString(view, 12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeString(view, 36, 'data');
	view.setUint32(40, dataSize, true);

	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const sample = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
		offset += 2;
	}

	return wavBuffer;
}

function writeString(view, offset, value) {
	for (let i = 0; i < value.length; i++) {
		view.setUint8(offset + i, value.charCodeAt(i));
	}
}
`;

		const blob = new Blob([workerSource], { type: 'application/javascript' });
		TranscriberService.audioWorkerUrl = URL.createObjectURL(blob);
		return TranscriberService.audioWorkerUrl;
	}

	private trimSilence(rawData: Float32Array, minSilenceTrimSamples: number, silenceThreshold: number): Float32Array {
		let samplesToKeep = 0;
		let silentCount = 0;
		for (let i = 0; i < rawData.length; i++) {
			if (Math.abs(rawData[i]) <= silenceThreshold) {
				silentCount++;
			} else {
				if (silentCount > 0 && silentCount < minSilenceTrimSamples) {
					samplesToKeep += silentCount;
				}
				silentCount = 0;
				samplesToKeep++;
			}
		}

		const data = new Float32Array(samplesToKeep);
		let idx = 0;
		silentCount = 0;
		for (let i = 0; i < rawData.length; i++) {
			if (Math.abs(rawData[i]) <= silenceThreshold) {
				silentCount++;
			} else {
				if (silentCount > 0 && silentCount < minSilenceTrimSamples) {
					for (let j = i - silentCount; j < i; j++) {
						data[idx++] = rawData[j];
					}
				}
				silentCount = 0;
				data[idx++] = rawData[i];
			}
		}
		return data;
	}

	private findSilenceSplitPoint(
		data: Float32Array,
		desiredSplit: number,
		totalSamples: number,
		silenceWindowSamples: number,
		searchRangeSamples: number,
		silenceThreshold: number,
	): number | null {
		const backwardStart = Math.max(silenceWindowSamples, desiredSplit - searchRangeSamples);
		for (let i = desiredSplit; i >= backwardStart; i--) {
			let silent = true;
			for (let j = i - silenceWindowSamples; j < i; j++) {
				if (Math.abs(data[j]) > silenceThreshold) {
					silent = false;
					break;
				}
			}
			if (silent) return i - silenceWindowSamples;
		}

		const forwardEnd = Math.min(totalSamples, desiredSplit + searchRangeSamples);
		for (let i = desiredSplit; i < forwardEnd; i++) {
			let silent = true;
			for (let j = i; j < i + silenceWindowSamples && j < totalSamples; j++) {
				if (Math.abs(data[j]) > silenceThreshold) {
					silent = false;
					break;
				}
			}
			if (silent) return i;
		}
		return null;
	}

	private splitAtSilenceToWav(
		data: Float32Array,
		options: WorkerPreprocessOptions,
		signal?: AbortSignal,
	): Blob[] {
		const maxSamples = Math.floor(options.maxDurationSeconds * options.targetSampleRate);
		const minChunkSamples = Math.floor(options.minChunkSeconds * options.targetSampleRate);
		const silenceWindowSamples = Math.floor(options.silenceWindowSeconds * options.targetSampleRate);
		const searchRangeSamples = Math.floor(options.searchRangeSeconds * options.targetSampleRate);
		const totalSamples = data.length;
		const chunks: Blob[] = [];

		let startSample = 0;
		while (startSample < totalSamples) {
			this.throwIfAborted(signal);
			let endSample = Math.min(startSample + maxSamples, totalSamples);

			if (endSample < totalSamples) {
				const splitPoint = this.findSilenceSplitPoint(
					data,
					endSample,
					totalSamples,
					silenceWindowSamples,
					searchRangeSamples,
					options.silenceThreshold,
				);
				if (splitPoint !== null && splitPoint > startSample) {
					endSample = splitPoint;
				}
			}

			const segmentSamples = endSample - startSample;
			if (segmentSamples >= minChunkSamples) {
				const wav = this.float32ToWavBuffer(data.subarray(startSample, endSample), options.targetSampleRate);
				chunks.push(new Blob([wav], { type: 'audio/wav' }));
			}

			startSample = endSample;
		}

		return chunks;
	}

	private float32ToWavBuffer(samples: Float32Array, sampleRate: number): ArrayBuffer {
		const dataSize = samples.length * 2;
		const wavBuffer = new ArrayBuffer(44 + dataSize);
		const view = new DataView(wavBuffer);

		this.writeString(view, 0, 'RIFF');
		view.setUint32(4, 36 + dataSize, true);
		this.writeString(view, 8, 'WAVE');
		this.writeString(view, 12, 'fmt ');
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		this.writeString(view, 36, 'data');
		view.setUint32(40, dataSize, true);

		let offset = 44;
		for (let i = 0; i < samples.length; i++) {
			const sample = Math.max(-1, Math.min(1, samples[i]));
			view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
			offset += 2;
		}

		return wavBuffer;
	}

	private writeString(view: DataView, offset: number, value: string): void {
		for (let i = 0; i < value.length; i++) {
			view.setUint8(offset + i, value.charCodeAt(i));
		}
	}
}

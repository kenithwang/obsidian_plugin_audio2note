import OpenAI from 'openai';
import { ApiProvider, TranscriberSettings } from '../settings/types';

const TARGET_SAMPLE_RATE = 16000;
const SILENCE_THRESHOLD = 0.01;
const SILENCE_WINDOW_SECONDS = 0.3;
const SEARCH_RANGE_SECONDS = 5;
const MIN_CHUNK_SECONDS = 1;
const DEFAULT_TRANSCRIBE_CONCURRENCY = 3;
const GEMINI_FILE_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const DIRECT_GEMINI_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const GEMINI_JSON_MAX_OUTPUT_TOKENS = 65536;
const GEMINI_FULL_AUDIO_TRANSCRIPTION_MAX_SECONDS = 5 * 60;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

type TranscriptionStage = 'preprocess' | 'upload' | 'processing' | 'transcribe' | 'done';

export interface TranscriptionProgress {
	provider: ApiProvider;
	stage: TranscriptionStage;
	currentChunk?: number;
	totalChunks?: number;
	completedChunks?: number;
}

export interface TranscribeOptions {
	context?: string;
	durationSec?: number;
	signal?: AbortSignal;
	onProgress?: (progress: TranscriptionProgress) => void;
}

export interface DiarizedTranscriptSegment {
	speakerId: string;
	startSec: number;
	endSec: number;
	text: string;
	confidence?: 'high' | 'medium' | 'low';
}

export interface GeminiDiarizedTranscript {
	speakers: DiscoveredSpeaker[];
	timeline: SpeakerTimelineSegment[];
	segments: DiarizedTranscriptSegment[];
}

export interface DiscoveredSpeaker {
	id: string;
	voiceDescription?: string;
	candidateName?: string | null;
}

export interface SpeakerTimelineSegment {
	speakerId: string;
	startSec: number;
	endSec: number;
	confidence?: 'high' | 'medium' | 'low';
}

interface TimedAudioChunk {
	blob: Blob;
	startSec: number;
	endSec: number;
}

interface GeminiUploadedFile {
	name?: string;
	uri?: string;
	state?: string;
}

interface GeminiGenerateContentResponse {
	text?: string;
	candidates?: Array<{
		finishReason?: string;
		finishMessage?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
	};
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

		if (settings.provider === 'openrouter') {
			return this.transcribeWithOpenRouter(blob, settings, options);
		}

		throw new Error(`Unsupported transcription provider: ${settings.provider}`);
	}

	async transcribeWithGeminiDiarization(
		blob: Blob,
		settings: TranscriberSettings,
		options: TranscribeOptions = {},
	): Promise<GeminiDiarizedTranscript> {
		if (settings.provider !== 'gemini') {
			throw new Error('Gemini diarization requires Gemini as the transcription provider.');
		}
		if (!settings.apiKey) {
			throw new Error('Transcriber API key is not configured');
		}

		const mimeType = blob.type || 'audio/webm';
		console.info('[AI Transcriber] Gemini diarization requested.', {
			model: settings.model,
			mimeType,
			sizeBytes: blob.size,
			hasContext: Boolean(options.context?.trim()),
		});

		const { GoogleGenAI, Type } = await import('@google/genai');
		const genAI = new GoogleGenAI({ apiKey: settings.apiKey });
		let uploadedFullAudio: GeminiUploadedFile | null = null;

			try {
				this.emitProgress(options, { provider: 'gemini', stage: 'upload', currentChunk: 1, totalChunks: 1 });
				uploadedFullAudio = await this.uploadGeminiFile(genAI, blob, mimeType, 'full audio', options.signal);
				uploadedFullAudio = await this.waitForGeminiFileReady(genAI, uploadedFullAudio, 1, 1, options);

				if (this.shouldUseGeminiShortFastPath(options)) {
					console.info('[AI Transcriber] Gemini diarization using short-audio single-call path.', {
						durationSec: options.durationSec,
						thresholdSeconds: GEMINI_FULL_AUDIO_TRANSCRIPTION_MAX_SECONDS,
					});
					const result = await this.transcribeGeminiShortDiarization(
						genAI,
						uploadedFullAudio,
						mimeType,
						settings,
						Type,
						options,
					);
					this.emitProgress(options, { provider: 'gemini', stage: 'done', totalChunks: 1, completedChunks: 1 });
					return result;
				}

				this.emitProgress(options, { provider: 'gemini', stage: 'transcribe', currentChunk: 1, totalChunks: 1 });
				const discovery = await this.discoverGeminiSpeakers(
					genAI,
				uploadedFullAudio,
				mimeType,
				settings,
				Type,
				options,
			);
			const discoveredDurationSec = this.getSpeakerTimelineEndSec(discovery.timeline);
				console.info('[AI Transcriber] Gemini speaker discovery complete.', {
					speakers: discovery.speakers.length,
					timelineSegments: discovery.timeline.length,
					discoveredDurationSec,
				});

				this.emitProgress(options, { provider: 'gemini', stage: 'preprocess' });
				const chunks = await this.preprocessForGeminiWithOffsets(blob, 15 * 60, options);
			if (!chunks.length) {
				return { ...discovery, segments: [] };
			}

			let completedChunks = 0;
			const chunkSegments = await this.mapWithConcurrency(
				chunks,
				2,
				options.signal,
				async (chunk, index, workerSignal) => {
					const chunkIndex = index + 1;
					const chunkMimeType = chunk.blob.type || 'audio/wav';
					let uploadedChunk: GeminiUploadedFile | null = null;
					try {
						this.emitProgress(options, {
							provider: 'gemini',
							stage: 'upload',
							currentChunk: chunkIndex,
							totalChunks: chunks.length,
							completedChunks,
						});
						uploadedChunk = await this.uploadGeminiFile(
							genAI,
							chunk.blob,
							chunkMimeType,
							`chunk ${chunkIndex}/${chunks.length}`,
							workerSignal,
						);
						uploadedChunk = await this.waitForGeminiFileReady(genAI, uploadedChunk, chunkIndex, chunks.length, {
							...options,
							signal: workerSignal,
						});

						this.emitProgress(options, {
							provider: 'gemini',
							stage: 'transcribe',
							currentChunk: chunkIndex,
							totalChunks: chunks.length,
							completedChunks,
						});
						const segments = await this.transcribeGeminiChunk(
							genAI,
							uploadedChunk,
							chunkMimeType,
							chunk,
							discovery,
							settings,
							Type,
							{ ...options, signal: workerSignal },
						);
						completedChunks++;
						this.emitProgress(options, {
							provider: 'gemini',
							stage: 'transcribe',
							currentChunk: chunkIndex,
							totalChunks: chunks.length,
							completedChunks,
						});
						return segments;
						} finally {
							if (uploadedChunk?.name) {
								await this.deleteGeminiFile(genAI, uploadedChunk);
							}
						}
				},
			);

			const rawSegments = chunkSegments.flat().sort((a, b) => a.startSec - b.startSec);
			const segments = this.assignSpeakersFromTimeline(rawSegments, discovery.timeline);
			this.emitProgress(options, { provider: 'gemini', stage: 'done', totalChunks: chunks.length, completedChunks });
			return { ...discovery, segments };
			} finally {
				if (uploadedFullAudio?.name) {
					await this.deleteGeminiFile(genAI, uploadedFullAudio);
				}
			}
		}

	private shouldUseGeminiShortFastPath(options: TranscribeOptions): boolean {
		const durationSec = options.durationSec;
		return typeof durationSec === 'number'
			&& durationSec > 0
			&& durationSec <= GEMINI_FULL_AUDIO_TRANSCRIPTION_MAX_SECONDS;
	}

	private getSpeakerTimelineEndSec(timeline: SpeakerTimelineSegment[]): number {
		return Math.max(0, ...timeline
			.map(segment => segment.endSec)
			.filter(endSec => Number.isFinite(endSec)));
	}

	private async uploadGeminiFile(
		genAI: { files: { upload: (params: { file: Blob; config: { mimeType: string; abortSignal?: AbortSignal } }) => Promise<GeminiUploadedFile> } },
		blob: Blob,
		mimeType: string,
		label: string,
		signal?: AbortSignal,
	): Promise<GeminiUploadedFile> {
		const uploadedFile = await this.withTiming(
			'Gemini upload',
			{ label, mimeType, sizeBytes: blob.size },
			() => this.withRetries(
				async () => {
					this.throwIfAborted(signal);
					return await genAI.files.upload({
						file: blob,
						config: {
							mimeType,
							abortSignal: signal,
						},
					});
				},
				{ label: `Gemini upload ${label}`, signal },
			),
		);
		if (!uploadedFile?.name || !uploadedFile?.uri) {
			throw new Error(`Gemini File API upload failed for ${label}: no file URI returned`);
		}
		return uploadedFile;
	}

	private async deleteGeminiFile(
		genAI: { files: { delete: (params: { name: string; config?: { abortSignal?: AbortSignal } }) => Promise<unknown> } },
		file: GeminiUploadedFile,
		signal?: AbortSignal,
	): Promise<void> {
		if (!file.name) return;
		try {
			await genAI.files.delete({ name: file.name, config: { abortSignal: signal } });
		} catch (error) {
			if (!this.isAbortError(error)) {
				console.warn('[AI Transcriber] Failed to delete uploaded Gemini file:', error);
			}
		}
	}

	private async discoverGeminiSpeakers(
		genAI: { models: { generateContent: (params: unknown) => Promise<GeminiGenerateContentResponse> } },
		uploadedFile: GeminiUploadedFile,
		mimeType: string,
		settings: TranscriberSettings,
		Type: Record<string, string>,
		options: TranscribeOptions,
	): Promise<{ speakers: DiscoveredSpeaker[]; timeline: SpeakerTimelineSegment[] }> {
		const prompt =
			'Listen to the entire audio and identify the distinct speakers.\n' +
			'Do NOT transcribe the spoken content. Only output speaker identities and their time ranges.\n\n' +
			'Rules:\n' +
			'1. Assign stable IDs exactly as SPEAKER_00, SPEAKER_01, SPEAKER_02, etc.\n' +
			'2. The same voice MUST use the same ID throughout the entire audio.\n' +
			'3. The timeline must be a sequence of many speaking turns, not one range per speaker.\n' +
			'4. Use absolute timestamps from the start of the full audio in HH:MM:SS or MM:SS.\n' +
			'5. If two speakers overlap, choose the dominant speaker for that time range.\n' +
			'6. Keep timeline segments reasonably granular around speaker changes.\n' +
			'7. If candidate participant context is present, put a candidate name only when highly confident; otherwise omit candidateName or use an empty string.\n' +
			'8. Return JSON only.';

			const parsed = await this.withRetries(
				async () => {
					const response = await this.withTiming(
						'Gemini speaker discovery model call',
						{ model: settings.model, mimeType },
						() => genAI.models.generateContent({
							model: settings.model,
							contents: [
								{
									role: 'user',
									parts: [{ text: this.withContext(prompt, options.context) }, { fileData: { fileUri: uploadedFile.uri!, mimeType } }],
								},
							],
							config: {
								temperature: 0,
								maxOutputTokens: GEMINI_JSON_MAX_OUTPUT_TOKENS,
								responseMimeType: 'application/json',
								responseSchema: this.getSpeakerDiscoverySchema(Type),
								abortSignal: options.signal,
							},
						}),
					);
					return this.parseJsonResponse(response.text, 'Gemini speaker discovery', response);
				},
			{
				label: 'Gemini speaker discovery',
				signal: options.signal,
				maxRetries: 3,
			},
		);
		const speakers = this.normalizeDiscoveredSpeakers(parsed.speakers);
		const timeline = this.normalizeSpeakerTimeline(parsed.timeline);
		if (!speakers.length || !timeline.length) {
			throw new Error('Gemini speaker discovery returned no usable speakers or timeline.');
			}
			return { speakers, timeline };
		}

	private async transcribeGeminiShortDiarization(
		genAI: { models: { generateContent: (params: unknown) => Promise<GeminiGenerateContentResponse> } },
		uploadedFile: GeminiUploadedFile,
		mimeType: string,
		settings: TranscriberSettings,
		Type: Record<string, string>,
		options: TranscribeOptions,
	): Promise<GeminiDiarizedTranscript> {
		const prompt =
			'Transcribe this short audio verbatim and identify the speakers in one pass.\n\n' +
			'Rules:\n' +
			'1. Output speech in the original spoken language. Do not translate and do not summarize.\n' +
			'2. Assign stable speaker IDs exactly as SPEAKER_00, SPEAKER_01, SPEAKER_02, etc.\n' +
			'3. If candidate participant context is present, put candidateName only when highly confident; otherwise omit it or use an empty string.\n' +
			'4. Return short transcript segments with absolute timestamps from the start of the audio.\n' +
			'5. Split segments whenever the speaker changes.\n' +
			'6. Return JSON only.';

		const parsed = await this.withRetries(
			async () => {
				const response = await this.withTiming(
					'Gemini short diarization model call',
					{ model: settings.model, mimeType, durationSec: options.durationSec },
					() => genAI.models.generateContent({
						model: settings.model,
						contents: [
							{
								role: 'user',
								parts: [{ text: this.withContext(prompt, options.context) }, { fileData: { fileUri: uploadedFile.uri!, mimeType } }],
							},
						],
						config: {
							temperature: 0,
							maxOutputTokens: GEMINI_JSON_MAX_OUTPUT_TOKENS,
							responseMimeType: 'application/json',
							responseSchema: this.getShortDiarizedTranscriptSchema(Type),
							abortSignal: options.signal,
						},
					}),
				);
				return this.parseJsonResponse(response.text, 'Gemini short diarization', response);
			},
			{
				label: 'Gemini short diarization',
				signal: options.signal,
				maxRetries: 3,
			},
		);

		const segments = this.normalizeGeminiTranscriptSegments(parsed.segments, 0);
		let speakers = this.normalizeDiscoveredSpeakers(parsed.speakers);
		if (!speakers.length) {
			speakers = this.deriveSpeakersFromSegments(segments);
		}
		const timeline = this.buildTimelineFromTranscriptSegments(segments);
		if (!speakers.length || !segments.length || !timeline.length) {
			throw new Error('Gemini short diarization returned no usable transcript segments.');
		}
		return { speakers, timeline, segments };
	}

		private async transcribeGeminiChunk(
			genAI: { models: { generateContent: (params: unknown) => Promise<GeminiGenerateContentResponse> } },
		uploadedFile: GeminiUploadedFile,
		mimeType: string,
		chunk: TimedAudioChunk,
		discovery: { speakers: DiscoveredSpeaker[]; timeline: SpeakerTimelineSegment[] },
		settings: TranscriberSettings,
		Type: Record<string, string>,
		options: TranscribeOptions,
	): Promise<DiarizedTranscriptSegment[]> {
		const chunkTimeline = discovery.timeline
			.filter(segment => segment.endSec >= chunk.startSec - 1 && segment.startSec <= chunk.endSec + 1)
			.map(segment => ({
				speakerId: segment.speakerId,
				start: this.formatHms(Math.max(0, segment.startSec - chunk.startSec)),
				end: this.formatHms(Math.max(0, segment.endSec - chunk.startSec)),
			}));
		const speakerDefinitions = discovery.speakers
			.map(speaker => `- ${speaker.id}: ${speaker.voiceDescription || 'distinct voice'}${speaker.candidateName ? `; possible name: ${speaker.candidateName}` : ''}`)
			.join('\n');
		const timelineHint = JSON.stringify(chunkTimeline, null, 2);
		const prompt =
			`Transcribe this audio chunk verbatim. This chunk starts at ${this.formatHms(chunk.startSec)} in the original full audio.\n\n` +
			`Known speakers from full-audio discovery:\n${speakerDefinitions}\n\n` +
			`Speaker timeline for this chunk, with timestamps relative to this chunk:\n${timelineHint}\n\n` +
			'Rules:\n' +
			'1. Output speech in the original spoken language. Do not translate and do not summarize.\n' +
			'2. Return short transcript segments with timestamps relative to this chunk.\n' +
			'3. Use speakerId from the known speaker list when it is clear from the timeline.\n' +
			'4. If a segment spans a speaker change, split it into smaller segments.\n' +
			'5. If you clearly hear a completely new voice that matches none of the known speakers, use SPEAKER_UNKNOWN.\n' +
			'6. Return JSON only.';

			const parsed = await this.withRetries(
				async () => {
					const response = await this.withTiming(
						'Gemini chunk transcription model call',
						{ model: settings.model, mimeType, startSec: chunk.startSec, endSec: chunk.endSec },
						() => genAI.models.generateContent({
							model: settings.model,
							contents: [
								{
									role: 'user',
									parts: [{ text: this.withContext(prompt, options.context) }, { fileData: { fileUri: uploadedFile.uri!, mimeType } }],
								},
							],
							config: {
								temperature: 0,
								maxOutputTokens: GEMINI_JSON_MAX_OUTPUT_TOKENS,
								responseMimeType: 'application/json',
								responseSchema: this.getChunkTranscriptSchema(Type),
								abortSignal: options.signal,
							},
						}),
					);
					return this.parseJsonResponse(response.text, 'Gemini chunk transcription', response);
				},
			{
				label: `Gemini chunk transcription ${this.formatHms(chunk.startSec)}-${this.formatHms(chunk.endSec)}`,
				signal: options.signal,
				maxRetries: 3,
			},
			);
			if (!Array.isArray(parsed.segments)) return [];
			return this.normalizeGeminiTranscriptSegments(parsed.segments, chunk.startSec);
		}

	private getSpeakerDiscoverySchema(Type: Record<string, string>): unknown {
		return {
			type: Type.OBJECT,
			properties: {
				speakers: {
					type: Type.ARRAY,
					items: {
						type: Type.OBJECT,
						properties: {
							id: { type: Type.STRING },
							voiceDescription: { type: Type.STRING },
							candidateName: { type: Type.STRING },
						},
						required: ['id'],
					},
				},
				timeline: {
					type: Type.ARRAY,
					items: {
						type: Type.OBJECT,
						properties: {
							speakerId: { type: Type.STRING },
							start: { type: Type.STRING },
							end: { type: Type.STRING },
							confidence: { type: Type.STRING },
						},
						required: ['speakerId', 'start', 'end'],
					},
				},
			},
			required: ['speakers', 'timeline'],
		};
	}

	private getChunkTranscriptSchema(Type: Record<string, string>): unknown {
		return {
			type: Type.OBJECT,
			properties: {
				segments: {
					type: Type.ARRAY,
					items: {
						type: Type.OBJECT,
						properties: {
							speakerId: { type: Type.STRING },
							start: { type: Type.STRING },
							end: { type: Type.STRING },
							text: { type: Type.STRING },
						},
						required: ['speakerId', 'start', 'end', 'text'],
					},
				},
			},
			required: ['segments'],
		};
	}

	private getShortDiarizedTranscriptSchema(Type: Record<string, string>): unknown {
		return {
			type: Type.OBJECT,
			properties: {
				speakers: {
					type: Type.ARRAY,
					items: {
						type: Type.OBJECT,
						properties: {
							id: { type: Type.STRING },
							voiceDescription: { type: Type.STRING },
							candidateName: { type: Type.STRING },
						},
						required: ['id'],
					},
				},
				segments: {
					type: Type.ARRAY,
					items: {
						type: Type.OBJECT,
						properties: {
							speakerId: { type: Type.STRING },
							start: { type: Type.STRING },
							end: { type: Type.STRING },
							text: { type: Type.STRING },
						},
						required: ['speakerId', 'start', 'end', 'text'],
					},
				},
			},
			required: ['speakers', 'segments'],
		};
	}

	private parseJsonResponse(text: unknown, label: string, response?: GeminiGenerateContentResponse): any {
		if (typeof text !== 'string' || !text.trim()) {
			throw new Error(`${label} returned no text content.`);
		}
		const trimmed = text.trim()
			.replace(/^```(?:json)?\s*/i, '')
			.replace(/\s*```$/i, '');
		try {
			return JSON.parse(trimmed);
		} catch (error) {
			const diagnostics = this.formatGeminiJsonDiagnostics(response, trimmed);
			throw new Error(
				`${label} returned invalid JSON: ${(error as Error).message}${diagnostics ? ` (${diagnostics})` : ''}`,
			);
		}
	}

	private formatGeminiJsonDiagnostics(response: GeminiGenerateContentResponse | undefined, text: string): string {
		const parts: string[] = [`responseLength=${text.length}`];
		const firstCandidate = response?.candidates?.[0];
		if (firstCandidate?.finishReason) {
			parts.push(`finishReason=${firstCandidate.finishReason}`);
		}
		if (firstCandidate?.finishMessage) {
			parts.push(`finishMessage=${firstCandidate.finishMessage}`);
		}
		const usage = response?.usageMetadata;
		if (usage) {
			const tokenParts = [
				usage.promptTokenCount !== undefined ? `prompt=${usage.promptTokenCount}` : '',
				usage.candidatesTokenCount !== undefined ? `candidates=${usage.candidatesTokenCount}` : '',
				usage.totalTokenCount !== undefined ? `total=${usage.totalTokenCount}` : '',
			].filter(Boolean);
			if (tokenParts.length) {
				parts.push(`tokens:${tokenParts.join(',')}`);
			}
		}
		return parts.join('; ');
	}

	private normalizeDiscoveredSpeakers(value: unknown): DiscoveredSpeaker[] {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const speakers: DiscoveredSpeaker[] = [];
		for (const item of value) {
				const raw = item as { id?: unknown; voiceDescription?: unknown; candidateName?: unknown };
				const id = this.normalizeSpeakerId(String(raw.id || ''));
				if (!id || seen.has(id)) continue;
				seen.add(id);
				const candidateName = typeof raw.candidateName === 'string' && raw.candidateName.trim()
					? raw.candidateName.trim()
					: null;
				speakers.push({
					id,
					voiceDescription: typeof raw.voiceDescription === 'string' ? raw.voiceDescription.trim() : undefined,
					candidateName,
				});
		}
		return speakers;
	}

	private normalizeSpeakerTimeline(value: unknown): SpeakerTimelineSegment[] {
		if (!Array.isArray(value)) return [];
		return value
			.map(item => {
				const raw = item as { speakerId?: unknown; start?: unknown; end?: unknown; confidence?: unknown };
				const speakerId = this.normalizeSpeakerId(String(raw.speakerId || ''));
				const startSec = this.parseTimestamp(String(raw.start ?? ''));
				const endSec = this.parseTimestamp(String(raw.end ?? ''));
				const confidence: 'high' | 'medium' | 'low' =
					raw.confidence === 'medium' || raw.confidence === 'low' ? raw.confidence : 'high';
				return { speakerId, startSec, endSec, confidence };
			})
			.filter(item => item.speakerId && Number.isFinite(item.startSec) && Number.isFinite(item.endSec) && item.endSec > item.startSec)
			.sort((a, b) => a.startSec - b.startSec);
	}

	private normalizeGeminiTranscriptSegments(value: unknown, offsetSec: number): DiarizedTranscriptSegment[] {
		if (!Array.isArray(value)) return [];
		return value
			.map((item: unknown) => {
				const raw = item as { speakerId?: unknown; start?: unknown; end?: unknown; text?: unknown };
				const relativeStart = this.parseTimestamp(String(raw.start ?? ''));
				const relativeEnd = this.parseTimestamp(String(raw.end ?? ''));
				const text = String(raw.text ?? '').trim();
				return {
					speakerId: this.normalizeSpeakerId(String(raw.speakerId || '')) || 'SPEAKER_UNKNOWN',
					startSec: offsetSec + relativeStart,
					endSec: offsetSec + relativeEnd,
					text,
				} as DiarizedTranscriptSegment;
			})
			.filter((segment: DiarizedTranscriptSegment) => segment.text && Number.isFinite(segment.startSec) && Number.isFinite(segment.endSec))
			.map((segment: DiarizedTranscriptSegment) => segment.endSec > segment.startSec ? segment : { ...segment, endSec: segment.startSec + 1 })
			.sort((a, b) => a.startSec - b.startSec);
	}

	private deriveSpeakersFromSegments(segments: DiarizedTranscriptSegment[]): DiscoveredSpeaker[] {
		const seen = new Set<string>();
		const speakers: DiscoveredSpeaker[] = [];
		for (const segment of segments) {
			if (!segment.speakerId || seen.has(segment.speakerId)) continue;
			seen.add(segment.speakerId);
			speakers.push({ id: segment.speakerId, voiceDescription: this.getSpeakerDisplayLabel(segment.speakerId), candidateName: null });
		}
		return speakers;
	}

	private buildTimelineFromTranscriptSegments(segments: DiarizedTranscriptSegment[]): SpeakerTimelineSegment[] {
		return segments.map(segment => ({
			speakerId: segment.speakerId,
			startSec: segment.startSec,
			endSec: segment.endSec,
			confidence: 'high',
		}));
	}

	private normalizeSpeakerId(value: string): string {
		const upper = value.trim().toUpperCase().replace(/\s+/g, '_');
		const direct = upper.match(/^SPEAKER_(\d+)$/);
		if (direct) {
			return `SPEAKER_${direct[1].padStart(2, '0')}`;
		}
		const numbered = upper.match(/^SPEAKER[_-]?(\d+)$/);
		if (numbered) {
			return `SPEAKER_${numbered[1].padStart(2, '0')}`;
		}
		return upper.startsWith('SPEAKER_') ? upper : '';
	}

	private parseTimestamp(value: string): number {
		const cleaned = value.trim();
		if (!cleaned) return Number.NaN;
		if (/^\d+(?:\.\d+)?$/.test(cleaned)) {
			return Number(cleaned);
		}
		const parts = cleaned.split(':').map(part => Number(part));
		if (parts.some(part => !Number.isFinite(part))) {
			return Number.NaN;
		}
		if (parts.length === 2) {
			return parts[0] * 60 + parts[1];
		}
		if (parts.length === 3) {
			return parts[0] * 3600 + parts[1] * 60 + parts[2];
		}
		return Number.NaN;
	}

	getSpeakerDisplayLabel(speakerId: string): string {
		const match = this.normalizeSpeakerId(speakerId).match(/^SPEAKER_(\d+)$/);
		if (!match) return speakerId;
		return `Speaker ${Number(match[1]) + 1}`;
	}

	private formatHms(seconds: number): string {
		const safeSeconds = Math.max(0, seconds);
		const whole = Math.floor(safeSeconds);
		const h = Math.floor(whole / 3600);
		const m = Math.floor((whole % 3600) / 60);
		const s = whole % 60;
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}

	private withContext(prompt: string, context?: string): string {
		if (!context?.trim()) return prompt;
		return `${prompt}\n\nMeeting context for recognition only:\n${context.trim()}\n\nDo not add context that is not spoken in the audio.`;
	}

	private assignSpeakersFromTimeline(
		segments: DiarizedTranscriptSegment[],
		timeline: SpeakerTimelineSegment[],
	): DiarizedTranscriptSegment[] {
		return segments.map(segment => {
			const assignment = this.findBestTimelineSpeaker(segment, timeline);
			return {
				...segment,
				speakerId: assignment.speakerId || segment.speakerId || 'SPEAKER_UNKNOWN',
				confidence: assignment.confidence,
			};
		});
	}

	private findBestTimelineSpeaker(
		segment: DiarizedTranscriptSegment,
		timeline: SpeakerTimelineSegment[],
	): { speakerId: string; confidence: 'high' | 'medium' | 'low' } {
		const boundaryTolerance = 0.75;
		const duration = Math.max(0.25, segment.endSec - segment.startSec);
		const overlaps = new Map<string, number>();
		for (const turn of timeline) {
			const start = Math.max(segment.startSec, turn.startSec - boundaryTolerance);
			const end = Math.min(segment.endSec, turn.endSec + boundaryTolerance);
			const overlap = Math.max(0, end - start);
			if (overlap > 0) {
				overlaps.set(turn.speakerId, (overlaps.get(turn.speakerId) ?? 0) + overlap);
			}
		}

		const ranked = Array.from(overlaps.entries()).sort((a, b) => b[1] - a[1]);
		if (!ranked.length || ranked[0][1] < 0.35) {
			return { speakerId: segment.speakerId || 'SPEAKER_UNKNOWN', confidence: 'low' };
		}

		const [speakerId, best] = ranked[0];
		const second = ranked[1]?.[1] ?? 0;
		const ratio = best / duration;
		if (ratio < 0.55 || best - second < 0.5) {
			return { speakerId, confidence: 'low' };
		}
		if (ratio < 0.7 || best - second < 1) {
			return { speakerId, confidence: 'medium' };
		}
		return { speakerId, confidence: 'high' };
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

	private async withTiming<T>(
		label: string,
		details: Record<string, unknown>,
		operation: () => Promise<T>,
	): Promise<T> {
		const startedAt = this.nowMs();
		console.info(`[AI Transcriber] ${label} start.`, details);
		try {
			const result = await operation();
			console.info(`[AI Transcriber] ${label} complete.`, {
				...details,
				durationMs: Math.round(this.nowMs() - startedAt),
			});
			return result;
		} catch (error) {
			console.warn(`[AI Transcriber] ${label} failed.`, {
				...details,
				durationMs: Math.round(this.nowMs() - startedAt),
			}, error);
			throw error;
		}
	}

	private nowMs(): number {
		return typeof performance !== 'undefined' && typeof performance.now === 'function'
			? performance.now()
			: Date.now();
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

	private getOpenAIClient(apiKey: string, baseURL?: string): OpenAI {
		const cacheKey = `${baseURL || 'openai'}:${apiKey}`;
		const cached = this.openAIClients.get(cacheKey);
		if (cached) return cached;
		const client = new OpenAI({
			apiKey,
			...(baseURL ? { baseURL } : {}),
			dangerouslyAllowBrowser: true,
		});
		this.openAIClients.set(cacheKey, client);
		return client;
	}

	private async blobToBase64(blob: Blob, signal?: AbortSignal): Promise<string> {
		this.throwIfAborted(signal);
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result || ''));
			reader.onerror = () => reject(reader.error || new Error('Failed to read audio chunk'));
			reader.readAsDataURL(blob);
		});
		this.throwIfAborted(signal);
		const commaIndex = dataUrl.indexOf(',');
		const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
		if (!base64) {
			throw new Error('Failed to encode audio chunk for OpenRouter');
		}
		return base64;
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

	private async transcribeWithOpenRouter(
		blob: Blob,
		settings: TranscriberSettings,
		options: TranscribeOptions,
	): Promise<string> {
		const openrouter = this.getOpenAIClient(settings.apiKey, OPENROUTER_BASE_URL);

		this.emitProgress(options, { provider: 'openrouter', stage: 'preprocess' });
		const chunks = await this.preprocessForGemini(blob, 15 * 60, options);
		console.info('[AI Transcriber] OpenRouter chunks ready.', {
			chunks: chunks.length,
			chunkBytes: chunks.map(chunk => chunk.size),
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
				this.emitProgress(options, {
					provider: 'openrouter',
					stage: 'transcribe',
					currentChunk: chunkIndex,
					totalChunks: chunks.length,
					completedChunks,
				});

				const transcription = await this.withRetries(
					async () => {
						this.throwIfAborted(workerSignal);
						let prompt =
							settings.prompt ||
							'Please transcribe this audio file verbatim. Output only the transcript text in the original spoken language. Do not summarize or translate.';
						if (options.context && options.context.trim()) {
							prompt +=
								'\n\n【用户提供的会议背景（仅用于提高识别准确性）】\n' +
								options.context.trim() +
								'\n【使用规则】\n- 仅用于人名/组织/术语识别\n- 不要添加音频中未出现的内容';
						}

						const audioBase64 = await this.blobToBase64(chunk, workerSignal);
						const response = await openrouter.chat.completions.create(
							{
								model: settings.model,
								messages: [
									{
										role: 'user',
										content: [
											{ type: 'text', text: prompt },
											{
												type: 'input_audio',
												input_audio: {
													data: audioBase64,
													format: 'wav',
												},
											},
										],
									},
								],
								temperature: settings.temperature,
								max_tokens: 65536,
							},
							{ signal: workerSignal },
						);

						const result = response.choices?.[0]?.message?.content;
						if (typeof result !== 'string') {
							throw new Error('Invalid response from OpenRouter API');
						}
						return result;
					},
					{
						label: `OpenRouter chunk ${chunkIndex}/${chunks.length}`,
						signal: workerSignal,
					},
				);

				completedChunks++;
				this.emitProgress(options, {
					provider: 'openrouter',
					stage: 'transcribe',
					currentChunk: chunkIndex,
					totalChunks: chunks.length,
					completedChunks,
				});
				return transcription;
			},
		);

		const fullText = results.join('\n').trim();
		this.emitProgress(options, { provider: 'openrouter', stage: 'done', totalChunks: chunks.length, completedChunks });
		console.info('[AI Transcriber] OpenRouter transcription complete.', { textLength: fullText.length });
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

	private async preprocessForGeminiWithOffsets(
		blob: Blob,
		maxDurationSeconds: number,
		options: TranscribeOptions,
	): Promise<TimedAudioChunk[]> {
		console.info('[AI Transcriber] Gemini diarization preprocess start.', { maxDurationSeconds, sizeBytes: blob.size });
		const data = await this.decodeAndResample(blob, options.signal);
		const chunks = this.splitAtSilenceToTimedWav(data, {
			trimLongSilence: false,
			minSilenceTrimSamples: 0,
			maxDurationSeconds,
			targetSampleRate: TARGET_SAMPLE_RATE,
			silenceThreshold: SILENCE_THRESHOLD,
			silenceWindowSeconds: SILENCE_WINDOW_SECONDS,
			searchRangeSeconds: SEARCH_RANGE_SECONDS,
			minChunkSeconds: MIN_CHUNK_SECONDS,
		}, options.signal);
		console.info('[AI Transcriber] Gemini diarization preprocess done.', {
			chunks: chunks.length,
			ranges: chunks.map(chunk => [chunk.startSec, chunk.endSec]),
		});
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

	private splitAtSilenceToTimedWav(
		data: Float32Array,
		options: WorkerPreprocessOptions,
		signal?: AbortSignal,
	): TimedAudioChunk[] {
		const maxSamples = Math.floor(options.maxDurationSeconds * options.targetSampleRate);
		const minChunkSamples = Math.floor(options.minChunkSeconds * options.targetSampleRate);
		const silenceWindowSamples = Math.floor(options.silenceWindowSeconds * options.targetSampleRate);
		const searchRangeSamples = Math.floor(options.searchRangeSeconds * options.targetSampleRate);
		const totalSamples = data.length;
		const chunks: TimedAudioChunk[] = [];

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
				chunks.push({
					blob: new Blob([wav], { type: 'audio/wav' }),
					startSec: startSample / options.targetSampleRate,
					endSec: endSample / options.targetSampleRate,
				});
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

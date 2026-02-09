import OpenAI from 'openai';
import { EditorSettings } from '../settings/types';

// Cache dynamically imported Gemini module
let genaiModule: typeof import('@google/genai') | null = null;
async function getGenAIModule() {
	if (!genaiModule) {
		genaiModule = await import('@google/genai');
	}
	return genaiModule;
}

type EditorStage = 'summary' | 'transcript' | 'done';

export interface EditProgress {
	stage: EditorStage;
	currentChunk?: number;
	totalChunks?: number;
}

export interface EditStreamingOptions {
	signal?: AbortSignal;
	onProgress?: (progress: EditProgress) => void;
	onPartialText?: (text: string) => void;
}

export class EditorService {
	private openAIClients = new Map<string, OpenAI>();

	/**
	 * Resolve which system prompt to use based on override or settings.
	 */
	private resolveSystemPrompt(settings: EditorSettings, systemPromptOverride?: string): string {
		if (systemPromptOverride !== undefined) {
			return systemPromptOverride;
		}
		if (settings.systemPromptTemplates && settings.systemPromptTemplates.length > 0) {
			const activeTemplate = settings.systemPromptTemplates.find(
				t => t.name === settings.activeSystemPromptTemplateName,
			);
			if (activeTemplate) {
				return activeTemplate.prompt;
			}
			const firstTemplate = settings.systemPromptTemplates[0];
			if (firstTemplate) {
				return firstTemplate.prompt;
			}
		}
		return '';
	}

	/**
	 * Build the context block for editor prompts.
	 */
	private buildEditorContextBlock(context?: string): string {
		if (!context || !context.trim()) return '';
		return `【用户提供的会议背景（可选）】
${context.trim()}
【使用规则】
- 用于帮助理解上下文
- 若与逐字稿不一致，以逐字稿为准
- 不得凭背景补充逐字稿未出现的事实

`;
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

	private emitProgress(options: EditStreamingOptions | undefined, progress: EditProgress): void {
		options?.onProgress?.(progress);
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

	/**
	 * Edit transcription in one pass (legacy path).
	 */
	async edit(
		text: string,
		settings: EditorSettings,
		systemPromptOverride?: string,
		context?: string,
	): Promise<string> {
		if (!settings.apiKey) {
			throw new Error('Editor API key is not configured');
		}

		const systemPromptToUse = this.resolveSystemPrompt(settings, systemPromptOverride);
		let prompt = '';
		if (systemPromptToUse) {
			prompt += `${systemPromptToUse}\n\n`;
		}
		if (settings.userPrompt) {
			prompt += `${settings.userPrompt}\n\n`;
		}
		prompt += this.buildEditorContextBlock(context);
		prompt += `【逐字稿】\n${text}`;

		return this.generateContent(prompt, settings, settings.temperature);
	}

	/**
	 * Two-stage editing approach to prevent transcript truncation.
	 * Non-streaming wrapper that reuses the streaming pipeline.
	 */
	async editWithTwoStage(
		text: string,
		settings: EditorSettings,
		systemPromptOverride?: string,
		context?: string,
	): Promise<string> {
		let latest = '';
		return await this.editWithTwoStageStreaming(text, settings, systemPromptOverride, context, {
			onPartialText: partial => {
				latest = partial;
			},
		}).then(finalText => finalText || latest);
	}

	/**
	 * Two-stage editing with streaming output callbacks.
	 * Stage 1: Generate summary/analysis sections.
	 * Stage 2: Format complete transcript chunk-by-chunk with streaming updates.
	 * Stage 3: Combine both parts.
	 */
	async editWithTwoStageStreaming(
		text: string,
		settings: EditorSettings,
		systemPromptOverride?: string,
		context?: string,
		options?: EditStreamingOptions,
	): Promise<string> {
		if (!settings.apiKey) {
			throw new Error('Editor API key is not configured');
		}

		this.throwIfAborted(options?.signal);
		const systemPromptToUse = this.resolveSystemPrompt(settings, systemPromptOverride);
		const rawTranscript = this.extractRawTranscript(text);

		console.info('[AI Transcriber Editor] Starting two-stage streaming generation...');

		this.emitProgress(options, { stage: 'summary' });

		const summaryPrompt = this.prepareSummaryPrompt(
			systemPromptToUse,
			settings.userPrompt || '',
			rawTranscript,
			context,
		);

		let summaryPart = '';
		try {
			summaryPart = await this.generateContentStream(
				summaryPrompt,
				settings,
				0.2,
				options?.signal,
				(_, accumulated) => {
					options?.onPartialText?.(accumulated);
				},
			);
		} catch (error) {
			if (this.isAbortError(error)) throw error;
			console.warn('[AI Transcriber Editor] Summary streaming failed. Falling back to non-stream mode.', error);
			summaryPart = await this.generateContent(summaryPrompt, settings, 0.2, options?.signal);
			options?.onPartialText?.(summaryPart);
		}

		this.throwIfAborted(options?.signal);
		console.info('[AI Transcriber Editor] Stage 1 complete, length:', summaryPart.length);

		const transcriptPart = await this.formatTranscriptStreaming(
			rawTranscript,
			settings,
			summaryPart,
			options,
		);

		const finalNote = this.combineParts(summaryPart, transcriptPart);
		this.emitProgress(options, { stage: 'done' });
		options?.onPartialText?.(finalNote);
		console.info('[AI Transcriber Editor] Two-stage streaming generation complete, total length:', finalNote.length);
		return finalNote;
	}

	/**
	 * Extract raw transcript content, removing metadata headers.
	 */
	private extractRawTranscript(text: string): string {
		const speakerMatch = text.match(/(\*\*Speaker \d+:\*\*|Speaker \d+:)/);
		if (speakerMatch && speakerMatch.index !== undefined) {
			return text.substring(speakerMatch.index).trim();
		}

		let cleaned = text;
		cleaned = cleaned.replace(/^#\s+Video Transcription.*?\n/gm, '');
		cleaned = cleaned.replace(/^\*\*Detected Language:.*?\n/gm, '');
		cleaned = cleaned.replace(/^\*\*Model:.*?\n/gm, '');
		cleaned = cleaned.replace(/^## Transcription Content\s*\n/gm, '');

		return cleaned.trim();
	}

	/**
	 * Prepare prompt for Stage 1 (summary generation only, no transcript output).
	 */
	private prepareSummaryPrompt(
		systemPrompt: string,
		userPrompt: string,
		transcript: string,
		context?: string,
	): string {
		let summaryTemplate = systemPrompt.replace(/###\s*\d+\.\s*完整逐字稿.*$/s, '');

		if (context && context.trim()) {
			userPrompt += `

【用户提供的会议背景（可选）】
${context.trim()}
【使用规则】
- 用于帮助理解上下文
- 若与逐字稿不一致，以逐字稿为准
- 不得凭背景补充逐字稿未出现的事实`;
		}

		summaryTemplate += '\n\n**重要提示**: 只生成前面的分析部分（Section 1-5或类似结构），不要输出完整逐字稿部分。';

		return userPrompt
			? `${summaryTemplate}\n\n${userPrompt}\n\n【逐字稿】\n${transcript}`
			: `${summaryTemplate}\n\n【逐字稿】\n${transcript}`;
	}

	/**
	 * Stream transcript formatting chunk-by-chunk so the caller can write partial output.
	 */
	private async formatTranscriptStreaming(
		rawTranscript: string,
		settings: EditorSettings,
		summaryPart: string,
		options?: EditStreamingOptions,
	): Promise<string> {
		const CHUNK_SIZE = 8000;
		const chunks = this.splitTextIntoChunks(rawTranscript, CHUNK_SIZE);
		const results: string[] = [];

		console.info(`[AI Transcriber Editor] Formatting transcript in ${chunks.length} chunk(s) with streaming...`);

		for (let i = 0; i < chunks.length; i++) {
			this.throwIfAborted(options?.signal);

			const chunkIndex = i + 1;
			this.emitProgress(options, { stage: 'transcript', currentChunk: chunkIndex, totalChunks: chunks.length });

			const chunk = chunks[i];
			const formatPrompt = this.buildFormatPrompt(chunk, chunkIndex, chunks.length);
			let formattedChunk = '';

			try {
				formattedChunk = await this.generateContentStream(
					formatPrompt,
					settings,
					0.1,
					options?.signal,
					(_, accumulated) => {
						const partialTranscript = [...results, accumulated.trim()].filter(Boolean).join('\n\n');
						const partial = this.combineParts(summaryPart, partialTranscript);
						options?.onPartialText?.(partial);
					},
				);
			} catch (error) {
				if (this.isAbortError(error)) throw error;
				console.warn(`[AI Transcriber Editor] Streaming failed for chunk ${chunkIndex}. Falling back to non-stream mode.`, error);
				try {
					formattedChunk = await this.generateContent(formatPrompt, settings, 0.1, options?.signal);
				} catch (innerError) {
					if (this.isAbortError(innerError)) throw innerError;
					console.error(`[AI Transcriber Editor] Chunk ${chunkIndex} failed after retries. Using raw text fallback.`, innerError);
					formattedChunk = chunk;
				}
			}

			results.push(formattedChunk.trim());

			const partialTranscript = results.join('\n\n');
			options?.onPartialText?.(this.combineParts(summaryPart, partialTranscript));
		}

		return results.join('\n\n').trim();
	}

	private buildFormatPrompt(chunk: string, chunkIndex: number, totalChunks: number): string {
		return `You are a professional transcript formatter. Your task is to clean up and format the following transcript segment while preserving ALL content.

**CRITICAL REQUIREMENTS:**
1. **Preserve ALL content** - Do NOT truncate, summarize, or omit any part. This is segment ${chunkIndex} of ${totalChunks}.
2. **Language handling:**
   - If original is primarily English, keep it English
   - If original is primarily Chinese, convert to Simplified Chinese
   - Other languages: translate to Simplified Chinese
3. **Clean up:**
   - Remove filler words (um, uh, ah, er, hmm)
   - Fix obvious typos
4. **Speaker markers:**
   - Keep all Speaker markers exactly as they appear (Speaker 1:, Speaker 2:, etc.)
   - Do NOT attempt to replace them with names
5. **Format:**
   - Output ONLY the clean transcript text.
   - Do NOT add headers, footers, or explanatory notes.

**Transcript Segment:**
${chunk}`;
	}

	/**
	 * Split text into chunks respecting paragraph boundaries.
	 */
	private splitTextIntoChunks(text: string, maxLength: number): string[] {
		const chunks: string[] = [];
		let currentChunk = '';
		const paragraphs = text.split(/\n\n+/);

		for (const para of paragraphs) {
			if (currentChunk.length + para.length > maxLength && currentChunk.length > 0) {
				chunks.push(currentChunk.trim());
				currentChunk = '';
			}

			if (para.length > maxLength) {
				const lines = para.split('\n');
				for (const line of lines) {
					if (currentChunk.length + line.length > maxLength && currentChunk.length > 0) {
						chunks.push(currentChunk.trim());
						currentChunk = '';
					}
					currentChunk += `${line}\n`;
				}
				currentChunk += '\n';
			} else {
				currentChunk += `${para}\n\n`;
			}
		}

		if (currentChunk.trim()) {
			chunks.push(currentChunk.trim());
		}

		return chunks;
	}

	/**
	 * Combine summary and formatted transcript.
	 */
	private combineParts(summary: string, formattedTranscript: string): string {
		const trimmedSummary = summary.trim();
		const trimmedTranscript = formattedTranscript.trim();
		if (!trimmedTranscript) {
			return trimmedSummary;
		}
		const separator = '\n\n---\n\n### 完整逐字稿 (Detailed Transcript)\n\n';
		return trimmedSummary + separator + trimmedTranscript;
	}

	/**
	 * Generate content using streaming API when available.
	 */
	private async generateContentStream(
		prompt: string,
		settings: EditorSettings,
		temperature: number,
		signal?: AbortSignal,
		onDelta?: (delta: string, accumulated: string) => void,
	): Promise<string> {
		this.throwIfAborted(signal);

		if (settings.provider === 'openai') {
			const client = this.getOpenAIClient(settings.apiKey);
			const stream = await client.chat.completions.create(
				{
					model: settings.model,
					messages: [{ role: 'user', content: prompt }],
					temperature,
					max_tokens: 65536,
					stream: true,
				},
				{ signal },
			);

			let result = '';
			for await (const chunk of stream) {
				this.throwIfAborted(signal);
				const delta = chunk.choices?.[0]?.delta?.content;
				if (typeof delta === 'string' && delta) {
					result += delta;
					onDelta?.(delta, result);
				}
			}
			if (!result) {
				throw new Error('OpenAI streaming response contained no text.');
			}
			return result;
		}

		if (settings.provider === 'gemini') {
			const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = await getGenAIModule();
			const genAI = new GoogleGenAI({ apiKey: settings.apiKey });
			const stream = await genAI.models.generateContentStream({
				model: settings.model,
				contents: [{ role: 'user', parts: [{ text: prompt }] }],
				config: {
					temperature,
					maxOutputTokens: 65536,
					abortSignal: signal,
					safetySettings: [
						{
							category: HarmCategory.HARM_CATEGORY_HARASSMENT,
							threshold: HarmBlockThreshold.BLOCK_NONE,
						},
						{
							category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
							threshold: HarmBlockThreshold.BLOCK_NONE,
						},
						{
							category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
							threshold: HarmBlockThreshold.BLOCK_NONE,
						},
						{
							category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
							threshold: HarmBlockThreshold.BLOCK_NONE,
						},
					],
				},
			});

			let result = '';
			for await (const chunk of stream) {
				this.throwIfAborted(signal);
				const delta = chunk.text;
				if (typeof delta === 'string' && delta) {
					result += delta;
					onDelta?.(delta, result);
				}
			}
			if (!result) {
				throw new Error('Gemini streaming response contained no text.');
			}
			return result;
		}

		throw new Error(`Unsupported provider: ${settings.provider}`);
	}

	/**
	 * Generate content using the configured API with retry logic.
	 */
	private async generateContent(
		prompt: string,
		settings: EditorSettings,
		temperature: number,
		signal?: AbortSignal,
	): Promise<string> {
		const MAX_RETRIES = 3;
		let lastError: unknown;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			this.throwIfAborted(signal);
			try {
				if (settings.provider === 'openai') {
					const client = this.getOpenAIClient(settings.apiKey);
					const response = await client.chat.completions.create(
						{
							model: settings.model,
							messages: [{ role: 'user', content: prompt }],
							temperature,
							max_tokens: 65536,
						},
						{ signal },
					);
					const result = response.choices?.[0]?.message?.content;
					if (typeof result !== 'string') {
						throw new Error('Invalid response from OpenAI API');
					}
					return result;
				}

				if (settings.provider === 'gemini') {
					const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = await getGenAIModule();
					const genAI = new GoogleGenAI({ apiKey: settings.apiKey });
					const response = await genAI.models.generateContent({
						model: settings.model,
						contents: [{ role: 'user', parts: [{ text: prompt }] }],
						config: {
							temperature,
							maxOutputTokens: 65536,
							abortSignal: signal,
							safetySettings: [
								{
									category: HarmCategory.HARM_CATEGORY_HARASSMENT,
									threshold: HarmBlockThreshold.BLOCK_NONE,
								},
								{
									category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
									threshold: HarmBlockThreshold.BLOCK_NONE,
								},
								{
									category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
									threshold: HarmBlockThreshold.BLOCK_NONE,
								},
								{
									category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
									threshold: HarmBlockThreshold.BLOCK_NONE,
								},
							],
						},
					});
					const result = response.text;
					if (typeof result !== 'string') {
						throw new Error('Invalid response from Gemini API: No text content');
					}
					return result;
				}

				throw new Error(`Unsupported provider: ${settings.provider}`);
			} catch (error) {
				lastError = error;
				if (this.isAbortError(error)) {
					throw error;
				}
				console.warn(`[AI Transcriber Editor] API request failed (attempt ${attempt}/${MAX_RETRIES}).`, error);
				if (attempt < MAX_RETRIES) {
					await this.sleep(1000 * Math.pow(2, attempt - 1), signal);
				}
			}
		}

		throw new Error(
			`API request failed after ${MAX_RETRIES} attempts. Last error: ${
				(lastError as Error)?.message || 'Unknown error'
			}`,
		);
	}
}

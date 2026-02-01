import { EditorSettings } from '../settings/types';

export class EditorService {
	/**
	 * Edit and format transcription text using the configured API provider.
	 * @param text The transcript text to edit
	 * @param settings EditorSettings from plugin configuration
	 * @param systemPromptOverride Optional: A specific system prompt to use for this edit, overriding settings.
	 */
	async edit(
		text: string,
		settings: EditorSettings,
		systemPromptOverride?: string,
		context?: string
	): Promise<string> {
		if (!settings.apiKey) {
			throw new Error('Editor API key is not configured');
		}

		// Determine the system prompt to use
		let systemPromptToUse = '';
		if (systemPromptOverride !== undefined) {
			systemPromptToUse = systemPromptOverride;
		} else if (settings.systemPromptTemplates && settings.systemPromptTemplates.length > 0) {
			const activeTemplate = settings.systemPromptTemplates.find(
				t => t.name === settings.activeSystemPromptTemplateName
			);
			if (activeTemplate) {
				systemPromptToUse = activeTemplate.prompt;
			} else {
				// Fallback to the first template if active one not found or name is out of sync
				const firstTemplate = settings.systemPromptTemplates[0];
				if (firstTemplate) {
					systemPromptToUse = firstTemplate.prompt;
				}
			}
		}

		// Build messages array for chat completion
		const messages: { role: string; content: string }[] = [];
		if (systemPromptToUse) {
			messages.push({ role: 'system', content: systemPromptToUse });
		}
		// Combine user prompt, meeting context, and transcript text
		let content = settings.userPrompt ? `${settings.userPrompt}\n\n` : '';
		if (context && context.trim()) {
			content += `【用户提供的会议背景（可选）】
${context.trim()}
【使用规则】
- 用于帮助理解上下文
- 若与逐字稿不一致，以逐字稿为准
- 不得凭背景补充逐字稿未出现的事实

`;
		}
		content += `【逐字稿】
${text}`;
		messages.push({ role: 'user', content });

		// Handle OpenAI provider
		if (settings.provider === 'openai') {
			const response = await fetch('https://api.openai.com/v1/chat/completions', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${settings.apiKey}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					model: settings.model,
					messages,
					temperature: settings.temperature,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`OpenAI editing error: ${response.status} ${errorText}`);
			}

			const data = await response.json();
			const result = data.choices?.[0]?.message?.content;
			if (typeof result !== 'string') {
				throw new Error('Invalid response from editing API');
			}
			return result;
		}

		// Gemini editing using Google GenAI SDK
		if (settings.provider === 'gemini') {
			// Use Google GenAI SDK for Gemini editing
			const { GoogleGenAI } = await import('@google/genai');
			const genAI = new GoogleGenAI({ apiKey: settings.apiKey });
			// Combine system prompt, user prompt, context, and transcript text
			let geminiContent = systemPromptToUse ? `${systemPromptToUse}\n\n` : '';
			if (settings.userPrompt) {
				geminiContent += `${settings.userPrompt}\n\n`;
			}
			if (context && context.trim()) {
				geminiContent += `【用户提供的会议背景（可选）】
${context.trim()}
【使用规则】
- 用于帮助理解上下文
- 若与逐字稿不一致，以逐字稿为准
- 不得凭背景补充逐字稿未出现的事实

`;
			}
			geminiContent += `【逐字稿】\n${text}`;

			try {
				const geminiResponse = await genAI.models.generateContent({
					model: settings.model,
					contents: [{ role: "user", parts: [{ text: geminiContent }] }],
					config: {
						temperature: settings.temperature,
						maxOutputTokens: 65536  // Critical: Large token limit to prevent truncation
					},
				});

				const geminiResult = geminiResponse.text;

				if (typeof geminiResult === 'string') {
					return geminiResult;
				} else {
					let detailedError = 'Invalid response from Gemini editing API: No text content found.';
					if (geminiResponse.promptFeedback) {
						detailedError += ` Prompt feedback: ${JSON.stringify(geminiResponse.promptFeedback)}`;
						if (geminiResponse.promptFeedback.blockReason) {
							detailedError += ` Block Reason: ${geminiResponse.promptFeedback.blockReason}`;
							if (geminiResponse.promptFeedback.blockReasonMessage) {
								detailedError += ` (${geminiResponse.promptFeedback.blockReasonMessage})`;
							}
						}
					}
					console.error('Full Gemini API response (when text is undefined):', JSON.stringify(geminiResponse, null, 2));
					throw new Error(detailedError);
				}
			} catch (error: unknown) {
				console.error('Error during Gemini API call or processing:', error);
				throw new Error(`Gemini API request failed: ${(error as Error).message || 'Unknown error'}`);
			}
		}

		throw new Error(`Unsupported editing provider: ${settings.provider}`);
	}

	/**
	 * Two-stage editing approach to prevent transcript truncation.
	 * Stage 1: Generate summary/analysis sections (without transcript output)
	 * Stage 2: Format the complete transcript separately
	 * Stage 3: Combine both parts
	 *
	 * This ensures the transcript doesn't get cut off due to token limits,
	 * as it has its own dedicated API call.
	 */
	async editWithTwoStage(
		text: string,
		settings: EditorSettings,
		systemPromptOverride?: string,
		context?: string
	): Promise<string> {
		if (!settings.apiKey) {
			throw new Error('Editor API key is not configured');
		}

		// Determine the system prompt to use
		let systemPromptToUse = '';
		if (systemPromptOverride !== undefined) {
			systemPromptToUse = systemPromptOverride;
		} else if (settings.systemPromptTemplates && settings.systemPromptTemplates.length > 0) {
			const activeTemplate = settings.systemPromptTemplates.find(
				t => t.name === settings.activeSystemPromptTemplateName
			);
			if (activeTemplate) {
				systemPromptToUse = activeTemplate.prompt;
			} else {
				const firstTemplate = settings.systemPromptTemplates[0];
				if (firstTemplate) {
					systemPromptToUse = firstTemplate.prompt;
				}
			}
		}

		console.info('[AI Transcriber Editor] Starting two-stage generation...');

		// Extract raw transcript content (remove metadata headers if present)
		const rawTranscript = this.extractRawTranscript(text);

		// ===== Stage 1: Generate Summary Sections =====
		console.info('[AI Transcriber Editor] Stage 1: Generating summary/analysis sections...');
		const summaryPrompt = this.prepareSummaryPrompt(
			systemPromptToUse,
			settings.userPrompt || '',
			rawTranscript,
			context
		);
		const summaryPart = await this.generateContent(summaryPrompt, settings, 0.2);
		console.info('[AI Transcriber Editor] Stage 1 complete, length:', summaryPart.length);

		// ===== Stage 2: Format Transcript =====
		console.info('[AI Transcriber Editor] Stage 2: Formatting complete transcript...');
		const transcriptPart = await this.formatTranscript(rawTranscript, settings);
		console.info('[AI Transcriber Editor] Stage 2 complete, length:', transcriptPart.length);

		// ===== Stage 3: Combine =====
		const fullNote = this.combineParts(summaryPart, transcriptPart);
		console.info('[AI Transcriber Editor] Two-stage generation complete, total length:', fullNote.length);

		return fullNote;
	}

	/**
	 * Extract raw transcript content, removing metadata headers
	 */
	private extractRawTranscript(text: string): string {
		// Try to find "Speaker 1:" or similar markers
		const speakerMatch = text.match(/(\*\*Speaker \d+:\*\*|Speaker \d+:)/);
		if (speakerMatch && speakerMatch.index !== undefined) {
			return text.substring(speakerMatch.index).trim();
		}

		// Remove common metadata headers
		let cleaned = text;
		cleaned = cleaned.replace(/^#\s+Video Transcription.*?\n/gm, '');
		cleaned = cleaned.replace(/^\*\*Detected Language:.*?\n/gm, '');
		cleaned = cleaned.replace(/^\*\*Model:.*?\n/gm, '');
		cleaned = cleaned.replace(/^## Transcription Content\s*\n/gm, '');

		return cleaned.trim();
	}

	/**
	 * Prepare prompt for Stage 1 (summary generation only, no transcript output)
	 */
	private prepareSummaryPrompt(
		systemPrompt: string,
		userPrompt: string,
		transcript: string,
		context?: string
	): string {
		// Remove the "完整逐字稿" section from the prompt
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

		// Add explicit instruction to not output transcript
		summaryTemplate += '\n\n**重要提示**: 只生成前面的分析部分（Section 1-5或类似结构），不要输出完整逐字稿部分。';

		return userPrompt
			? `${summaryTemplate}\n\n${userPrompt}\n\n【逐字稿】\n${transcript}`
			: `${summaryTemplate}\n\n【逐字稿】\n${transcript}`;
	}

	/**
	 * Format transcript in Stage 2
	 * Uses chunking to prevent output truncation on large files.
	 * Processes chunks in parallel with limited concurrency for speed.
	 */
	private async formatTranscript(rawTranscript: string, settings: EditorSettings): Promise<string> {
		// Split transcript into safe chunks to stay within output token limits
		const CHUNK_SIZE = 8000;
		const MAX_CONCURRENCY = 3;
		const chunks = this.splitTextIntoChunks(rawTranscript, CHUNK_SIZE);

		console.info(`[AI Transcriber Editor] Formatting transcript in ${chunks.length} chunks (concurrency: ${MAX_CONCURRENCY})...`);

		const formatResults: string[] = new Array(chunks.length);

		// Process chunks in parallel batches
		for (let i = 0; i < chunks.length; i += MAX_CONCURRENCY) {
			const batch = chunks.slice(i, i + MAX_CONCURRENCY);
			const batchPromises = batch.map(async (chunk, batchIndex) => {
				const globalIndex = i + batchIndex;
				console.info(`[AI Transcriber Editor] Processing chunk ${globalIndex + 1}/${chunks.length} (${chunk.length} chars)...`);

				const formatPrompt = `You are a professional transcript formatter. Your task is to clean up and format the following transcript segment while preserving ALL content.

**CRITICAL REQUIREMENTS:**
1. **Preserve ALL content** - Do NOT truncate, summarize, or omit any part. This is segment ${globalIndex + 1} of ${chunks.length}.
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

				try {
					const result = await this.generateContent(formatPrompt, settings, 0.1);
					return result.trim();
				} catch (error) {
					console.error(`[AI Transcriber Editor] Chunk ${globalIndex + 1} failed after retries. Using raw text as fallback. Error:`, error);
					return chunk.trim();
				}
			});

			const batchResults = await Promise.all(batchPromises);
			batchResults.forEach((result, batchIndex) => {
				formatResults[i + batchIndex] = result;
			});
		}

		return formatResults.join('\n\n');
	}

	/**
	 * Split text into chunks respecting paragraph boundaries
	 */
	private splitTextIntoChunks(text: string, maxLength: number): string[] {
		const chunks: string[] = [];
		let currentChunk = '';
		
		// Split by double newlines (paragraphs) first, then single newlines
		const paragraphs = text.split(/\n\n+/); 

		for (const para of paragraphs) {
			// If adding this paragraph exceeds limit, push current chunk
			if ((currentChunk.length + para.length) > maxLength && currentChunk.length > 0) {
				chunks.push(currentChunk.trim());
				currentChunk = '';
			}

			// If a single paragraph is huge (larger than limit), split it by lines
			if (para.length > maxLength) {
				const lines = para.split('\n');
				for (const line of lines) {
					if ((currentChunk.length + line.length) > maxLength && currentChunk.length > 0) {
						chunks.push(currentChunk.trim());
						currentChunk = '';
					}
					currentChunk += line + '\n';
				}
				currentChunk += '\n'; // Restore paragraph spacing
			} else {
				currentChunk += para + '\n\n';
			}
		}

		if (currentChunk.trim()) {
			chunks.push(currentChunk.trim());
		}

		return chunks;
	}

	/**
	 * Combine summary and formatted transcript
	 */
	private combineParts(summary: string, formattedTranscript: string): string {
		const separator = '\n\n---\n\n### 完整逐字稿 (Detailed Transcript)\n\n';
		return summary.trim() + separator + formattedTranscript.trim();
	}

	/**
	 * Generate content using the configured API
	 */
	private async generateContent(prompt: string, settings: EditorSettings, temperature: number): Promise<string> {
		const MAX_RETRIES = 3;
		let lastError: unknown;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				// Handle OpenAI provider
				if (settings.provider === 'openai') {
					const response = await fetch('https://api.openai.com/v1/chat/completions', {
						method: 'POST',
						headers: {
							Authorization: `Bearer ${settings.apiKey}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							model: settings.model,
							messages: [{ role: 'user', content: prompt }],
							temperature,
							max_tokens: 65536,
						}),
					});

					if (!response.ok) {
						const errorText = await response.text();
						throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
					}

					const data = await response.json();
					const result = data.choices?.[0]?.message?.content;
					if (typeof result !== 'string') {
						throw new Error('Invalid response from OpenAI API');
					}
					return result;
				}

				// Handle Gemini provider
				if (settings.provider === 'gemini') {
					const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = await import('@google/genai');
					const genAI = new GoogleGenAI({ apiKey: settings.apiKey });

					const geminiResponse = await genAI.models.generateContent({
						model: settings.model,
						contents: [{ role: 'user', parts: [{ text: prompt }] }],
						config: {
							temperature,
							maxOutputTokens: 65536,
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

					const result = geminiResponse.text;
					if (typeof result === 'string') {
						return result;
					} else {
						// Log detailed safety feedback if available
						console.error('Gemini API response missing text. Prompt Feedback:', geminiResponse.promptFeedback);
						throw new Error('Invalid response from Gemini API: No text content (likely blocked by safety filters)');
					}
				}

				throw new Error(`Unsupported provider: ${settings.provider}`);

			} catch (error) {
				lastError = error;
				console.warn(`[AI Transcriber Editor] API Request failed (Attempt ${attempt}/${MAX_RETRIES}):`, error);
				
				if (attempt < MAX_RETRIES) {
					// Exponential backoff: 1s, 2s, 4s...
					await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
				}
			}
		}

		// If we exhausted all retries
		throw new Error(`API request failed after ${MAX_RETRIES} attempts. Last error: ${(lastError as Error).message || 'Unknown error'}`);
	}
}

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
			// Combine system prompt, user prompt, and transcript text
			const geminiContent = systemPromptToUse
				? `${systemPromptToUse}\n\n${settings.userPrompt ? `${settings.userPrompt}\n\n${text}` : text}`
				: settings.userPrompt
					? `${settings.userPrompt}\n\n${text}`
					: text;

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
	 */
	private async formatTranscript(rawTranscript: string, settings: EditorSettings): Promise<string> {
		const formatPrompt = `You are a professional transcript formatter. Your task is to clean up and format the following transcript while preserving ALL content.

**CRITICAL REQUIREMENTS:**
1. **Preserve ALL content** - Do NOT truncate, summarize, or omit any part
2. **Language handling:**
   - If original is primarily English, keep it English
   - If original is primarily Chinese, convert to Simplified Chinese
   - Other languages: translate to Simplified Chinese
3. **Clean up:**
   - Remove filler words (um, uh, ah, er, hmm)
   - Fix obvious typos
   - Improve readability
4. **Speaker identification:**
   - If speaker names are mentioned, use actual names (e.g., "张三:", "John:")
   - Otherwise use generic markers (Speaker 1:, Speaker 2:, etc.)
5. **Paragraph breaks:**
   - New paragraph when speaker changes
   - New paragraph when topic shifts significantly
   - Avoid large continuous blocks of text

**Original Transcript:**
${rawTranscript}

**Instructions:** Output the complete formatted transcript. DO NOT add any headers, summaries, or introductions - just the clean transcript text.`;

		return await this.generateContent(formatPrompt, settings, 0.0);
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
			const { GoogleGenAI } = await import('@google/genai');
			const genAI = new GoogleGenAI({ apiKey: settings.apiKey });

			try {
				const geminiResponse = await genAI.models.generateContent({
					model: settings.model,
					contents: [{ role: 'user', parts: [{ text: prompt }] }],
					config: {
						temperature,
						maxOutputTokens: 65536,
					},
				});

				const result = geminiResponse.text;
				if (typeof result === 'string') {
					return result;
				} else {
					throw new Error('Invalid response from Gemini API: No text content');
				}
			} catch (error: unknown) {
				console.error('Error during Gemini API call:', error);
				throw new Error(`Gemini API request failed: ${(error as Error).message || 'Unknown error'}`);
			}
		}

		throw new Error(`Unsupported provider: ${settings.provider}`);
	}
}

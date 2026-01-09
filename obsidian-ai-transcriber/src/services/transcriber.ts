import OpenAI from "openai";

export class TranscriberService {
	/**
	 * Transcribe audio blob using OpenAI or Gemini API based on settings.
	 * @param blob Audio blob to transcribe
	 * @param settings TranscriberSettings from plugin configuration
	 */
	async transcribe(blob: Blob, settings: import('../settings/types').TranscriberSettings): Promise<string> {
		if (!settings.apiKey) {
			throw new Error('Transcriber API key is not configured');
		}
		console.info('[AI Transcriber] Transcription requested.', {
			provider: settings.provider,
			model: settings.model,
			mimeType: blob.type || 'unknown',
			sizeBytes: blob.size,
		});
		// Handle OpenAI transcription
		if (settings.provider === 'openai') {
			// Use OpenAI SDK for transcription
			// OpenAI Whisper 有 25MB 限制，需要分块
			const openai = new OpenAI({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
			console.info('[AI Transcriber] OpenAI preprocess start.');
			const chunks = await this.preprocess(blob);
			console.info('[AI Transcriber] OpenAI preprocess done.', { chunks: chunks.length, chunkBytes: chunks.map(c => c.size) });
			let fullText = '';
			let idx = 0;
			for (const chunk of chunks) {
				idx++;
				console.info(`[AI Transcriber] OpenAI transcribing chunk ${idx}/${chunks.length}...`, { sizeBytes: chunk.size });
				const transcription = await openai.audio.transcriptions.create({
					file: new File([chunk], 'audio.wav', { type: 'audio/wav' }),
					model: settings.model,
					response_format: 'text',
					...(settings.prompt ? { prompt: settings.prompt } : {}),
				});
				if (fullText) fullText += '\n';
				fullText += transcription;
			}
			console.info('[AI Transcriber] OpenAI transcription complete.', { textLength: fullText.length });
			return fullText;
		}

		// Handle Gemini transcription using File API
		// Gemini File API 支持最长 9.5 小时，但保险起见超过 8 小时就分块
		if (settings.provider === 'gemini') {
			const { GoogleGenAI } = await import('@google/genai');
			const genAI = new GoogleGenAI({ apiKey: settings.apiKey });

			// Prefer uploading the original (already compressed) audio when possible.
			// Fall back to preprocessing/chunking only for very large files.
			const MAX_UPLOAD_BYTES = 90 * 1024 * 1024; // Keep below 100MB File API limit
			const MAX_DURATION_SECONDS = 8 * 60 * 60; // 8 小时（用于预处理分块）
			const preferQualityWav = settings.preferQualityWav;
			const useDirectUpload = !preferQualityWav && blob.size <= MAX_UPLOAD_BYTES;
			console.info('[AI Transcriber] Gemini path selected.', {
				useDirectUpload,
				preferQualityWav,
				thresholdBytes: MAX_UPLOAD_BYTES,
			});
			const chunks = useDirectUpload
				? [blob]
				: await this.preprocessForGemini(blob, MAX_DURATION_SECONDS);
			console.info('[AI Transcriber] Gemini chunks ready.', { chunks: chunks.length, chunkBytes: chunks.map(c => c.size), mimeTypes: chunks.map(c => c.type || 'unknown') });

			let fullText = '';
			let idx = 0;
			for (const chunk of chunks) {
				idx++;
				const mimeType = chunk.type || 'audio/webm';
				// 使用 File API 上传音频
				console.info(`[AI Transcriber] Gemini uploading chunk ${idx}/${chunks.length}...`, { mimeType, sizeBytes: chunk.size });
				const uploadStart = Date.now();
				let file = await genAI.files.upload({
					file: chunk,
					config: { mimeType }
				});
				console.info('[AI Transcriber] Gemini upload done.', { ms: Date.now() - uploadStart, uri: file?.uri, state: file?.state });

				if (!file?.uri) {
					throw new Error('Gemini File API upload failed: no file URI returned');
				}

				// 等待文件处理完成
				let lastLog = Date.now();
				while (file.state === 'PROCESSING') {
					await new Promise(resolve => setTimeout(resolve, 1000));
					file = await genAI.files.get({ name: file.name! });
					if (Date.now() - lastLog >= 5000) {
						console.info('[AI Transcriber] Gemini file still processing...', { name: file.name, state: file.state });
						lastLog = Date.now();
					}
				}

				if (file.state === 'FAILED') {
					throw new Error('Gemini file processing failed');
				}
				console.info('[AI Transcriber] Gemini file processing complete.', { name: file.name, state: file.state });

				// 使用文件 URI 进行转录
				console.info(`[AI Transcriber] Gemini generating content for chunk ${idx}/${chunks.length}...`);

				// Enhanced prompt to emphasize completeness
				const enhancedPrompt = settings.prompt ||
					'You are a professional multilingual transcriber. Your task is to transcribe the audio file VERBATIM (word-for-word) into text.\n\n' +
					'**CRITICAL REQUIREMENTS:**\n' +
					'- **TRANSCRIBE THE ENTIRE AUDIO FROM START TO FINISH.** Do NOT skip, truncate, or omit any part.\n' +
					'- **DO NOT SUMMARIZE.** Every single word must be transcribed.\n' +
					'- **OUTPUT MUST BE IN THE SAME LANGUAGE AS SPOKEN IN THE AUDIO.** NEVER translate to any other language.\n' +
					'- If the audio is long, you MUST continue transcribing until the very end. Never stop early.\n\n' +
					'**GUIDELINES:**\n' +
					'1. **Languages:** The audio may contain **Mandarin Chinese**, **English**, and/or **Japanese**.\n' +
					'   - Transcribe exactly as spoken in the original language.\n' +
					'   - **DO NOT TRANSLATE.** (e.g., If spoken in English, write in English; if in Japanese, write in Japanese Kanji/Kana).\n' +
					'2. **Speaker Identification:** Identify different speakers. Label them as "**Speaker 1:**", "**Speaker 2:**", etc. Start a new paragraph every time the speaker changes.\n' +
					'3. **Accuracy:** Do not correct grammar. Do not paraphrase. Include every detail, every word, every sentence.\n' +
					'4. **Format:** Output plain text with clear paragraph breaks.\n' +
					'5. **Noise:** Ignore non-speech sounds (like [laughter], [silence], [typing sounds]).\n\n' +
					'Begin transcription now and continue until the audio ends.';

				const response = await genAI.models.generateContent({
					model: settings.model,
					contents: [{
						role: 'user',
						parts: [
									{ text: enhancedPrompt },
									{ fileData: { fileUri: file.uri!, mimeType } }
								]
							}],
					config: {
						temperature: settings.temperature,
						maxOutputTokens: 65536  // Critical: Large token limit to prevent truncation
					}
				});

				const result = response.text;

				// 清理上传的文件
				try {
					await genAI.files.delete({ name: file.name! });
				} catch (e) {
					console.warn('Failed to delete uploaded file:', e);
				}

				if (typeof result !== 'string') {
					throw new Error('Gemini Transcription error: No text content in response');
				}

				if (fullText) fullText += '\n';
				fullText += result;
			}

			console.info('[AI Transcriber] Gemini transcription complete.', { textLength: fullText.length });
			return fullText;
		}

		throw new Error(`Unsupported transcription provider: ${settings.provider}`);
	}

	/**
	 * Gemini 专用预处理：重采样、去静音，超过 maxDurationSeconds 则分块。
	 * 仅在原始音频过大时使用此路径。
	 */
	private async preprocessForGemini(blob: Blob, maxDurationSeconds: number): Promise<Blob[]> {
		console.info('[AI Transcriber] Gemini preprocess (WAV chunking) start.', { maxDurationSeconds, sizeBytes: blob.size });
		const TARGET_SAMPLE_RATE = 16000;
		const SILENCE_THRESHOLD = 0.01;
		const MIN_SILENCE_DURATION_SECONDS = 2;
		const MIN_SILENCE_TRIM_SAMPLES = Math.floor(MIN_SILENCE_DURATION_SECONDS * TARGET_SAMPLE_RATE);
		const CHUNK_SPLIT_SILENCE_WINDOW_SECONDS = 0.3;
		const CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES = Math.floor(CHUNK_SPLIT_SILENCE_WINDOW_SECONDS * TARGET_SAMPLE_RATE);
		const CHUNK_SPLIT_SEARCH_RANGE_SECONDS = 5;
		const CHUNK_SPLIT_SEARCH_RANGE_SAMPLES = Math.floor(CHUNK_SPLIT_SEARCH_RANGE_SECONDS * TARGET_SAMPLE_RATE);
		const MIN_CHUNK_SAMPLES = TARGET_SAMPLE_RATE; // 最短 1 秒

		const arrayBuffer = await blob.arrayBuffer();
		const AudioContextConstructor = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AudioContextConstructor) {
			throw new Error("Web Audio API is not supported in this browser.");
		}
		const decodeCtx = new AudioContextConstructor();
		const originalBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
		await decodeCtx.close();

		const targetLength = Math.ceil(originalBuffer.duration * TARGET_SAMPLE_RATE);
		const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
		const source = offlineCtx.createBufferSource();

		if (originalBuffer.numberOfChannels > 1) {
			const numChannels = originalBuffer.numberOfChannels;
			const monoBuf = offlineCtx.createBuffer(1, originalBuffer.length, originalBuffer.sampleRate);
			const monoData = monoBuf.getChannelData(0);
			const channels = [];
			for (let c = 0; c < numChannels; c++) {
				channels.push(originalBuffer.getChannelData(c));
			}
			for (let i = 0; i < originalBuffer.length; i++) {
				let sum = 0;
				for (let c = 0; c < numChannels; c++) {
					sum += channels[c][i];
				}
				monoData[i] = sum / numChannels;
			}
			source.buffer = monoBuf;
		} else {
			source.buffer = originalBuffer;
		}
		source.connect(offlineCtx.destination);
		source.start();
		const resampled = await offlineCtx.startRendering();

		// 静音裁剪
		const rawData = resampled.getChannelData(0);
		let samplesToKeep = 0;
		let currentSilentCount = 0;
		for (let i = 0; i < rawData.length; i++) {
			if (Math.abs(rawData[i]) <= SILENCE_THRESHOLD) {
				currentSilentCount++;
			} else {
				if (currentSilentCount > 0 && currentSilentCount < MIN_SILENCE_TRIM_SAMPLES) {
					samplesToKeep += currentSilentCount;
				}
				currentSilentCount = 0;
				samplesToKeep++;
			}
		}

		const data = new Float32Array(samplesToKeep);
		let currentIndex = 0;
		currentSilentCount = 0;
		for (let i = 0; i < rawData.length; i++) {
			if (Math.abs(rawData[i]) <= SILENCE_THRESHOLD) {
				currentSilentCount++;
			} else {
				if (currentSilentCount > 0 && currentSilentCount < MIN_SILENCE_TRIM_SAMPLES) {
					for (let j = i - currentSilentCount; j < i; j++) {
						data[currentIndex++] = rawData[j];
					}
				}
				currentSilentCount = 0;
				data[currentIndex++] = rawData[i];
			}
		}

		// 分块逻辑（如果超过 maxDurationSeconds）
		const maxSamples = maxDurationSeconds * TARGET_SAMPLE_RATE;
		const totalSamples = data.length;
		const chunks: Blob[] = [];
		const audioCtx = new AudioContextConstructor();

		let startSample = 0;
		while (startSample < totalSamples) {
			let endSample = Math.min(startSample + maxSamples, totalSamples);

			// 如果不是最后一块，尝试在静音处切分
			if (endSample < totalSamples) {
				let splitPoint: number | null = null;
				const desiredSplit = endSample;

				// 向后搜索静音点
				const backwardStart = Math.max(CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES, desiredSplit - CHUNK_SPLIT_SEARCH_RANGE_SAMPLES);
				for (let i = desiredSplit; i >= backwardStart; i--) {
					let silent = true;
					for (let j = i - CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES; j < i; j++) {
						if (Math.abs(data[j]) > SILENCE_THRESHOLD) { silent = false; break; }
					}
					if (silent) { splitPoint = i - CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES; break; }
				}

				// 向前搜索静音点
				if (splitPoint === null) {
					const forwardEnd = Math.min(totalSamples, desiredSplit + CHUNK_SPLIT_SEARCH_RANGE_SAMPLES);
					for (let i = desiredSplit; i < forwardEnd; i++) {
						let silent = true;
						for (let j = i; j < i + CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES && j < totalSamples; j++) {
							if (Math.abs(data[j]) > SILENCE_THRESHOLD) { silent = false; break; }
						}
						if (silent) { splitPoint = i; break; }
					}
				}

				if (splitPoint !== null && splitPoint > startSample) {
					endSample = splitPoint;
				}
			}

			const segmentSamples = endSample - startSample;
			if (segmentSamples >= MIN_CHUNK_SAMPLES) {
				const buffer = audioCtx.createBuffer(1, segmentSamples, TARGET_SAMPLE_RATE);
				buffer.getChannelData(0).set(data.subarray(startSample, endSample));
				chunks.push(this.bufferToWav(buffer));
			}

			startSample = endSample;
		}

		await audioCtx.close();
		console.info('[AI Transcriber] Gemini preprocess done.', { chunks: chunks.length, chunkBytes: chunks.map(c => c.size) });
		return chunks;
	}

	// Preprocess audio: decode, resample to 16k mono and chunk into ≤10min WAV blobs
	private async preprocess(blob: Blob, maxSecsInput?: number): Promise<Blob[]> {
		console.info('[AI Transcriber] OpenAI preprocess (WAV chunking) start.', { maxSecsInput, sizeBytes: blob.size });
		const TARGET_SAMPLE_RATE = 16000;
		const MAX_CHUNK_SECONDS = maxSecsInput ?? 600; // Default to 10 minutes (600s) if not provided
		const SILENCE_THRESHOLD = 0.01;
		const MIN_SILENCE_DURATION_SECONDS = 2;
		const MIN_SILENCE_TRIM_SAMPLES = Math.floor(MIN_SILENCE_DURATION_SECONDS * TARGET_SAMPLE_RATE);
		const CHUNK_SPLIT_SILENCE_WINDOW_SECONDS = 0.3;
		const CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES = Math.floor(CHUNK_SPLIT_SILENCE_WINDOW_SECONDS * TARGET_SAMPLE_RATE);
		const CHUNK_SPLIT_SEARCH_RANGE_SECONDS = 5;
		const CHUNK_SPLIT_SEARCH_RANGE_SAMPLES = Math.floor(CHUNK_SPLIT_SEARCH_RANGE_SECONDS * TARGET_SAMPLE_RATE);
		const MIN_CHUNK_DURATION_SECONDS = 1;
		const MIN_CHUNK_SAMPLES = Math.floor(MIN_CHUNK_DURATION_SECONDS * TARGET_SAMPLE_RATE);


		const arrayBuffer = await blob.arrayBuffer();
		const AudioContextConstructor = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AudioContextConstructor) {
			throw new Error("Web Audio API is not supported in this browser.");
		}
		const decodeCtx = new AudioContextConstructor();
		const originalBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
		// 解码完成后关闭 AudioContext 释放资源
		await decodeCtx.close();
		
		const targetLength = Math.ceil(originalBuffer.duration * TARGET_SAMPLE_RATE);
		const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
		const source = offlineCtx.createBufferSource();

		if (originalBuffer.numberOfChannels > 1) {
			const numChannels = originalBuffer.numberOfChannels;
			const monoBuf = offlineCtx.createBuffer(1, originalBuffer.length, originalBuffer.sampleRate);
			const monoData = monoBuf.getChannelData(0);
			const channels = [];
			for (let c = 0; c < numChannels; c++) {
				channels.push(originalBuffer.getChannelData(c));
			}
			for (let i = 0; i < originalBuffer.length; i++) {
				let sum = 0;
				for (let c = 0; c < numChannels; c++) {
					sum += channels[c][i];
				}
				monoData[i] = sum / numChannels;
			}
			source.buffer = monoBuf;
		} else {
			source.buffer = originalBuffer;
		}
		source.connect(offlineCtx.destination);
		source.start();
		const resampled = await offlineCtx.startRendering();
		// Silence trimming: remove continuous silent segments longer than MIN_SILENCE_DURATION_SECONDS
		const rawData = resampled.getChannelData(0);
		// const silenceThreshold = 0.01; // Replaced by SILENCE_THRESHOLD
		// const minSilenceTrimSamples = Math.floor(2 * TARGET_SAMPLE_RATE); // Replaced by MIN_SILENCE_TRIM_SAMPLES

		// Optimized silence trimming to avoid large intermediate arrays
		let samplesToKeep = 0;
		let currentSilentCountForCounting = 0;
		for (let i = 0; i < rawData.length; i++) {
			const sample = rawData[i];
			if (Math.abs(sample) <= SILENCE_THRESHOLD) {
				currentSilentCountForCounting++;
			} else {
				if (currentSilentCountForCounting > 0 && currentSilentCountForCounting < MIN_SILENCE_TRIM_SAMPLES) {
					samplesToKeep += currentSilentCountForCounting; // Keep the short silence
				}
				currentSilentCountForCounting = 0;
				samplesToKeep++; // Keep the current non-silent sample
			}
		}
		// Note: Trailing silence (short or long) is implicitly dropped by this logic,
		// matching the original behavior where the loop ended without adding trailing short silence.

		const data = new Float32Array(samplesToKeep);
		let currentIndex = 0;
		let currentSilentCountForFilling = 0;
		for (let i = 0; i < rawData.length; i++) {
			const sample = rawData[i];
			if (Math.abs(sample) <= SILENCE_THRESHOLD) {
				currentSilentCountForFilling++;
			} else {
				if (currentSilentCountForFilling > 0 && currentSilentCountForFilling < MIN_SILENCE_TRIM_SAMPLES) {
					for (let j = i - currentSilentCountForFilling; j < i; j++) {
						data[currentIndex++] = rawData[j];
					}
				}
				currentSilentCountForFilling = 0;
				data[currentIndex++] = sample;
			}
		}
		// `data` is now the trimmed Float32Array

		const maxSamples = MAX_CHUNK_SECONDS * TARGET_SAMPLE_RATE;
		const totalSamples = data.length;
		// const silenceWindowSamples = Math.floor(0.3 * TARGET_SAMPLE_RATE); // Replaced by CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES
		// const searchRangeSamples = Math.floor(5 * TARGET_SAMPLE_RATE);      // Replaced by CHUNK_SPLIT_SEARCH_RANGE_SAMPLES
		const audioCtxForChunking = new AudioContextConstructor(); // Use the same constructor for consistency
		const chunks: Blob[] = [];
		let startSample = 0;
		// const minChunkSamples = TARGET_SAMPLE_RATE; // discard segments shorter than 1s - Replaced by MIN_CHUNK_SAMPLES
		while (startSample < totalSamples) {
			let endSample = Math.min(startSample + maxSamples, totalSamples);
			if (endSample < totalSamples) {
				let splitPoint: number | null = null;
				const desiredSplit = endSample;
				// search backward for a silent region
				const backwardStart = Math.max(CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES, desiredSplit - CHUNK_SPLIT_SEARCH_RANGE_SAMPLES);
				for (let i = desiredSplit; i >= backwardStart; i--) {
					let silent = true;
					for (let j = i - CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES; j < i; j++) {
						if (Math.abs(data[j]) > SILENCE_THRESHOLD) { silent = false; break; }
					}
					if (silent) { splitPoint = i - CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES; break; }
				}
				// if no silent point before, search forward
				if (splitPoint === null) {
					const forwardEnd = Math.min(totalSamples, desiredSplit + CHUNK_SPLIT_SEARCH_RANGE_SAMPLES);
					for (let i = desiredSplit; i < forwardEnd; i++) {
						let silent = true;
						for (let j = i; j < i + CHUNK_SPLIT_SILENCE_WINDOW_SAMPLES && j < totalSamples; j++) {
							if (Math.abs(data[j]) > SILENCE_THRESHOLD) { silent = false; break; }
						}
						if (silent) { splitPoint = i; break; }
					}
				}
				if (splitPoint !== null && splitPoint > startSample) {
					endSample = splitPoint;
				}
			}
			const segmentBuf = audioCtxForChunking.createBuffer(1, endSample - startSample, TARGET_SAMPLE_RATE);
			segmentBuf.getChannelData(0).set(data.subarray(startSample, endSample));
			const segmentSamples = endSample - startSample;
			if (segmentSamples >= MIN_CHUNK_SAMPLES) {
				chunks.push(this.bufferToWav(segmentBuf));
			}
			startSample = endSample;
		}
		// 分块完成后关闭 AudioContext 释放资源
		await audioCtxForChunking.close();
		console.info('[AI Transcriber] OpenAI preprocess done.', { chunks: chunks.length, chunkBytes: chunks.map(c => c.size) });
		return chunks;
	}

	private bufferToWav(buffer: AudioBuffer): Blob {
		const numOfChannels = buffer.numberOfChannels;
		const sampleRate = buffer.sampleRate;
		const bitDepth = 16;
		const blockAlign = numOfChannels * (bitDepth / 8);
		const dataSize = buffer.length * blockAlign;
		const bufferArray = new ArrayBuffer(44 + dataSize);
		const view = new DataView(bufferArray);

		const writeString = (str: string, offset: number) => {
			for (let i = 0; i < str.length; i++) {
				view.setUint8(offset + i, str.charCodeAt(i));
			}
		};

		writeString('RIFF', 0);
		view.setUint32(4, 36 + dataSize, true);
		writeString('WAVE', 8);
		writeString('fmt ', 12);
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, numOfChannels, true);
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * blockAlign, true);
		view.setUint16(32, blockAlign, true);
		view.setUint16(34, bitDepth, true);
		writeString('data', 36);
		view.setUint32(40, dataSize, true);

		let offset = 44;
		const channelData = buffer.getChannelData(0);
		for (let i = 0; i < channelData.length; i++) {
			const s = Math.max(-1, Math.min(1, channelData[i]));
			view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
			offset += 2;
		}

		return new Blob([view], { type: 'audio/wav' });
	}

} 

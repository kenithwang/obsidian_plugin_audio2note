#!/usr/bin/env node
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY environment variable is not set');
  process.exit(1);
}

const audioFile = process.argv[2];
if (!audioFile) {
  console.error('Usage: node cli-transcribe.mjs <audio-file>');
  process.exit(1);
}

const genAI = new GoogleGenAI({ apiKey });

async function transcribe(filePath) {
  const absolutePath = path.resolve(filePath);
  const mimeType = filePath.endsWith('.webm') ? 'audio/webm' :
                   filePath.endsWith('.m4a') ? 'audio/mp4' :
                   filePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/webm';

  console.log(`Uploading ${absolutePath} (${mimeType})...`);

  const fileBuffer = fs.readFileSync(absolutePath);
  const blob = new Blob([fileBuffer], { type: mimeType });

  let file = await genAI.files.upload({
    file: blob,
    config: { mimeType }
  });

  console.log(`Upload complete. URI: ${file?.uri}, State: ${file?.state}`);

  // Wait for processing
  while (file.state === 'PROCESSING') {
    await new Promise(resolve => setTimeout(resolve, 2000));
    file = await genAI.files.get({ name: file.name });
    console.log(`Processing... State: ${file.state}`);
  }

  if (file.state === 'FAILED') {
    throw new Error('File processing failed');
  }

  console.log('Generating transcription...');

  const enhancedPrompt =
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
    model: 'gemini-3-flash-preview',
    contents: [{
      role: 'user',
      parts: [
        { text: enhancedPrompt },
        { fileData: { fileUri: file.uri, mimeType } }
      ]
    }],
    config: {
      temperature: 0.2,
      maxOutputTokens: 65536
    }
  });

  // Cleanup uploaded file
  try {
    await genAI.files.delete({ name: file.name });
    console.log('Cleaned up uploaded file.');
  } catch (e) {
    console.warn('Failed to delete uploaded file:', e.message);
  }

  return response.text;
}

(async () => {
  try {
    const transcript = await transcribe(audioFile);

    // Save transcript
    const baseName = path.basename(audioFile, path.extname(audioFile));
    const outputFile = `${baseName}_transcript.md`;
    fs.writeFileSync(outputFile, transcript);
    console.log(`\nTranscript saved to: ${outputFile}`);
    console.log(`\n--- Transcript Preview (first 500 chars) ---\n`);
    console.log(transcript.substring(0, 500) + (transcript.length > 500 ? '...' : ''));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
})();

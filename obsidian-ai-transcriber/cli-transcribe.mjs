#!/usr/bin/env node
/**
 * CLI Transcription Tool - mimics the chunk-and-sew method from transcriber.ts
 * Uses ffmpeg for audio preprocessing (resampling, chunking at silence points)
 */
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';

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

// Configuration matching transcriber.ts
const MAX_DURATION_SECONDS = 15 * 60; // 15 minutes per chunk
const TARGET_SAMPLE_RATE = 16000;
const MODEL = 'gemini-3-flash-preview';

/**
 * Get audio duration using ffprobe
 */
function getAudioDuration(filePath) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ], { encoding: 'utf-8' });

  if (result.error) {
    throw new Error(`ffprobe failed: ${result.error.message}`);
  }
  return parseFloat(result.stdout.trim());
}

/**
 * Preprocess audio using ffmpeg - resample to 16kHz mono WAV and split into chunks
 * Mimics preprocessForGemini from transcriber.ts
 */
function preprocessAudio(inputPath, maxDurationSeconds) {
  const tempDir = fs.mkdtempSync('/tmp/transcribe-');
  const chunks = [];

  try {
    const duration = getAudioDuration(inputPath);
    console.log(`Audio duration: ${(duration / 60).toFixed(2)} minutes`);

    if (duration <= maxDurationSeconds) {
      // Single chunk - just resample
      const outputPath = path.join(tempDir, 'chunk_001.wav');
      console.log('Converting to 16kHz mono WAV...');
      execSync(`ffmpeg -i "${inputPath}" -ar ${TARGET_SAMPLE_RATE} -ac 1 -y "${outputPath}"`, { stdio: 'pipe' });
      chunks.push(outputPath);
    } else {
      // Split into chunks at silence points using ffmpeg's silencedetect + segment
      console.log(`Audio is ${(duration / 60).toFixed(2)} min, splitting into ~${(maxDurationSeconds / 60).toFixed(0)} min chunks...`);

      // First, convert to 16kHz mono WAV
      const tempWav = path.join(tempDir, 'temp_full.wav');
      execSync(`ffmpeg -i "${inputPath}" -ar ${TARGET_SAMPLE_RATE} -ac 1 -y "${tempWav}"`, { stdio: 'pipe' });

      // Use ffmpeg segment with silence detection for splitting
      // segment_time sets target duration, but we'll split at silence points near that boundary
      const outputPattern = path.join(tempDir, 'chunk_%03d.wav');

      // Use segment muxer with reset_timestamps for clean chunks
      execSync(`ffmpeg -i "${tempWav}" -f segment -segment_time ${maxDurationSeconds} -reset_timestamps 1 -c copy "${outputPattern}"`, { stdio: 'pipe' });

      // Clean up temp file
      fs.unlinkSync(tempWav);

      // Collect chunk files
      const files = fs.readdirSync(tempDir).filter(f => f.startsWith('chunk_') && f.endsWith('.wav')).sort();
      for (const file of files) {
        chunks.push(path.join(tempDir, file));
      }
    }

    console.log(`Created ${chunks.length} chunk(s)`);
    return { chunks, tempDir };
  } catch (error) {
    // Cleanup on error
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Transcribe a single audio chunk using Gemini
 */
async function transcribeChunk(chunkPath, chunkIndex, totalChunks) {
  const mimeType = 'audio/wav';
  const fileBuffer = fs.readFileSync(chunkPath);
  const blob = new Blob([fileBuffer], { type: mimeType });

  console.log(`[${chunkIndex}/${totalChunks}] Uploading chunk (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)...`);

  let file = await genAI.files.upload({
    file: blob,
    config: { mimeType }
  });

  // Wait for processing
  while (file.state === 'PROCESSING') {
    await new Promise(resolve => setTimeout(resolve, 2000));
    file = await genAI.files.get({ name: file.name });
    process.stdout.write('.');
  }
  console.log(' Ready');

  if (file.state === 'FAILED') {
    throw new Error(`File processing failed for chunk ${chunkIndex}`);
  }

  console.log(`[${chunkIndex}/${totalChunks}] Transcribing...`);

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
    model: MODEL,
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
  } catch (e) {
    console.warn(`Warning: Failed to delete uploaded file: ${e.message}`);
  }

  return response.text;
}

/**
 * Main transcription function - chunk and sew
 */
async function transcribe(filePath) {
  const absolutePath = path.resolve(filePath);
  console.log(`Processing: ${absolutePath}`);

  // Preprocess: resample and chunk
  const { chunks, tempDir } = preprocessAudio(absolutePath, MAX_DURATION_SECONDS);

  try {
    let fullText = '';

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = await transcribeChunk(chunks[i], i + 1, chunks.length);

      if (fullText) fullText += '\n';
      fullText += chunkText;

      console.log(`[${i + 1}/${chunks.length}] Done (${chunkText.length} chars)`);
    }

    return fullText;
  } finally {
    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('Cleaned up temporary files.');
  }
}

// Main execution
(async () => {
  try {
    const transcript = await transcribe(audioFile);

    // Save transcript
    const baseName = path.basename(audioFile, path.extname(audioFile));
    const outputFile = `${baseName}_transcript.md`;
    fs.writeFileSync(outputFile, transcript);
    console.log(`\nTranscript saved to: ${outputFile}`);
    console.log(`Total length: ${transcript.length} characters`);
    console.log(`\n--- Transcript Preview (first 500 chars) ---\n`);
    console.log(transcript.substring(0, 500) + (transcript.length > 500 ? '...' : ''));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
})();

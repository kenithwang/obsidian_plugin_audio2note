# Obsidian AI Transcriber

An Obsidian plugin that records and transcribes audio into structured Markdown notes, powered by OpenAI and Google Gemini.

## Features

### Core

- **Audio Recording** — Record directly within Obsidian via ribbon icon or command palette, with real-time waveform visualization.
- **AI Transcription** — Transcribe audio to text using OpenAI (Whisper) or Google Gemini. Supports `.webm`, `.m4a`, `.mp3`, `.wav`, `.ogg`, `.flac`, `.aac`, `.opus`, `.mp4`.
- **AI Editing** — Optionally refine raw transcripts into structured notes (e.g., meeting minutes) using customizable system prompt templates.
- **Context Menu** — Right-click any supported audio file in the file explorer to transcribe it directly.

### Productivity

- **Cancelable Tasks** — Cancel in-flight transcription or editing from the status bar at any time.
- **Live Progress** — Status bar and notices show real-time chunk-level progress during long jobs.
- **Streaming Output** — Edited transcript is written incrementally to disk as the AI generates, so you can read along.
- **Two-Stage Editing** — Summary generation followed by parallel transcript formatting to avoid truncation on long transcripts.

### Customization

- **System Prompt Templates** — Create, manage, and select different system prompts for different use cases (meeting minutes, lecture notes, interviews, etc.).
- **Template Import/Export** — Share templates as JSON files between vaults or with colleagues.
- **Participant Management** — Add meeting participants with name, organization, and role for better speaker identification.
- **Meeting Context** — Provide meeting purpose/background to improve transcript quality.
- **Flexible Output** — Save raw and/or edited transcripts to configurable vault subdirectories.

### Internationalization

- **Chinese / English UI** — Automatically detects Obsidian's language and switches between Chinese (zh) and English (en).

## Installation

1. Create a folder named `obsidian-ai-transcriber` in your vault's plugins directory:
   ```
   YourVault/.obsidian/plugins/obsidian-ai-transcriber
   ```
2. Copy `main.js`, `manifest.json`, and `styles.css` to the folder.
3. Reload Obsidian and enable the plugin in **Settings → Community Plugins**.

## Usage

### Record & Transcribe

1. Click the **microphone icon** in the left ribbon, or run **"Record Audio"** from the command palette.
2. Record your audio. When done:
   - **Stop & Save** — Saves the audio file only.
   - **Stop & Transcribe** — Saves and transcribes. If AI Editing is enabled, you'll be prompted to select a system prompt template first.

### Transcribe Existing Files

Right-click any supported audio file → **"Transcribe with AI"**.

### Edit Existing Transcripts

Open a transcript `.md` file → run **"Edit Current Transcript with AI"** from the command palette → select a template.

### Output Files

| File | Description |
|------|-------------|
| `<name>_raw_transcript.md` | Raw transcription output |
| `<name>_edited_transcript.md` | AI-refined version (if editing enabled) |

## Settings

Open **Settings → Obsidian AI Transcriber**:

| Section | Options |
|---------|---------|
| **Transcriber** | Provider (OpenAI / Gemini), API key, model, prompt, temperature, audio & transcript directories |
| **Editor** | Enable/disable, provider, API key, model, system prompt templates, user prompt, temperature, keep original toggle |
| **Participants** | Manage participant list (name, org, intro) for meeting context |
| **Templates** | Create, edit, delete, import/export system prompt templates |

## Architecture

```
Audio Input
    │
    ▼
┌─────────────────────────┐
│   Audio Preprocessing   │
│  decode → resample 16kHz│
│  → trim silence → chunk │
│  at silence boundaries  │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│   TranscriberService    │
│  OpenAI Whisper / Gemini│
│  parallel chunk upload  │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│    EditorService        │
│  Stage 1: Summary       │
│  Stage 2: Format (∥)    │
│  streaming file output  │
└────────┬────────────────┘
         │
         ▼
   Markdown Note
```

### Key Technical Details

- **Intelligent Chunking** — Audio is split at silence boundaries to avoid cutting mid-speech.
- **Parallel Processing** — Transcript chunks are formatted concurrently for speed.
- **AbortController** — All AI tasks support cancellation via a shared abort signal.
- **Web Worker** — CPU-heavy audio processing (trim/split) offloaded when available.
- **Streaming Writes** — Edited output is flushed to disk incrementally.

## Development

```bash
# Install dependencies
npm install

# Development with watch mode
npm run dev

# Production build (tsc + esbuild)
npm run build
```

### Project Structure

```
obsidian-ai-transcriber/
├── main.ts                  # Plugin entry, commands, ribbon, status bar
├── src/
│   ├── i18n.ts              # Internationalization (en/zh)
│   ├── services/
│   │   ├── transcriber.ts   # Audio transcription (OpenAI/Gemini)
│   │   ├── editor.ts        # Two-stage AI editing with streaming
│   │   ├── recorder.ts      # MediaRecorder with visualization
│   │   └── file.ts          # File I/O and directory management
│   ├── settings/
│   │   ├── types.ts         # TypeScript interfaces & defaults
│   │   └── settingsTab.ts   # Settings UI
│   └── ui/
│       ├── recordModal.ts                        # Recording modal
│       ├── ParticipantModal.ts                   # Participant editor
│       └── SystemPromptTemplateSelectionModal.ts # Template picker
├── styles.css               # UI styling
├── manifest.json            # Obsidian plugin metadata
└── package.json             # Dependencies and scripts
```

## Requirements

- Obsidian 1.8.0+
- API key for OpenAI or Google Gemini

## License

[Dynalist License](LICENSE)

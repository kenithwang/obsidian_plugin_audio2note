# Obsidian AI Transcriber

An Obsidian plugin that uses AI to record and transcribe audio into structured Markdown notes, with optional AI-based editing of transcripts.

## Features

- 🎤 **Record Audio**: Open a modal or click the ribbon icon to record audio within Obsidian.
- 🤖 **AI Transcription**: Transcribe recorded or imported audio files (`.webm`, `.m4a`, `.mp3`) to text using OpenAI or Gemini models. When using Gemini, audio is preprocessed and compressed to MP3 before upload for faster transcription.
- ✍️ **AI Editing** (optional): Automatically refine raw transcripts into structured notes (e.g., meeting minutes). Utilizes a customizable System Prompt via a template management system.
- 🎨 **System Prompt Templates**: Create, manage, and select different system prompts for the AI Editor to handle various transcript processing needs.
- 💾 **Flexible File Saving**: Save raw and/or edited transcripts to specified vault subdirectories.
- ⚙️ **Settings Tab**: Configure transcription and editing providers, models, API keys, manage System Prompt templates, set editor user prompt, temperature, and output directories.
- 🔄 **Context Menu**: Right-click an audio file in the file explorer to transcribe it directly.
- 📊 **Status Bar**: View plugin status (Idle, Recording…, Transcribing…, Editing…) in the status bar (bottom-right corner).

## Installation

1. Create a folder named `obsidian-ai-transcriber` in your vault's plugins directory: `YourVault/.obsidian/plugins/obsidian-ai-transcriber`
2. Copy the main.js, manifest.json, and styles.css files to the plugin folder
3. Reload Obsidian and enable the plugin in Settings

## Usage

### Recording Audio

- Click the microphone icon in the left ribbon or run the **"Record Audio"** command from the command palette.
- In the record modal, start recording. When done, you can choose:
    - **Stop & Save**: Saves the audio file to the configured "Audio Directory" without transcribing.
    - **Stop & Transcribe**: Saves the audio file and proceeds to transcription.
        - If AI Editing is enabled in settings, a modal will first appear asking you to select a System Prompt Template.
        - If you cancel template selection, only the audio file is saved, and transcription is aborted.
        - If confirmed, the audio is transcribed, and then the transcript is processed by the AI editor using the selected template.

### Transcribing Existing Audio Files

- Right-click any `.webm`, `.m4a`, or `.mp3` file in the file explorer.
- Select **"Transcribe with AI"**.
    - If AI Editing is enabled in settings, a modal will first appear asking you to select a System Prompt Template.
    - If you cancel template selection, the entire transcription task is aborted.
    - If confirmed, the audio is transcribed, and then the transcript is processed by the AI editor using the selected template.
    - If AI Editing is disabled, the audio is transcribed, and the raw transcript is saved.

### Editing Existing Transcripts

- Open a raw transcript file (typically a `.md` file).
- Run the **"Edit Current Transcript with AI"** command from the command palette.
    - A modal will appear asking you to select a System Prompt Template to use for editing.
    - If you cancel template selection, the editing process is aborted.
    - If confirmed, the AI editor will process the current text using the selected template.
- The plugin will then use the configured AI editor settings and the selected System Prompt to process and refine the transcript.

### Transcript Output

- Raw transcript: saved as `<audio_basename>_raw_transcript.md`
- Edited transcript: saved as `<audio_basename>_edited_transcript.md` (if AI Editing is enabled)
- Files are written to the **Transcript Directory** configured in settings.

## Settings

Open **Settings → Obsidian AI Transcriber** to configure:

- **Transcriber Settings**:
  - Provider: `openai` or `gemini`
  - API Key: your service key
  - Model: transcription model (e.g., `gpt-4o-transcribe`)
  - Prompt: custom system prompt for transcription (this is separate from the editor's system prompts)
  - Temperature: sampling temperature
  - Audio Directory: where to save recorded audio
  - Transcript Directory: vault subfolder for transcripts

- **Editor Settings**:
  - Enable Editing: toggle AI post-editing.
  - Provider / API Key / Model: settings for the AI editor.
  - **System Prompt Templates**:
    - **System Prompt Selector**: Choose the currently active template for general use (when not explicitly selected before an action).
    - **System Prompt Template Name**: Edit the name of the selected custom template (the "Default" template name cannot be changed).
    - **System Prompt**: Edit the content of the selected template.
    - **Delete Template**: Delete the currently selected custom template.
    - **New System Prompt Template**: Create new custom templates.
  - **User Prompt**: Specify user-level instructions for the editor (this prompt is sent along with the selected system prompt and the transcript).
  - Temperature: sampling temperature for the editor.
  - Keep Original: save the raw transcript alongside the edited version.

## Development

### Prerequisites
- Node.js 16+
- npm

### Setup
```bash
git clone <repository-url>
cd obsidian-ai-transcriber
npm install
```

### Commands
```bash
npm run dev     # Start development with watch mode
npm run build   # Production build with type checking
npm run version # Bump version number
```

### Building
The build process:
1. Runs TypeScript type checking (`tsc -noEmit`)
2. Bundles with ESBuild
3. Outputs `main.js`

## Project Structure

```
obsidian-ai-transcriber/
├── main.ts                 # Plugin entry point, commands, ribbon
├── src/
│   ├── services/
│   │   ├── transcriber.ts  # Audio transcription (OpenAI/Gemini)
│   │   ├── editor.ts       # AI post-processing of transcripts
│   │   ├── recorder.ts     # MediaRecorder wrapper with visualization
│   │   └── file.ts         # File I/O operations
│   ├── settings/
│   │   ├── types.ts        # TypeScript interfaces
│   │   └── settingsTab.ts  # Settings UI
│   └── ui/
│       ├── recordModal.ts  # Recording modal with waveform
│       └── SystemPromptTemplateSelectionModal.ts
├── styles.css              # UI styling
├── manifest.json           # Plugin metadata
├── package.json            # Dependencies and scripts
└── tsconfig.json           # TypeScript configuration
```

## Architecture

### Services

**RecorderService** (`src/services/recorder.ts`)
- Wraps browser MediaRecorder API
- Manages recording lifecycle (start/pause/resume/stop)
- Provides real-time audio analysis callback for waveform visualization
- Tracks total paused time for accurate duration calculation

**TranscriberService** (`src/services/transcriber.ts`)
- Handles audio transcription with OpenAI or Gemini
- Preprocessing pipeline: decode → resample to 16kHz mono → trim silence → chunk
- OpenAI: Chunks at 10-minute intervals (25MB limit per request)
- Gemini: Chunks at 8-hour intervals with file upload API
- Intelligent chunking at silence boundaries to avoid splitting speech

**EditorService** (`src/services/editor.ts`)
- Post-processes transcripts using chat completion APIs
- Applies system prompts and user instructions
- Supports both OpenAI and Gemini providers

**FileService** (`src/services/file.ts`)
- Manages file creation with timestamped names
- Handles directory creation and conflict resolution
- Saves audio blobs and text transcripts

### Audio Processing Pipeline

1. **Decode**: Convert audio blob to raw PCM data using Web Audio API
2. **Resample**: Convert to 16kHz mono WAV format
3. **Silence Detection**: Identify quiet sections in audio
4. **Trim**: Remove leading/trailing silence
5. **Chunk**: Split at silence boundaries (avoids cutting speech)
6. **Transcribe**: Send chunks to AI provider
7. **Concatenate**: Merge transcription results

### Key Technical Details

- **Web Audio API**: Used for recording, audio analysis (waveform), and preprocessing
- **MediaRecorder API**: Browser API for capturing audio input
- **Automatic Resampling**: All audio is converted to 16kHz mono for consistent transcription
- **Silence-Aware Chunking**: Large files are split at natural pauses to maintain transcript quality
- **Resource Cleanup**: Proper disposal of AudioContext and MediaStream resources

## Dependencies

| Package | Purpose |
|---------|---------|
| `openai` | OpenAI API (Whisper transcription, chat completion) |
| `@google/genai` | Google Gemini API |
| `obsidian` | Obsidian plugin SDK |

## Requirements

- Obsidian 1.8.0+
- Desktop or Mobile
- API key for OpenAI or Google Gemini

## License

This plugin is released under the [Dynalist License](LICENSE).

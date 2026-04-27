export interface TranscriberSettings {
	provider: 'openai' | 'gemini';
	apiKey: string;
	model: string;
	prompt: string;
	temperature: number;
	audioDir: string;
	transcriptDir: string;
	/**
	 * For Gemini uploads: when true, always preprocess to WAV chunks for best quality.
	 * When false, upload original compressed audio for speed (unless too large).
	 */
	preferQualityWav: boolean;
}

export interface SystemPromptTemplate {
	name: string;
	prompt: string;
}

export interface Participant {
	id: string;
	name: string;
	org: string;
	intro: string;
}

export interface EditorSettings {
	enabled: boolean;
	provider: 'openai' | 'gemini';
	apiKey: string;
	model: string;
	participants: Participant[];
	systemPromptTemplates: SystemPromptTemplate[];
	activeSystemPromptTemplateName: string;
	userPrompt: string;
	temperature: number;
	keepOriginal: boolean;
}

export interface DiarizationSettings {
	mode: 'gemini' | 'local-python';
	fallbackToLlm: boolean;
}

export interface PluginSettings {
	transcriber: TranscriberSettings;
	editor: EditorSettings;
	diarization: DiarizationSettings;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	transcriber: {
		provider: 'openai',
		apiKey: '',
		model: 'gpt-4o-transcribe',
		prompt: '',
		temperature: 0.2,
		audioDir: '',
		transcriptDir: '',
		preferQualityWav: true,
	},
	editor: {
		enabled: true,
		provider: 'gemini',
		apiKey: '',
		model: 'gemini-2.5-pro-preview-06-05',
		participants: [],
		systemPromptTemplates: [
			{
				name: 'Default',
				prompt: "You are a professional meeting-minutes generation assistant. Upon receiving the user's raw transcript, output a structured Markdown document **strictly** according to the following requirements—and ensure that the language you use matches the language of the raw transcript.\n\n1. **Format**\n\n   - Divide into three sections with level-2 headings:\n```\n## 📝 Summary\n## ✨ Key Points\n## 📄 Transcript\n```\n   - In **Summary**, use 200–300 words to distill the core conclusions.\n   - In **Key Points**, list 5–10 concise bullet points (Markdown list).\n   - In **Transcript**\n\t   1. Remove all filler (“um,” “uh”), stammers, repetitions, and meaningless padding.\n\t   2. Break into paragraphs **at every speaker change** or **every 4–5 sentences** (no paragraph longer than ~200 words).\n\t   3. Use a blank line to separate each paragraph.\n\n2. **Content Requirements**\n\n   - Do **not** add any new information or commentary—only refine and reorganize what's in the original.\n   - Preserve full semantic integrity; do **not** alter facts.\n\n3. **Output Requirements**\n\n   - **Start** directly with `## 📝 Summary` and output **only** the structured Markdown—no leading prompts, explanations, acknowledgments, or dialogue.\n\n4. **Example Structure**\n```markdown\n## 📝 Summary\n(200–300 words)\n\n## ✨ Key Points\n- Point 1\n- Point 2\n…\n\n## 📄 Transcript\nParagraph 1\n\nParagraph 2\n\n…\n```"
			}
		],
		activeSystemPromptTemplateName: 'Default',
		userPrompt: "Here's the transcript:\n\n",
		temperature: 0.3,
		keepOriginal: true,
	},
	diarization: {
		mode: 'gemini',
		fallbackToLlm: true,
	},
};

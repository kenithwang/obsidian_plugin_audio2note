import { App, PluginSettingTab, Setting, Modal, TextComponent, TextAreaComponent, Notice, ButtonComponent } from 'obsidian';
import ObsidianAITranscriber from '../../main';
import { ApiProvider, PluginSettings, SystemPromptTemplate } from './types';
import { SidecarStatus } from '../services/sidecar';
import { t } from '../i18n';

export default class SettingsTab extends PluginSettingTab {
	plugin: ObsidianAITranscriber;
	private draftSettings: PluginSettings | null = null;
	private saveButton: ButtonComponent | null = null;
	private hasUnsavedChanges = false;
	private isSaving = false;

	constructor(app: App, plugin: ObsidianAITranscriber) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private cloneSettings(settings: PluginSettings): PluginSettings {
		return JSON.parse(JSON.stringify(settings)) as PluginSettings;
	}

	private get settings(): PluginSettings {
		if (!this.draftSettings) {
			this.draftSettings = this.cloneSettings(this.plugin.settings);
		}
		return this.draftSettings;
	}

	private markDirty(): void {
		this.hasUnsavedChanges = true;
		this.updateSaveButton();
	}

	private updateSaveButton(): void {
		if (!this.saveButton) return;
		this.saveButton.setButtonText(this.isSaving ? 'Saving...' : 'Save Settings');
		this.saveButton.setDisabled(this.isSaving);
		if (!this.isSaving) {
			this.saveButton.setDisabled(!this.hasUnsavedChanges);
		}
	}

	private async handleSaveClick(): Promise<void> {
		if (!this.hasUnsavedChanges || this.isSaving || !this.draftSettings) return;

		this.isSaving = true;
		this.updateSaveButton();
		try {
			this.plugin.settings = this.cloneSettings(this.draftSettings);
			await this.plugin.saveSettings();
			await this.plugin.refreshDiarizationStatusBar();
			this.draftSettings = this.cloneSettings(this.plugin.settings);
			this.hasUnsavedChanges = false;
			new Notice('Settings saved.');
		} catch (error: unknown) {
			console.error('[AI Transcriber] Failed to save settings:', error);
			new Notice(`Failed to save settings: ${(error as Error).message}`);
		} finally {
			this.isSaving = false;
			this.updateSaveButton();
		}
	}

	private renderSaveButton(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Settings')
			.setDesc('Changes are written to disk only after you click Save Settings.')
			.addButton(button => {
				this.saveButton = button;
				button
					.setButtonText('Save Settings')
					.setCta()
					.onClick(() => {
						void this.handleSaveClick();
					});
				this.updateSaveButton();
			});
	}

	private formatDiarizationStatus(status: SidecarStatus): string {
		if (status.code === 'configured') {
			const python = status.config?.pythonPath ? `\nPython: ${status.config.pythonPath}` : '';
			return `${t('diarizationStatusConfigured')}${python}`;
		}
		if (status.code === 'not_configured') {
			return t('diarizationStatusNotConfigured');
		}
		return t('diarizationStatusError', { message: status.error || status.message });
	}

	private getProviderDescription(): string {
		return 'Choose OpenAI, Gemini, or OpenRouter';
	}

	private addProviderOptions(dropdown: { addOption: (value: string, display: string) => unknown }): void {
		dropdown.addOption('openai', 'OpenAI');
		dropdown.addOption('gemini', 'Gemini');
		dropdown.addOption('openrouter', 'OpenRouter');
	}

	private getTranscriberModelPlaceholder(provider: ApiProvider): string {
		if (provider === 'openrouter') {
			return 'Example: google/gemini-3.5-flash';
		}
		if (provider === 'gemini') {
			return 'Example: gemini-2.5-flash';
		}
		return 'Example: gpt-4o-transcribe';
	}

	private getEditorModelPlaceholder(provider: ApiProvider): string {
		if (provider === 'openrouter') {
			return 'Example: google/gemini-3.5-flash';
		}
		if (provider === 'gemini') {
			return 'Example: gemini-2.5-flash';
		}
		return 'Example: gpt-4o';
	}

	private renderDiarizationSettings(containerEl: HTMLElement): void {
		const settings = this.settings;
		containerEl.createEl('h2', { text: t('diarizationSettingsTitle') });

		new Setting(containerEl)
			.setName('Speaker diarization mode')
			.setDesc('Gemini cloud mode does not download local Python, PyTorch, or Hugging Face models.')
			.addDropdown(dropdown => dropdown
				.addOption('gemini', 'Gemini cloud (recommended)')
				.addOption('local-python', 'Local pyannote sidecar (experimental)')
				.setValue(settings.diarization.mode)
				.onChange(value => {
					settings.diarization.mode = value as 'gemini' | 'local-python';
					this.markDirty();
					this.display();
				}));

		if (settings.diarization.mode === 'gemini') {
			new Setting(containerEl)
				.setName(t('diarizationStatusName'))
				.setDesc('Configured: Gemini two-phase speaker timeline is used when Gemini is selected. Participants and meeting context are optional hints.');
			return;
		}

		const statusSetting = new Setting(containerEl)
			.setName(t('diarizationStatusName'))
			.setDesc(t('diarizationStatusChecking'));
		let authToken = '';

		const refreshStatus = async () => {
			const status = await this.plugin.sidecarService.getStatus();
			statusSetting.setDesc(this.formatDiarizationStatus(status));
			if (status.config?.authToken && !authToken) {
				authToken = status.config.authToken;
			}
		};

		new Setting(containerEl)
			.setName(t('diarizationAuthTokenName'))
			.setDesc(t('diarizationAuthTokenDesc'))
			.addText(text => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder(t('diarizationAuthTokenPlaceholder'))
					.onChange(value => {
						authToken = value;
					});

				void this.plugin.sidecarService.getLocalConfig().then(config => {
					if (config?.authToken) {
						authToken = config.authToken;
						text.setValue(config.authToken);
					}
				});
			});

		new Setting(containerEl)
			.setName(t('diarizationSetupButton'))
			.setDesc(t('diarizationSetupDesc'))
			.addButton(button =>
				button
					.setButtonText(t('diarizationSetupButton'))
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						try {
							statusSetting.setDesc(t('diarizationStatusSettingUp'));
							const status = await this.plugin.sidecarService.configure({
								authToken,
								onProgress: message => {
									statusSetting.setDesc(`${t('diarizationStatusSettingUp')}\n${message}`);
								},
							});
							await this.plugin.refreshDiarizationStatusBar(status);
							statusSetting.setDesc(this.formatDiarizationStatus(status));
							new Notice(
								status.code === 'configured'
									? t('diarizationConfiguredNotice')
									: t('diarizationStatusError', { message: status.error || status.message }),
							);
						} finally {
							button.setDisabled(false);
						}
					})
			)
			.addButton(button =>
				button
					.setButtonText(t('diarizationTestButton'))
					.onClick(async () => {
						button.setDisabled(true);
						try {
							statusSetting.setDesc(t('diarizationStatusTesting'));
							const status = await this.plugin.sidecarService.testConnection(message => {
								statusSetting.setDesc(`${t('diarizationStatusTesting')}\n${message}`);
							});
							await this.plugin.refreshDiarizationStatusBar(status);
							statusSetting.setDesc(this.formatDiarizationStatus(status));
							new Notice(
								status.code === 'configured'
									? t('diarizationTestSuccessNotice')
									: t('diarizationStatusError', { message: status.error || status.message }),
							);
						} finally {
							button.setDisabled(false);
						}
					})
			)
			.addButton(button =>
				button
					.setButtonText(t('diarizationResetButton'))
					.setWarning()
					.onClick(async () => {
						button.setDisabled(true);
						try {
							await this.plugin.sidecarService.resetLocalConfig();
							await refreshStatus();
							new Notice(t('diarizationResetNotice'));
						} finally {
							button.setDisabled(false);
						}
					})
			);

		void refreshStatus();
	}

	private ensureUniqueTemplateName(name: string, existing: Set<string>): string {
		let candidate = name.trim() || 'Imported Template';
		if (!existing.has(candidate)) return candidate;
		let i = 1;
		while (existing.has(`${candidate} (${i})`)) {
			i++;
		}
		return `${candidate} (${i})`;
	}

	private exportTemplates(): void {
		const settings = this.settings;
		const payload = {
			version: 1,
			activeTemplateName: settings.editor.activeSystemPromptTemplateName,
			templates: settings.editor.systemPromptTemplates,
		};
		const json = JSON.stringify(payload, null, 2);
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const filename = `ai-transcriber-templates-${timestamp}.json`;
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = filename;
		anchor.click();
		URL.revokeObjectURL(url);
		new Notice(t('noticeTemplatesExported', { filename }));
	}

	private async importTemplatesFromFile(): Promise<void> {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json,application/json';

		const file = await new Promise<File | null>(resolve => {
			input.onchange = () => resolve(input.files?.[0] ?? null);
			input.click();
		});

		if (!file) return;

		let rawText = '';
		try {
			rawText = await file.text();
		} catch {
			new Notice(t('noticeTemplateImportReadFailed'));
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(rawText);
		} catch {
			new Notice(t('noticeTemplateImportInvalid'));
			return;
		}

		const importData = (() => {
			if (Array.isArray(parsed)) {
				return {
					activeTemplateName: undefined,
					templates: parsed,
				};
			}
			if (
				parsed &&
				typeof parsed === 'object' &&
				Array.isArray((parsed as { templates?: unknown }).templates)
			) {
				return {
					activeTemplateName: (parsed as { activeTemplateName?: unknown }).activeTemplateName,
					templates: (parsed as { templates: unknown[] }).templates,
				};
			}
			return null;
		})();

		if (!importData) {
			new Notice(t('noticeTemplateImportInvalid'));
			return;
		}

		const settings = this.settings;
		const existingNames = new Set(settings.editor.systemPromptTemplates.map(template => template.name));

		const imported: SystemPromptTemplate[] = [];
		for (const item of importData.templates) {
			if (!item || typeof item !== 'object') continue;
			const candidate = item as { name?: unknown; prompt?: unknown };
			if (typeof candidate.prompt !== 'string') continue;
			const baseName = typeof candidate.name === 'string' ? candidate.name : 'Imported Template';
			const uniqueName = this.ensureUniqueTemplateName(baseName, existingNames);
			existingNames.add(uniqueName);
			imported.push({
				name: uniqueName,
				prompt: candidate.prompt,
			});
		}

		if (!imported.length) {
			new Notice(t('noticeTemplateImportEmpty'));
			return;
		}

		settings.editor.systemPromptTemplates.push(...imported);
		if (
			typeof importData.activeTemplateName === 'string' &&
			imported.some(template => template.name === importData.activeTemplateName)
		) {
			settings.editor.activeSystemPromptTemplateName = importData.activeTemplateName;
		} else if (!settings.editor.activeSystemPromptTemplateName) {
			settings.editor.activeSystemPromptTemplateName = imported[0].name;
		}

		this.markDirty();
		new Notice(t('noticeTemplateImportSuccess', { count: imported.length }));
		this.display();
	}

	hide(): void {
		this.draftSettings = null;
		this.hasUnsavedChanges = false;
		this.saveButton = null;
		super.hide();
	}

	private getActiveTemplate(): SystemPromptTemplate | undefined {
		const settings = this.settings;
		const activeName = settings.editor.activeSystemPromptTemplateName;
		if (!settings.editor.systemPromptTemplates) {
			settings.editor.systemPromptTemplates = []; // Initialize if undefined
		}

		// Only create Default template if the array is completely empty (new user)
		if (settings.editor.systemPromptTemplates.length === 0) {
			settings.editor.systemPromptTemplates.push({
				name: 'Default',
				prompt: "You are a professional meeting-minutes generation assistant. Upon receiving the user's raw transcript, output a structured Markdown document **strictly** according to the following requirements—and ensure that the language you use matches the language of the raw transcript.\n\n1. **Format**\n\n   - Divide into three sections with level-2 headings:\n```\n## 📝 Summary\n## ✨ Key Points\n## 📄 Transcript\n```\n   - In **Summary**, use 200–300 words to distill the core conclusions.\n   - In **Key Points**, list 5–10 concise bullet points (Markdown list).\n   - In **Transcript**\n\t   1. Remove all filler (\"um,\" \"uh\"), stammers, repetitions, and meaningless padding.\n\t   2. Break into paragraphs **at every speaker change** or **every 4–5 sentences** (no paragraph longer than ~200 words).\n\t   3. Use a blank line to separate each paragraph.\n\n2. **Content Requirements**\n\n   - Do **not** add any new information or commentary—only refine and reorganize what's in the original.\n   - Preserve full semantic integrity; do **not** alter facts.\n\n3. **Output Requirements**\n\n   - **Start** directly with `## 📝 Summary` and output **only** the structured Markdown—no leading prompts, explanations, acknowledgments, or dialogue.\n\n4. **Example Structure**\n```markdown\n## 📝 Summary\n(200–300 words)\n\n## ✨ Key Points\n- Point 1\n- Point 2\n…\n\n## 📄 Transcript\nParagraph 1\n\nParagraph 2\n\n…\n```"
			});
			settings.editor.activeSystemPromptTemplateName = 'Default';
		}

		let template = settings.editor.systemPromptTemplates.find(t => t.name === activeName);
		if (!template && settings.editor.systemPromptTemplates.length > 0) {
			// If active template not found, default to the first one in the array
			settings.editor.activeSystemPromptTemplateName = settings.editor.systemPromptTemplates[0].name;
			template = settings.editor.systemPromptTemplates[0];
		}
		return template;
	}

	display(): void {
		const settings = this.settings;
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('ai-transcriber-settings');
		this.saveButton = null;

		// Ensure systemPromptTemplates and activeSystemPromptTemplateName are initialized
		if (!settings.editor.systemPromptTemplates) {
			settings.editor.systemPromptTemplates = [];
		}
		// Initialize templates and set active template if needed
		this.getActiveTemplate();
		this.renderSaveButton(containerEl);

		// Transcriber Settings
		containerEl.createEl('h2', { text: '🎙️ Transcriber Settings' });
		new Setting(containerEl)
			.setName('API Provider')
			.setDesc(this.getProviderDescription())
			.addDropdown(drop => {
				this.addProviderOptions(drop);
				drop.setValue(settings.transcriber.provider)
				.onChange((value) => {
					settings.transcriber.provider = value as ApiProvider;
					this.markDirty();
					this.display(); // Refresh to show conditional fields if any
				});
			});
		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Transcriber API Key')
			.addText(text => {
				text.inputEl.type = 'password';
					text.setPlaceholder('Your API Key')
						.setValue(settings.transcriber.apiKey)
						.onChange((value) => {
							settings.transcriber.apiKey = value;
							this.markDirty();
						});
				});
		new Setting(containerEl)
			.setName('Model Name')
			.setDesc('Specify the model to use for transcription.')
			.addText(text => text
				.setPlaceholder(this.getTranscriberModelPlaceholder(settings.transcriber.provider))
				.setValue(settings.transcriber.model)
				.onChange((value) => {
					settings.transcriber.model = value;
					this.markDirty();
				})
			);
		new Setting(containerEl)
			.setName('Prompt')
			.setDesc('Optional: Add words with their correct spellings to help with transcription.')
			.addTextArea(textArea => textArea
				.setPlaceholder('Clarify uncommon words or phrases in the transcript.')
				.setValue(settings.transcriber.prompt)
				.onChange((value) => {
					settings.transcriber.prompt = value;
					this.markDirty();
				})
			);
		new Setting(containerEl)
			.setName('Temperature')
			.setDesc('Enter a value between 0.0 and 1.0. Suggested value: 0.2.')
			.addText(text => text
				.setPlaceholder('0.0-1.0')
				.setValue(settings.transcriber.temperature.toString())
				.onChange((value) => {
					const num = parseFloat(value);
					if (!isNaN(num) && num >= 0 && num <= 1) {
						settings.transcriber.temperature = num;
						this.markDirty();
					}
				})
			);
		new Setting(containerEl)
			.setName('Audio Directory')
			.setDesc('Where to save recordings (relative to vault root)')
			.addText(text => text
				.setPlaceholder('Recordings/')
				.setValue(settings.transcriber.audioDir)
				.onChange((value) => {
					settings.transcriber.audioDir = value;
					this.markDirty();
				})
			);
		new Setting(containerEl)
			.setName('Transcript Directory')
			.setDesc('Where to save transcripts (relative to vault root)')
			.addText(text => text
				.setPlaceholder('Transcripts/')
				.setValue(settings.transcriber.transcriptDir)
				.onChange((value) => {
					settings.transcriber.transcriptDir = value;
					this.markDirty();
				})
			);

		// Gemini upload mode (quality vs speed)
		if (settings.transcriber.provider === 'gemini') {
			new Setting(containerEl)
				.setName('Gemini Upload Mode')
				.setDesc('When enabled, audio is always converted to WAV before uploading for best transcription quality. Disable to upload original compressed audio for faster uploads.')
					.addToggle(toggle => toggle
						.setValue(settings.transcriber.preferQualityWav)
						.onChange((value) => {
							settings.transcriber.preferQualityWav = value;
							this.markDirty();
						})
					);
		}

		this.renderDiarizationSettings(containerEl);

		// Editor Settings
		containerEl.createEl('h2', { text: '✏️ Editor Settings' });
		new Setting(containerEl)
			.setName('Enable Editor')
			.setDesc('Toggle to enable Editor API enhancements')
			.addToggle(toggle => toggle
				.setValue(settings.editor.enabled)
				.onChange((value) => {
					settings.editor.enabled = value;
					this.markDirty();
					this.display(); // Refresh to show/hide editor settings
				})
			);

		if (settings.editor.enabled) {
			new Setting(containerEl)
				.setName('API Provider')
				.setDesc(this.getProviderDescription())
				.addDropdown(drop => {
					this.addProviderOptions(drop);
					drop.setValue(settings.editor.provider)
					.onChange((value) => {
						settings.editor.provider = value as ApiProvider;
						this.markDirty();
						this.display(); // Refresh
					});
				});
			new Setting(containerEl)
				.setName('API Key')
				.setDesc('Editor API Key')
				.addText(text => {
					text.inputEl.type = 'password';
						text.setPlaceholder('Your API Key.')
							.setValue(settings.editor.apiKey)
							.onChange((value) => {
								settings.editor.apiKey = value;
								this.markDirty();
							});
					});
			new Setting(containerEl)
				.setName('Model Name')
				.setDesc('Specify the model to use for editing.')
				.addText(text => text
					.setPlaceholder(this.getEditorModelPlaceholder(settings.editor.provider))
					.setValue(settings.editor.model)
					.onChange((value) => {
						settings.editor.model = value;
						this.markDirty();
					})
				);


			const templates = settings.editor.systemPromptTemplates;
			const activeTemplateName = settings.editor.activeSystemPromptTemplateName;

			// Dropdown for selecting active template
			new Setting(containerEl)
				.setName('System Prompt Selector')
				.setDesc('Select the system prompt template to use.')
				.addDropdown(dropdown => {
					templates.forEach(template => {
						dropdown.addOption(template.name, template.name);
					});
					dropdown.setValue(activeTemplateName)
						.onChange((value) => {
							settings.editor.activeSystemPromptTemplateName = value;
							this.markDirty();
							this.display(); // Re-render to update template name and prompt fields
						});
				});
			
			const currentActiveTemplate = this.getActiveTemplate();

			if (currentActiveTemplate) {
				// Text input for template name (editable if not 'Default')
				new Setting(containerEl)
					.setName('System Prompt Template Name')
					.setDesc(currentActiveTemplate.name === 'Default' ? 'The "Default" template name cannot be changed.' : 'Edit the name of the current template.')
					.addText(text => {
						text
							.setValue(currentActiveTemplate.name)
							.setDisabled(currentActiveTemplate.name === 'Default');

						// Save on blur (when focus is lost)
						text.inputEl.onblur = async (event) => {
							const newName = (event.target as HTMLInputElement).value.trim();
							if (newName && newName !== currentActiveTemplate.name) {
								// Check if newName already exists (excluding the current template itself if its name hasn't effectively changed)
								if (templates.some(t => t.name === newName)) {
									new Notice(`Template name "${newName}" already exists. Please choose a different name.`);
									(event.target as HTMLInputElement).value = currentActiveTemplate.name; // Revert UI to old name
									return;
								}
								currentActiveTemplate.name = newName;
								settings.editor.activeSystemPromptTemplateName = newName;
								this.markDirty();
								this.display(); // Re-render to update dropdown and other fields
							} else if (newName === currentActiveTemplate.name) {
								// If the name is the same (e.g., user clicked in and out), no need to do anything
							} else if (!newName && currentActiveTemplate.name !== 'Default'){
								// If newName is empty and it's not the 'Default' template, revert to old name
								new Notice('Template name cannot be empty.');
								(event.target as HTMLInputElement).value = currentActiveTemplate.name; // Revert UI
							}
						};
						// Optional: Save on Enter key press as well
						text.inputEl.onkeydown = async (event) => {
							if (event.key === 'Enter') {
								text.inputEl.blur(); // Trigger the blur event to save
								event.preventDefault(); // Prevent default Enter behavior (e.g. form submission)
							}
						};
					});

				// TextArea for template prompt
				new Setting(containerEl)
					.setName('System Prompt')
					.setDesc('Specify system-level instructions for the editor for this template.')
					.addTextArea(textArea => {
						textArea
							.setValue(currentActiveTemplate.prompt)
							.onChange((value) => {
								currentActiveTemplate.prompt = value;
								this.markDirty();
							});
						textArea.inputEl.rows = 10;
						textArea.inputEl.style.width = '100%';
						textArea.inputEl.style.minHeight = '150px';
					});

				// Button to delete active template (if not 'Default')
				if (currentActiveTemplate.name !== 'Default') {
					new Setting(containerEl)
						.addButton(button => button
							.setButtonText(`Delete "${currentActiveTemplate.name}" template`)
							.setWarning() // Or setCta() for a more prominent warning
							.onClick(async () => {
								// Confirmation Modal
								const confirmModal = new Modal(this.app);
								confirmModal.contentEl.createEl('h2', {text: 'Confirm Deletion'});
								confirmModal.contentEl.createEl('p', {text: `Are you sure you want to delete the template "${currentActiveTemplate.name}"? This action cannot be undone.`});
								
								new Setting(confirmModal.contentEl)
									.addButton(btn => btn
										.setButtonText('Cancel')
										.onClick(() => confirmModal.close()))
									.addButton(btn => btn
										.setButtonText('Delete')
										.setWarning()
										.onClick(() => {
											settings.editor.systemPromptTemplates = templates.filter(t => t.name !== currentActiveTemplate.name);
											settings.editor.activeSystemPromptTemplateName = 'Default'; // Fallback to Default
											this.markDirty();
											confirmModal.close();
											this.display(); // Re-render
										}));
								confirmModal.open();
							})
						);
				}
			}

			// Button to create a new template
			new Setting(containerEl)
				.setName('New System Prompt Template')
				.setDesc('Add a new template for system prompts.')
				.addButton(button => button
					.setButtonText('Create New Template')
					.onClick(() => {
						new NewTemplateModal(this.app, this.plugin, templates, (result) => {
							if (result) {
								const newTemplate: SystemPromptTemplate = { name: result.name, prompt: result.prompt };
								settings.editor.systemPromptTemplates.push(newTemplate);
								settings.editor.activeSystemPromptTemplateName = newTemplate.name;
								this.markDirty();
								this.display();
							}
						}).open();
					})
				);

			new Setting(containerEl)
				.setName(t('settingsTemplateImportExport'))
				.setDesc(t('settingsTemplateImportExportDesc'))
				.addButton(button => button
					.setButtonText(t('settingsExportTemplates'))
					.onClick(() => this.exportTemplates()))
				.addButton(button => button
					.setButtonText(t('settingsImportTemplates'))
					.onClick(async () => {
						await this.importTemplatesFromFile();
					}));

			// --- End of System Prompt Template Management ---

			new Setting(containerEl)
				.setName('User Prompt')
				.setDesc('Specify user-level instructions for the editor.')
				.addTextArea(textArea => {
						textArea
							.setPlaceholder('')
							.setValue(settings.editor.userPrompt)
							.onChange((value) => {
								settings.editor.userPrompt = value;
								this.markDirty();
							});
					textArea.inputEl.rows = 3;
					textArea.inputEl.style.width = '100%';
				});
			new Setting(containerEl)
				.setName('Temperature')
				.setDesc('Enter a value between 0.0 and 1.0. Suggested value: 0.3.')
				.addText(text => text
					.setPlaceholder('0.0-1.0')
					.setValue(settings.editor.temperature.toString())
					.onChange((value) => {
						const num = parseFloat(value);
						if (!isNaN(num) && num >= 0 && num <= 1) {
							settings.editor.temperature = num;
							this.markDirty();
						}
					})
				);
			new Setting(containerEl)
				.setName('Keep Original Transcript')
				.setDesc('Whether to keep original transcript when editing')
				.addToggle(toggle => toggle
					.setValue(settings.editor.keepOriginal)
					.onChange((value) => {
						settings.editor.keepOriginal = value;
						this.markDirty();
					})
				);
		}
	}
}

class NewTemplateModal extends Modal {
	plugin: ObsidianAITranscriber;
	existingTemplates: SystemPromptTemplate[];
	onSubmit: (result: { name: string, prompt: string } | null) => void;
	nameInput: TextComponent;
	promptInput: TextAreaComponent;

	constructor(
		app: App,
		plugin: ObsidianAITranscriber,
		existingTemplates: SystemPromptTemplate[],
		onSubmit: (result: { name: string, prompt: string } | null) => void
	) {
		super(app);
		this.plugin = plugin;
		this.existingTemplates = existingTemplates;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ai-transcriber-template-editor-modal');
		contentEl.createEl('h2', { text: 'Create New System Prompt Template' });

		let newName = 'New Template';
		let i = 1;
		while (this.existingTemplates.some(t => t.name === newName)) {
			newName = `New Template ${++i}`;
		}
		
		new Setting(contentEl)
			.setName('System Prompt Template Name')
			.addText(text => {
				this.nameInput = text;
				text.setValue(newName)
					.setPlaceholder('Enter template name');
			});

		new Setting(contentEl)
			.setName('System Prompt Template')
			.addTextArea(area => {
				this.promptInput = area;
				area.setValue('')
					.setPlaceholder('Enter system prompt content for this template');
				area.inputEl.rows = 16;
				area.inputEl.style.width = '100%';
				area.inputEl.style.minHeight = '120px';
				area.inputEl.style.resize = 'none';
			});
		
		new Setting(contentEl)
			.addButton(button => button
				.setButtonText('Cancel')
				.onClick(() => {
					this.onSubmit(null);
					this.close();
				}))
			.addButton(button => button
				.setButtonText('Save Template')
				.setCta()
				.onClick(() => {
					const name = this.nameInput.getValue().trim();
					const prompt = this.promptInput.getValue();
					if (!name) {
						new Notice('模板名称不能为空');
						return;
					}
					if (this.existingTemplates.some(t => t.name === name)) {
						new Notice(`模板名称 "${name}" 已存在，请使用其他名称`);
						return;
					}
					this.onSubmit({ name, prompt });
					this.close();
				}));
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
} 

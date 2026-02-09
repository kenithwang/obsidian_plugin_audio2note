import { Editor, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import RecordModal from './src/ui/recordModal';
import { RecorderService } from './src/services/recorder';
import { FileService } from './src/services/file';
import SettingsTab from './src/settings/settingsTab';
import { PluginSettings, DEFAULT_SETTINGS } from './src/settings/types';
import { TranscriberService, TranscriptionProgress } from './src/services/transcriber';
import { EditProgress, EditorService } from './src/services/editor';
import { SystemPromptTemplateSelectionModal } from './src/ui/SystemPromptTemplateSelectionModal';
import { t } from './src/i18n';

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
	webm: 'audio/webm',
	m4a: 'audio/mp4',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	aac: 'audio/aac',
	opus: 'audio/ogg; codecs=opus',
	mp4: 'audio/mp4',
};

const SUPPORTED_AUDIO_EXTENSIONS = new Set(Object.keys(AUDIO_MIME_BY_EXTENSION));

interface ProcessAudioBlobOptions {
	systemPromptOverride?: string;
	context?: string;
	saveRawWhenEditorEnabled?: boolean;
	openResult?: boolean;
}

interface StreamFileWriter {
	push: (content: string) => void;
	flush: () => Promise<void>;
}

export default class ObsidianAITranscriber extends Plugin {
	settings: PluginSettings;
	recorder: RecorderService;
	transcriber: TranscriberService;
	fileService: FileService;
	editorService: EditorService;
	statusBarItem: HTMLElement;
	private statusTextEl: HTMLElement;
	private cancelTaskBtn: HTMLButtonElement;
	private activeTaskController: AbortController | null = null;
	private progressNotice: Notice | null = null;

	async onload() {
		await this.loadSettings();
		this.recorder = new RecorderService();
		this.transcriber = new TranscriberService();
		this.fileService = new FileService(this.app);
		this.editorService = new EditorService();

		this.initStatusBar();
		this.updateStatus(t('statusIdle'));

		this.addRibbonIcon('microphone', 'Record Audio', () => {
			new RecordModal(this.app, this).open();
		}).addClass('obsidian-ai-transcriber-ribbon');

		this.addCommand({
			id: 'obsidian-ai-transcriber-record',
			name: 'Record Audio',
			callback: () => {
				new RecordModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'obsidian-ai-transcriber-edit-transcript',
			name: 'Edit Current Transcript with AI',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const file = view.file;
				if (!file || file.extension !== 'md') {
					new Notice(t('noticePleaseOpenMarkdown'));
					return;
				}

				if (this.isTaskRunning()) {
					new Notice(t('noticeTaskAlreadyRunning'));
					return;
				}

				const originalText = editor.getValue();
				if (!originalText.trim()) {
					new Notice(t('noticeEmptyFile'));
					return;
				}

				if (!this.settings.editor.enabled) {
					new Notice(t('noticeEditorDisabled'));
					return;
				}

				new SystemPromptTemplateSelectionModal(this.app, this, async selection => {
					const selectedTemplateName =
						typeof selection === 'object' && selection ? selection.name : selection;
					const context = typeof selection === 'object' && selection ? selection.context : '';

					if (!selectedTemplateName) {
						new Notice(t('noticeTemplateSelectionCancelledEditing'));
						return;
					}

					const selectedTemplate = this.settings.editor.systemPromptTemplates.find(
						template => template.name === selectedTemplateName,
					);
					if (!selectedTemplate) {
						new Notice(t('noticeTemplateNotFoundEditing'));
						return;
					}

					let signal: AbortSignal;
					try {
						signal = this.beginTask(t('statusEditing'));
					} catch (error) {
						new Notice((error as Error).message);
						return;
					}

					new Notice(t('noticeEditingWithTemplate', { name: selectedTemplateName }));

					try {
						const dir = file.parent ? file.parent.path : this.settings.transcriber.transcriptDir;
						const baseName = file.basename
							.replace(/_raw_transcript$/, '')
							.replace(/_edited_transcript$/, '');

						const editedPath = await this.streamEditToFile(
							originalText,
							dir,
							baseName,
							selectedTemplate.prompt,
							context,
							signal,
						);

						new Notice(t('noticeEditedTranscriptSaved', { path: editedPath }));
						await this.fileService.openFile(editedPath);
					} catch (error: unknown) {
						if (this.isAbortError(error)) {
							new Notice(t('noticeTaskCancelled'));
						} else {
							new Notice(t('noticeErrorEditing', { message: (error as Error).message }));
							console.error('Error editing transcript:', error);
						}
					} finally {
						this.endTask();
					}
				}).open();
			},
		});

		this.addSettingTab(new SettingsTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				const extension = file instanceof TFile ? file.extension.toLowerCase() : '';
				if (!(file instanceof TFile) || !SUPPORTED_AUDIO_EXTENSIONS.has(extension)) {
					return;
				}

				menu.addItem(item => {
					item
						.setTitle('Transcribe with AI')
						.setIcon('microphone')
						.onClick(async () => {
							if (this.isTaskRunning()) {
								new Notice(t('noticeTaskAlreadyRunning'));
								return;
							}

							const processFile = async (systemPromptOverride?: string, context?: string) => {
								const arrayBuffer = await this.app.vault.readBinary(file);
								const mime = this.getMimeTypeForExtension(file.extension);
								const blob = new Blob([arrayBuffer], { type: mime });
								const baseName = file.name.replace(/\.[^/.]+$/, '');
								await this.processAudioBlob(blob, baseName, {
									systemPromptOverride,
									context,
									saveRawWhenEditorEnabled: true,
									openResult: true,
								});
							};

							if (this.settings.editor.enabled) {
								new SystemPromptTemplateSelectionModal(this.app, this, async selection => {
									const selectedTemplateName =
										typeof selection === 'object' && selection ? selection.name : selection;
									const context = typeof selection === 'object' && selection ? selection.context : '';

									if (!selectedTemplateName) {
										new Notice(t('noticeTemplateSelectionCancelledTranscribe'));
										return;
									}

									const selectedTemplate = this.settings.editor.systemPromptTemplates.find(
										template => template.name === selectedTemplateName,
									);
									if (!selectedTemplate) {
										new Notice(t('noticeTemplateNotFoundTranscribe'));
										return;
									}

									await processFile(selectedTemplate.prompt, context);
								}).open();
								return;
							}

							await processFile();
						});
				});
			}),
		);
	}

	/**
	 * Cleanup when the plugin is unloaded.
	 */
	public onunload(): void {
		if (this.activeTaskController && !this.activeTaskController.signal.aborted) {
			this.activeTaskController.abort();
		}
		this.activeTaskController = null;
		this.cancelTaskBtn.style.display = 'none';
		this.clearProgressNotice();
		this.updateStatus(t('statusIdle'));
		void this.transcriber.dispose();
	}

	private initStatusBar(): void {
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass('ai-transcriber-status');
		this.statusTextEl = this.statusBarItem.createSpan();
		this.cancelTaskBtn = this.statusBarItem.createEl('button', {
			text: t('statusCancelButton'),
		});
		this.cancelTaskBtn.style.marginLeft = '8px';
		this.cancelTaskBtn.style.fontSize = '12px';
		this.cancelTaskBtn.style.display = 'none';
		this.cancelTaskBtn.onclick = () => this.cancelActiveTask();
	}

	private beginTask(initialStatus: string): AbortSignal {
		if (this.activeTaskController) {
			throw new Error(t('noticeTaskAlreadyRunning'));
		}
		this.activeTaskController = new AbortController();
		this.cancelTaskBtn.style.display = '';
		this.updateStatus(initialStatus);
		this.updateProgressNotice(initialStatus);
		return this.activeTaskController.signal;
	}

	private endTask(): void {
		this.activeTaskController = null;
		this.cancelTaskBtn.style.display = 'none';
		this.clearProgressNotice();
		this.updateStatus(t('statusIdle'));
	}

	public isTaskRunning(): boolean {
		return this.activeTaskController !== null;
	}

	public cancelActiveTask(): void {
		if (!this.activeTaskController || this.activeTaskController.signal.aborted) return;
		this.activeTaskController.abort();
		this.updateStatus(t('statusCancelled'));
		this.updateProgressNotice(t('statusCancelled'));
		new Notice(t('noticeTaskCancelled'));
	}

	public isAbortError(error: unknown): boolean {
		return (
			(error as Error)?.name === 'AbortError' ||
			((error as Error)?.message ?? '').toLowerCase().includes('aborted')
		);
	}

	private updateProgressNotice(message: string): void {
		if (!this.progressNotice) {
			this.progressNotice = new Notice(message, 0);
			return;
		}
		this.progressNotice.setMessage(message);
	}

	private clearProgressNotice(): void {
		if (!this.progressNotice) return;
		this.progressNotice.hide();
		this.progressNotice = null;
	}

	private getMimeTypeForExtension(extension: string): string {
		return AUDIO_MIME_BY_EXTENSION[extension.toLowerCase()] || '';
	}

	private getTranscriptionProgressText(progress: TranscriptionProgress): string {
		if (progress.stage === 'done') {
			return t('statusTranscribing');
		}
		if (
			progress.stage === 'transcribe' ||
			progress.stage === 'upload' ||
			progress.stage === 'processing'
		) {
			const total = progress.totalChunks ?? 0;
			const current =
				progress.completedChunks && progress.completedChunks > 0
					? progress.completedChunks
					: progress.currentChunk ?? progress.completedChunks ?? 0;
			if (total > 0) {
				return t('statusTranscribingProgress', { current, total });
			}
		}
		return t('statusTranscribing');
	}

	private getEditProgressText(progress: EditProgress): string {
		if (progress.stage === 'summary') {
			return t('statusEditingSummary');
		}
		if (progress.stage === 'transcript') {
			return t('statusEditingTranscript', {
				current: progress.currentChunk ?? 0,
				total: progress.totalChunks ?? 0,
			});
		}
		return t('statusEditing');
	}

	private createStreamFileWriter(path: string, intervalMs = 300): StreamFileWriter {
		let latestContent = '';
		let timer: number | null = null;
		let inFlight = Promise.resolve();

		const flushNow = async () => {
			const content = latestContent;
			await this.fileService.updateText(path, content);
		};

		return {
			push: (content: string) => {
				latestContent = content;
				if (timer !== null) return;
				timer = window.setTimeout(() => {
					timer = null;
					inFlight = inFlight.then(() => flushNow()).catch(error => {
						console.error('[AI Transcriber] Failed to update streamed file content:', error);
					});
				}, intervalMs);
			},
			flush: async () => {
				if (timer !== null) {
					window.clearTimeout(timer);
					timer = null;
				}
				await inFlight;
				await flushNow();
			},
		};
	}

	private async streamEditToFile(
		rawText: string,
		dir: string,
		baseName: string,
		systemPromptOverride: string,
		context: string | undefined,
		signal: AbortSignal,
	): Promise<string> {
		const editedFileName = `${baseName}_edited_transcript.md`;
		const editedPath = await this.fileService.saveTextWithName('', dir, editedFileName);
		const writer = this.createStreamFileWriter(editedPath, 300);
		let finalText: string | null = null;

		try {
			finalText = await this.editorService.editWithTwoStageStreaming(
				rawText,
				this.settings.editor,
				systemPromptOverride,
				context,
				{
					signal,
					onProgress: progress => {
						const message = this.getEditProgressText(progress);
						this.updateStatus(message);
						this.updateProgressNotice(message);
					},
					onPartialText: partial => {
						writer.push(partial);
					},
				},
			);
		} finally {
			try {
				await writer.flush();
			} catch (error) {
				console.error('[AI Transcriber] Failed to flush streamed file content:', error);
			}
		}

		if (finalText === null) {
			throw new Error('Editing failed before producing output.');
		}

		await this.fileService.updateText(editedPath, finalText);
		return editedPath;
	}

	public async processAudioBlob(
		blob: Blob,
		baseName: string,
		options?: ProcessAudioBlobOptions,
	): Promise<{ rawPath?: string; editedPath?: string }> {
		if (this.isTaskRunning()) {
			new Notice(t('noticeTaskAlreadyRunning'));
			return {};
		}

		const signal = this.beginTask(t('statusTranscribing'));
		this.updateProgressNotice(t('noticeTranscribingAudio'));

		const {
			systemPromptOverride,
			context,
			saveRawWhenEditorEnabled = true,
			openResult = true,
		} = options || {};

		let rawPath: string | undefined;
		let editedPath: string | undefined;

		try {
			const transcript = await this.transcriber.transcribe(blob, this.settings.transcriber, {
				context,
				signal,
				onProgress: progress => {
					const message = this.getTranscriptionProgressText(progress);
					this.updateStatus(message);
					this.updateProgressNotice(message);
				},
			});

			const dir = this.settings.transcriber.transcriptDir;
			const shouldEdit = this.settings.editor.enabled && systemPromptOverride !== undefined;

			if (!shouldEdit || saveRawWhenEditorEnabled) {
				const rawFileName = `${baseName}_raw_transcript.md`;
				rawPath = await this.fileService.saveTextWithName(transcript, dir, rawFileName);
				new Notice(t('noticeRawTranscriptSaved', { path: rawPath }));
			}

			if (shouldEdit) {
				this.updateStatus(t('statusEditing'));
				this.updateProgressNotice(t('statusEditing'));
				new Notice(t('noticeEditingWithSelectedTemplate'));

				editedPath = await this.streamEditToFile(
					transcript,
					dir,
					baseName,
					systemPromptOverride!,
					context,
					signal,
				);
				new Notice(t('noticeEditedTranscriptSaved', { path: editedPath }));

				if (openResult) {
					await this.fileService.openFile(editedPath);
				}
			} else if (rawPath && openResult) {
				await this.fileService.openFile(rawPath);
			}

			return { rawPath, editedPath };
		} catch (error: unknown) {
			if (this.isAbortError(error)) {
				new Notice(t('noticeTaskCancelled'));
			} else {
				new Notice(t('noticeError', { message: (error as Error).message }));
				console.error('[AI Transcriber] Processing audio failed:', error);
			}
			return { rawPath, editedPath };
		} finally {
			this.endTask();
		}
	}

	/**
	 * Load plugin settings from disk.
	 * 使用深度合并确保新增的嵌套属性不会丢失
	 */
	public async loadSettings(): Promise<void> {
		const savedData = await this.loadData();
		this.settings = {
			transcriber: { ...DEFAULT_SETTINGS.transcriber, ...savedData?.transcriber },
			editor: {
				...DEFAULT_SETTINGS.editor,
				...savedData?.editor,
				participants: savedData?.editor?.participants ?? DEFAULT_SETTINGS.editor.participants,
				systemPromptTemplates:
					savedData?.editor?.systemPromptTemplates ??
					DEFAULT_SETTINGS.editor.systemPromptTemplates,
			},
		};
	}

	/**
	 * Save plugin settings to disk.
	 */
	public async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Update the status bar text to reflect current plugin state.
	 */
	public updateStatus(status: string): void {
		this.statusTextEl.setText(status);
	}
}

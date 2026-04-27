import { Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import RecordModal from './src/ui/recordModal';
import { RecorderService } from './src/services/recorder';
import { FileService } from './src/services/file';
import SettingsTab from './src/settings/settingsTab';
import { PluginSettings, DEFAULT_SETTINGS } from './src/settings/types';
import { TranscriberService, TranscriptionProgress } from './src/services/transcriber';
import { EditProgress, EditorService } from './src/services/editor';
import { DiarizationSegment, SidecarService, SidecarStatus, SpeakerAnalysis } from './src/services/sidecar';
import { SystemPromptTemplateSelectionModal } from './src/ui/SystemPromptTemplateSelectionModal';
import { SPEAKER_MAPPING_VIEW_TYPE, SpeakerMappingView, SpeakerMappingViewState } from './src/ui/SpeakerMappingView';
import {
	createDefaultSpeakerMapping,
	prepareSpeakerMappingSession,
} from './src/services/speakerMapping';
import { Participant } from './src/settings/types';
import { VoiceProfileService } from './src/services/voiceProfiles';
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
	participants?: Participant[];
	saveRawWhenEditorEnabled?: boolean;
	openResult?: boolean;
}

interface StreamFileWriter {
	push: (content: string) => void;
	flush: () => Promise<void>;
}

function formatTimestamp(seconds: number): string {
	const safeSeconds = Math.max(0, seconds);
	const totalSeconds = Math.floor(safeSeconds);
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	if (h > 0) {
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default class ObsidianAITranscriber extends Plugin {
	settings: PluginSettings;
	recorder: RecorderService;
	transcriber: TranscriberService;
	fileService: FileService;
	editorService: EditorService;
	sidecarService: SidecarService;
	voiceProfileService: VoiceProfileService;
	statusBarItem: HTMLElement;
	private statusTextEl: HTMLElement;
	private diarizationStatusBarItem: HTMLElement;
	private cancelTaskBtn: HTMLButtonElement;
	private activeTaskController: AbortController | null = null;
	private progressNotice: Notice | null = null;
	private latestSpeakerMappingSession: SpeakerMappingViewState | null = null;

	async onload() {
		await this.loadSettings();
		this.recorder = new RecorderService();
		this.transcriber = new TranscriberService();
		this.fileService = new FileService(this.app);
		this.editorService = new EditorService();
		this.sidecarService = new SidecarService(this.app, this.manifest.id);
		this.voiceProfileService = new VoiceProfileService(this.app, this.manifest.id);

		this.initStatusBar();
		this.updateStatus(t('statusIdle'));
		void this.refreshDiarizationStatusBar();

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

		this.registerView(
			SPEAKER_MAPPING_VIEW_TYPE,
			leaf => new SpeakerMappingView(leaf, this),
		);

		this.addCommand({
			id: 'obsidian-ai-transcriber-show-speaker-mapping',
			name: t('speakerMappingShowCommand'),
			callback: async () => {
				await this.showSpeakerMappingPanel(this.latestSpeakerMappingSession ?? undefined);
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

							const processFile = async (
								systemPromptOverride?: string,
								context?: string,
								participants: Participant[] = [],
							) => {
								const arrayBuffer = await this.app.vault.readBinary(file);
								const mime = this.getMimeTypeForExtension(file.extension);
								const blob = new Blob([arrayBuffer], { type: mime });
								const baseName = file.name.replace(/\.[^/.]+$/, '');
								await this.processAudioBlob(blob, baseName, {
									systemPromptOverride,
									context,
									participants,
									saveRawWhenEditorEnabled: true,
									openResult: true,
								});
							};

							if (this.settings.editor.enabled) {
								new SystemPromptTemplateSelectionModal(this.app, this, async selection => {
									const selectedTemplateName =
										typeof selection === 'object' && selection ? selection.name : selection;
									const context = typeof selection === 'object' && selection ? selection.context : '';
									const participants = typeof selection === 'object' && selection ? selection.participants : [];

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

									await processFile(selectedTemplate.prompt, context, participants);
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
		this.diarizationStatusBarItem?.remove();
		this.sidecarService?.stop();
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

		this.diarizationStatusBarItem = this.addStatusBarItem();
		this.diarizationStatusBarItem.addClass('ai-transcriber-diarization-status');
		this.diarizationStatusBarItem.setText('Diarization: checking');
	}

	public async refreshDiarizationStatusBar(status?: SidecarStatus): Promise<SidecarStatus> {
		const resolvedStatus = status ?? await this.sidecarService.getStatus();
		const label =
			resolvedStatus.code === 'configured'
				? 'Configured'
				: resolvedStatus.code === 'error'
					? 'Error'
					: 'Not configured';
		this.diarizationStatusBarItem.setText(`Diarization: ${label}`);
		if (resolvedStatus.error) {
			this.diarizationStatusBarItem.setAttr('title', resolvedStatus.error);
		} else if (resolvedStatus.config?.pythonPath) {
			this.diarizationStatusBarItem.setAttr('title', resolvedStatus.config.pythonPath);
		}
		return resolvedStatus;
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

	private throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted) {
			throw this.createAbortError();
		}
	}

	private createAbortError(): Error {
		try {
			return new DOMException('The operation was aborted.', 'AbortError');
		} catch {
			const err = new Error('The operation was aborted.');
			err.name = 'AbortError';
			return err;
		}
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

	private async showSpeakerMappingPanel(session?: SpeakerMappingViewState): Promise<void> {
		let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(SPEAKER_MAPPING_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) {
				throw new Error('Could not open speaker confirmation panel.');
			}
			await leaf.setViewState({ type: SPEAKER_MAPPING_VIEW_TYPE, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
		if (session) {
			const view = leaf.view;
			if (view instanceof SpeakerMappingView) {
				await view.setSession(session);
			}
		}
	}

	private async confirmSpeakersInRawNote(
		rawPath: string,
		transcript: string,
		participants: Participant[],
		analyses: SpeakerAnalysis[],
		recordingId: string,
		signal: AbortSignal,
	): Promise<string> {
		const session = prepareSpeakerMappingSession(transcript);
		if (!session) {
			return transcript;
		}

		await this.fileService.updateText(rawPath, session.text);
		await this.fileService.openFile(rawPath);

		return new Promise<string>((resolve, reject) => {
			if (signal.aborted) {
				reject(this.createAbortError());
				return;
			}
			const onAbort = () => {
				this.latestSpeakerMappingSession = null;
				reject(this.createAbortError());
			};
			signal.addEventListener('abort', onAbort, { once: true });
			void this.voiceProfileService.suggestMapping(analyses, participants).then(suggestedMapping => {
				if (signal.aborted) {
					reject(this.createAbortError());
					return;
				}
				const viewState: SpeakerMappingViewState = {
					rawPath,
					speakerIds: session.speakerIds,
					participants,
					mapping: {
						...createDefaultSpeakerMapping(session.speakerIds, []),
						...suggestedMapping,
					},
					onConfirm: text => {
						signal.removeEventListener('abort', onAbort);
						this.latestSpeakerMappingSession = null;
						void this.voiceProfileService.learnFromConfirmedMapping(recordingId, analyses, viewState.mapping);
						resolve(text);
					},
				};
				this.latestSpeakerMappingSession = viewState;
				void this.showSpeakerMappingPanel(viewState);
			}).catch(error => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			});
		});
	}

	private async tryAnalyzeSpeakers(blob: Blob, baseName: string, signal: AbortSignal): Promise<SpeakerAnalysis[]> {
		const status = await this.sidecarService.getStatus();
		if (status.code !== 'configured') {
			return [];
		}

		this.throwIfAborted(signal);
		this.updateStatus(t('statusDiarizing'));
		this.updateProgressNotice(t('statusDiarizing'));

		try {
			return await this.sidecarService.analyzeSpeakers(blob, `${baseName}.webm`, message => {
				this.updateProgressNotice(`${t('statusDiarizing')}\n${message}`);
			});
		} catch (error) {
			if (this.isAbortError(error)) throw error;
			console.warn('[AI Transcriber] Local diarization failed, falling back to standard transcription.', error);
			new Notice(t('noticeDiarizationUnavailable'));
			return [];
		}
	}

	private getSegmentsFromAnalyses(analyses: SpeakerAnalysis[]): DiarizationSegment[] {
		return analyses.flatMap(analysis => analysis.segments);
	}

	private buildDiarizationTimeline(segments: DiarizationSegment[]): string {
		if (!segments.length) return '';
		const lines = [
			'### Speaker Timeline',
			'',
			...segments.map(segment => {
				const start = formatTimestamp(segment.start);
				const end = formatTimestamp(segment.end);
				return `[${start} - ${end}] <!-- speaker:${segment.speaker} --> ${segment.speaker}:`;
			}),
		];
		return lines.join('\n');
	}

	private combineDiarizationAndTranscript(segments: DiarizationSegment[], transcript: string): string {
		const timeline = this.buildDiarizationTimeline(segments);
		if (!timeline) return transcript;
		return `${timeline}\n\n---\n\n### ASR Transcript\n\n${transcript.trim()}`;
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
			participants = [],
			saveRawWhenEditorEnabled = true,
			openResult = true,
		} = options || {};

		let rawPath: string | undefined;
		let editedPath: string | undefined;

		try {
			const speakerAnalyses = await this.tryAnalyzeSpeakers(blob, baseName, signal);
			const diarizationSegments = this.getSegmentsFromAnalyses(speakerAnalyses);
			this.updateStatus(t('statusTranscribing'));
			this.updateProgressNotice(t('noticeTranscribingAudio'));

			let transcript = await this.transcriber.transcribe(blob, this.settings.transcriber, {
				context,
				signal,
				onProgress: progress => {
					const message = this.getTranscriptionProgressText(progress);
					this.updateStatus(message);
					this.updateProgressNotice(message);
				},
			});
			transcript = this.combineDiarizationAndTranscript(diarizationSegments, transcript);

			const dir = this.settings.transcriber.transcriptDir;
			const shouldEdit = this.settings.editor.enabled && systemPromptOverride !== undefined;
			const rawFileName = `${baseName}_raw_transcript.md`;

			if (!shouldEdit || saveRawWhenEditorEnabled || prepareSpeakerMappingSession(transcript)) {
				rawPath = await this.fileService.saveTextWithName(transcript, dir, rawFileName);
				new Notice(t('noticeRawTranscriptSaved', { path: rawPath }));
				transcript = await this.confirmSpeakersInRawNote(
					rawPath,
					transcript,
					participants,
					speakerAnalyses,
					baseName,
					signal,
				);
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
			diarization: { ...DEFAULT_SETTINGS.diarization, ...savedData?.diarization },
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

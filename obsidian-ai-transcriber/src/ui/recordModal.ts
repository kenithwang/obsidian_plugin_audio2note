import { App, Modal, Notice } from 'obsidian';
import ObsidianAITranscriber from '../../main';
import { RecorderService, RecordingResult } from '../services/recorder';
import { FileService } from '../services/file';
import { SystemPromptTemplateSelectionModal } from './SystemPromptTemplateSelectionModal';
import { t } from '../i18n';

export default class RecordModal extends Modal {
	private plugin: ObsidianAITranscriber;
	private recorder: RecorderService;
	private fileService: FileService;
	private isPaused = false;
	private timerEl: HTMLElement;
	private intervalId: number;
	private recordBtn: HTMLElement;
	private pauseBtn: HTMLElement;
	private stopBtn: HTMLElement;
	private stopAndSaveBtn: HTMLElement;
	// 音频波形显示相关属性
	private canvasEl: HTMLCanvasElement;
	private canvasCtx: CanvasRenderingContext2D;

	constructor(app: App, plugin: ObsidianAITranscriber) {
		super(app);
		this.plugin = plugin;
		this.recorder = plugin.recorder;
		this.fileService = new FileService(this.app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ai-transcriber-record-modal');
		contentEl.removeClass('is-recording');
		contentEl.removeClass('is-paused');

		const headerEl = contentEl.createDiv({ cls: 'record-header' });
		headerEl.createEl('h2', { text: 'Record Audio' });
		headerEl.createEl('div', { cls: 'record-subtitle', text: 'Start recording and transcribe with AI.' });

		const cardEl = contentEl.createDiv({ cls: 'record-card' });

		// Elapsed time display
		this.timerEl = cardEl.createEl('div', { cls: 'recorder-timer', text: '00:00' });

		// 添加音频波形显示画布
		const waveformWrap = cardEl.createDiv({ cls: 'audio-waveform-wrap' });
		this.canvasEl = waveformWrap.createEl('canvas', { cls: 'audio-waveform' });
		this.canvasEl.width = 300;
		this.canvasEl.height = 100;
		this.canvasCtx = this.canvasEl.getContext('2d')!;

		const actionsEl = contentEl.createDiv({ cls: 'recorder-actions' });
		const buttonContainer = actionsEl.createDiv({ cls: 'recorder-button-container' });

		this.recordBtn = buttonContainer.createEl('button', { text: 'Record', cls: ['mod-cta', 'recorder-btn-record'] });
		this.pauseBtn = buttonContainer.createEl('button', { text: 'Pause', cls: 'recorder-btn-pause' });
		this.pauseBtn.setAttr('disabled', 'true');
		this.stopAndSaveBtn = buttonContainer.createEl('button', { text: 'Stop & Save', cls: 'recorder-btn-stop-save' });
		this.stopAndSaveBtn.setAttr('disabled', 'true');
		this.stopBtn = buttonContainer.createEl('button', { text: 'Stop & Transcribe', cls: 'recorder-btn-stop-transcribe' });
		this.stopBtn.setAttr('disabled', 'true');

		// 设置音频数据回调
		this.recorder.setAudioDataCallback(this.drawAudioWaveform.bind(this));

		// Initialize UI and timer
		this.updateUI();
		this.intervalId = window.setInterval(() => {
			const elapsed = this.recorder.getElapsed();
			this.timerEl.setText(this.formatTime(elapsed));
		}, 500);

		this.recordBtn.onclick = async () => {
			try {
				// Start recording
				await this.recorder.start();
				this.plugin.updateStatus(t('statusRecording'));
				new Notice(t('noticeRecordingStarted'));
				// Manually update button states immediately
				this.recordBtn.setAttr('disabled', 'true');
				this.pauseBtn.removeAttribute('disabled');
				this.stopBtn.removeAttribute('disabled');
				this.stopAndSaveBtn.removeAttribute('disabled');
				this.pauseBtn.setText('Pause');
				this.isPaused = false;
				this.contentEl.addClass('is-recording');
				this.contentEl.removeClass('is-paused');
			} catch (error: unknown) {
				new Notice(t('noticeErrorStartingRecording', { message: (error as Error).message }));
				console.error(error);
			}
		};

		this.pauseBtn.onclick = () => {
			if (!this.isPaused) {
				this.recorder.pause();
				this.plugin.updateStatus(t('statusRecordingPaused'));
				this.pauseBtn.setText('Resume');
				this.isPaused = true;
				this.contentEl.addClass('is-paused');
				new Notice(t('noticeRecordingPaused'));
			} else {
				this.recorder.resume();
				this.plugin.updateStatus(t('statusRecording'));
				this.pauseBtn.setText('Pause');
				this.isPaused = false;
				this.contentEl.removeClass('is-paused');
				new Notice(t('noticeRecordingResumed'));
			}
		};

		this.stopBtn.onclick = async () => {
			this.contentEl.removeClass('is-recording');
			this.contentEl.removeClass('is-paused');
			this.stopBtn.setAttr('disabled', 'true');
			this.stopAndSaveBtn.setAttr('disabled', 'true');
			this.pauseBtn.setAttr('disabled', 'true');
			new Notice(t('noticeStoppingRecording'));
			try {
				const result: RecordingResult = await this.recorder.stop();
				const audioDir = this.plugin.settings.transcriber.audioDir;
				const audioPath = await this.fileService.saveRecording(result.blob, audioDir);
				new Notice(t('noticeRecordingSaved', { path: audioPath }));

				const audioFileName = audioPath.substring(audioPath.lastIndexOf('/') + 1);
				const baseName = audioFileName.replace(/\.[^/.]+$/, '');

				if (this.plugin.settings.editor.enabled) {
					new SystemPromptTemplateSelectionModal(this.app, this.plugin, async (selection) => {
						const selectedTemplateName =
							typeof selection === 'object' && selection ? selection.name : selection;
						const context = typeof selection === 'object' && selection ? selection.context : '';
						if (!selectedTemplateName) {
							new Notice(t('noticeTemplateSelectionCancelledAudioSaved'));
							this.plugin.updateStatus(t('statusIdle'));
							this.close();
							return;
						}

						const selectedTemplate = this.plugin.settings.editor.systemPromptTemplates.find(t => t.name === selectedTemplateName);
						if (!selectedTemplate) {
							new Notice(t('noticeTemplateNotFoundAudioSaved'));
							this.plugin.updateStatus(t('statusIdle'));
							this.close();
							return;
						}

						await this.plugin.processAudioBlob(result.blob, baseName, {
							systemPromptOverride: selectedTemplate.prompt,
							context,
							saveRawWhenEditorEnabled: this.plugin.settings.editor.keepOriginal,
							openResult: true,
						});
						this.close();
					}).open();
				} else {
					await this.plugin.processAudioBlob(result.blob, baseName, {
						openResult: true,
					});
					this.close();
				}
			} catch (error: unknown) { // Outer catch for errors during recorder.stop() or fileService.saveRecording()
				new Notice(t('noticeError', { message: (error as Error).message }));
				console.error(error);
				this.plugin.updateStatus(t('statusIdle'));
				this.close();
			}
		};

		// Handler for "Stop & Save" button
		this.stopAndSaveBtn.onclick = async () => {
			this.contentEl.removeClass('is-recording');
			this.contentEl.removeClass('is-paused');
			this.stopAndSaveBtn.setAttr('disabled', 'true');
			this.stopBtn.setAttr('disabled', 'true');
			this.pauseBtn.setAttr('disabled', 'true');
			this.recordBtn.setAttr('disabled', 'true');
			this.plugin.updateStatus(t('statusSavingRecording'));
			new Notice(t('noticeSavingRecording'));
			try {
				const result: RecordingResult = await this.recorder.stop();
				const audioDir = this.plugin.settings.transcriber.audioDir;
				const audioPath = await this.fileService.saveRecording(result.blob, audioDir);
				new Notice(t('noticeRecordingSaved', { path: audioPath }));
				this.plugin.updateStatus(t('statusIdle'));
			} catch (error: unknown) {
				new Notice(t('noticeErrorSavingRecording', { message: (error as Error).message }));
				console.error(error);
				this.plugin.updateStatus(t('statusIdle'));
			} finally {
				this.close();
			}
		};
	}

	onClose() {
		// Stop updating timer but keep recording running
		clearInterval(this.intervalId);
		this.contentEl.empty();
	}

	private updateUI() {
		const isRecording = this.recorder.isRecording();
		const isPaused = this.recorder.isPaused();

		if (isRecording || isPaused) {
			// 录音中或暂停中，禁用录音按钮，启用其他按钮
			this.recordBtn.setAttr('disabled', 'true');
			this.pauseBtn.removeAttribute('disabled');
			this.stopBtn.removeAttribute('disabled');
			this.stopAndSaveBtn.removeAttribute('disabled');
			this.pauseBtn.setText(isPaused ? 'Resume' : 'Pause');
			this.isPaused = isPaused;
			this.contentEl.addClass('is-recording');
			if (isPaused) this.contentEl.addClass('is-paused');
			else this.contentEl.removeClass('is-paused');
		} else {
			// 未录音状态
			this.recordBtn.removeAttribute('disabled');
			this.pauseBtn.setAttr('disabled', 'true');
			this.stopBtn.setAttr('disabled', 'true');
			this.stopAndSaveBtn.setAttr('disabled', 'true');
			this.contentEl.removeClass('is-recording');
			this.contentEl.removeClass('is-paused');
		}
	}

	private formatTime(seconds: number): string {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		if (h > 0) {
			return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
		}
		return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	}

	// 绘制音频波形
	private drawAudioWaveform(data: Uint8Array) {
		const { width, height } = this.canvasEl;
		const barWidth = width / data.length;
		
		// 清除画布
		this.canvasCtx.clearRect(0, 0, width, height);
		
		// 设置波形颜色
		this.canvasCtx.fillStyle = 'var(--interactive-accent)';
		
		// 绘制波形
		for (let i = 0; i < data.length; i++) {
			const barHeight = (data[i] / 255) * height;
			const x = i * barWidth;
			const y = (height - barHeight) / 2;
			
			this.canvasCtx.fillRect(x, y, barWidth - 1, barHeight);
		}
	}
} 

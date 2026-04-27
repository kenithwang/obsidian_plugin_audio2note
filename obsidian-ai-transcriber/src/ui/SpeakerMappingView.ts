import { ButtonComponent, DropdownComponent, ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import ObsidianAITranscriber from '../../main';
import { Participant } from '../settings/types';
import { SpeakerMapping, applySpeakerMapping } from '../services/speakerMapping';
import { t } from '../i18n';

export const SPEAKER_MAPPING_VIEW_TYPE = 'ai-transcriber-speaker-mapping';

export interface SpeakerMappingViewState {
	rawPath: string;
	speakerIds: string[];
	participants: Participant[];
	mapping: SpeakerMapping;
	onConfirm?: (text: string) => void;
}

export class SpeakerMappingView extends ItemView {
	private plugin: ObsidianAITranscriber;
	private session: SpeakerMappingViewState | null = null;
	private dropdowns = new Map<string, DropdownComponent>();

	constructor(leaf: WorkspaceLeaf, plugin: ObsidianAITranscriber) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SPEAKER_MAPPING_VIEW_TYPE;
	}

	getDisplayText(): string {
		return t('speakerMappingTitle');
	}

	getIcon(): string {
		return 'users';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async setSession(session: SpeakerMappingViewState): Promise<void> {
		this.session = session;
		this.render();
		await this.applyMappingToNote();
	}

	private render(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('ai-transcriber-speaker-mapping-view');

		const contentEl = containerEl.createDiv({ cls: 'speaker-map-panel' });
		contentEl.createEl('h2', { text: t('speakerMappingTitle') });

		if (!this.session) {
			contentEl.createEl('p', {
				cls: 'speaker-map-empty',
				text: t('speakerMappingEmpty'),
			});
			return;
		}

		contentEl.createEl('p', {
			cls: 'speaker-map-desc',
			text: t('speakerMappingDesc'),
		});

		const listEl = contentEl.createDiv({ cls: 'speaker-map-list' });
		this.dropdowns.clear();

		for (const speakerId of this.session.speakerIds) {
			const rowEl = listEl.createDiv({ cls: 'speaker-map-row' });
			rowEl.createDiv({ cls: 'speaker-map-id', text: speakerId });

			const dropdown = new DropdownComponent(rowEl);
			dropdown.addOption('', t('speakerMappingUnknown'));
			for (const participant of this.session.participants) {
				dropdown.addOption(participant.id, participant.org ? `${participant.name} (${participant.org})` : participant.name);
			}
			dropdown.setValue(this.session.mapping[speakerId] || '');
			dropdown.onChange(async value => {
				if (!this.session) return;
				this.session.mapping[speakerId] = value;
				await this.applyMappingToNote();
			});
			this.dropdowns.set(speakerId, dropdown);

			new ButtonComponent(rowEl)
				.setButtonText(t('speakerMappingLocate'))
				.onClick(async () => {
					await this.locateSpeaker(speakerId);
				});
		}

		const actionsEl = contentEl.createDiv({ cls: 'speaker-map-actions' });
		new ButtonComponent(actionsEl)
			.setButtonText(t('speakerMappingApply'))
			.onClick(async () => {
				await this.applyMappingToNote();
				new Notice(t('speakerMappingAppliedNotice'));
			});

		new ButtonComponent(actionsEl)
			.setButtonText(t('speakerMappingConfirm'))
			.setCta()
			.onClick(async () => {
				const text = await this.applyMappingToNote();
				const onConfirm = this.session?.onConfirm;
				this.session = null;
				this.render();
				onConfirm?.(text);
				new Notice(t('speakerMappingConfirmedNotice'));
			});
	}

	private async applyMappingToNote(): Promise<string> {
		if (!this.session) return '';
		const file = this.plugin.app.vault.getAbstractFileByPath(this.session.rawPath);
		if (!(file instanceof TFile)) {
			throw new Error(`Speaker mapping target file not found: ${this.session.rawPath}`);
		}
		const text = await this.plugin.app.vault.read(file);
		const updated = applySpeakerMapping(text, this.session.mapping, this.session.participants);
		if (updated !== text) {
			await this.plugin.app.vault.modify(file, updated);
		}
		return updated;
	}

	private async locateSpeaker(speakerId: string): Promise<void> {
		if (!this.session) return;
		const file = this.plugin.app.vault.getAbstractFileByPath(this.session.rawPath);
		if (!(file instanceof TFile)) return;
		await this.plugin.app.workspace.getLeaf(false).openFile(file);
		const leaf = this.plugin.app.workspace.getMostRecentLeaf();
		const view = leaf?.view;
		if (!view || view.getViewType() !== 'markdown') return;

		const editor = (view as { editor?: { getValue: () => string; setCursor: (pos: { line: number; ch: number }) => void; focus: () => void } }).editor;
		if (!editor) return;
		const lines = editor.getValue().split('\n');
		const line = lines.findIndex(item => item.includes(`speaker:${speakerId}`));
		if (line >= 0) {
			editor.setCursor({ line, ch: 0 });
			editor.focus();
		}
	}
}

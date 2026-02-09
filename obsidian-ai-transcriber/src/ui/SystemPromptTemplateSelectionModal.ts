import { App, Modal, Setting } from 'obsidian';
import ObsidianAITranscriber from '../../main';
import { Participant } from '../settings/types';
import ParticipantModal from './ParticipantModal';
import { t } from '../i18n';

export interface TemplateSelectionResult {
	name: string;
	context: string;
	participants: Participant[];
	purpose: string;
}

export class SystemPromptTemplateSelectionModal extends Modal {
	plugin: ObsidianAITranscriber;
	onSubmit: (selection: TemplateSelectionResult | null) => void;
	private selectedName: string;
	private selectedParticipantIds: Set<string>;
	private meetingPurpose: string;

	constructor(app: App, plugin: ObsidianAITranscriber, onSubmit: (selection: TemplateSelectionResult | null) => void) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
		this.selectedName = plugin.settings.editor.activeSystemPromptTemplateName; // Default to current active
		this.selectedParticipantIds = new Set<string>();
		this.meetingPurpose = '';
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ai-transcriber-template-selection-modal');
		contentEl.createEl('h2', { text: t('templateSelectTitle') });

		const templates = this.plugin.settings.editor.systemPromptTemplates;
		if (!this.plugin.settings.editor.participants) {
			this.plugin.settings.editor.participants = [];
		}
		if (!templates || templates.length === 0) {
			// Should not happen if 'Default' template is always ensured
			contentEl.createEl('p', { text: 'No system prompt templates found. Please create one in settings.' });
			new Setting(contentEl).addButton(btn =>
				btn
					.setButtonText('Close')
					.setCta()
					.onClick(() => {
						this.onSubmit(null);
						this.close();
					})
			);
			return;
		}

		new Setting(contentEl)
			.setName(t('templateLabel'))
			.setDesc(t('templateDesc'))
			.addDropdown(dropdown => {
				templates.forEach(template => {
					dropdown.addOption(template.name, template.name);
				});
				dropdown.setValue(this.selectedName);
				dropdown.onChange(value => {
					this.selectedName = value;
				});
			});

		new Setting(contentEl)
			.setName(t('participantsLabel'))
			.setDesc(t('participantsDesc'))
			.addButton(btn =>
				btn
					.setButtonText(t('participantsAdd'))
					.setCta()
					.onClick(() => {
						new ParticipantModal(this.app, this.plugin, participant => {
							if (!participant) return;
							this.plugin.settings.editor.participants.push(participant);
							this.plugin.saveSettings().then(() => this.onOpen());
						}).open();
					})
			);

		if (this.plugin.settings.editor.participants.length === 0) {
			contentEl.createEl('div', { text: t('participantsEmpty') });
		} else {
			this.plugin.settings.editor.participants.forEach(participant => {
				new Setting(contentEl)
					.setName(
						participant.name + (participant.org ? ` (${participant.org})` : '')
					)
					.setDesc(participant.intro || '')
					.addToggle(toggle => {
						toggle.setValue(this.selectedParticipantIds.has(participant.id));
						toggle.onChange(value => {
							if (value) {
								this.selectedParticipantIds.add(participant.id);
							} else {
								this.selectedParticipantIds.delete(participant.id);
							}
						});
					})
					.addButton(btn =>
						btn.setButtonText(t('participantsEdit')).onClick(() => {
							new ParticipantModal(this.app, this.plugin, updated => {
								if (!updated) return;
								const idx = this.plugin.settings.editor.participants.findIndex(
									p => p.id === participant.id
								);
								if (idx >= 0) {
									this.plugin.settings.editor.participants[idx] = updated;
									this.plugin.saveSettings().then(() => this.onOpen());
								}
							}, participant).open();
						})
					)
					.addButton(btn =>
						btn.setButtonText(t('participantsDelete')).setWarning().onClick(() => {
							const modal = new Modal(this.app);
							modal.contentEl.createEl('h2', { text: t('participantsDeleteConfirmTitle') });
							modal.contentEl.createEl('p', { text: t('participantsDeleteConfirmText', { name: participant.name }) });
							new Setting(modal.contentEl)
								.addButton(cancel =>
									cancel.setButtonText(t('cancel')).onClick(() => modal.close())
								)
								.addButton(confirm =>
									confirm
										.setButtonText(t('participantsDelete'))
										.setWarning()
										.onClick(() => {
											this.selectedParticipantIds.delete(participant.id);
											this.plugin.settings.editor.participants =
												this.plugin.settings.editor.participants.filter(p => p.id !== participant.id);
											this.plugin.saveSettings().then(() => {
												modal.close();
												this.onOpen();
											});
										})
								);
							modal.open();
						})
					);
			});
		}

		new Setting(contentEl)
			.setName(t('meetingPurposeLabel'))
			.setDesc(t('meetingPurposeDesc'))
			.addTextArea(text => {
				text.setPlaceholder(t('meetingPurposePlaceholder'));
				text.setValue(this.meetingPurpose);
				text.onChange(value => {
					this.meetingPurpose = value;
				});
				text.inputEl.rows = 3;
				text.inputEl.style.width = '100%';
			});

		new Setting(contentEl)
			.addButton(btn =>
				btn.setButtonText(t('cancel')).onClick(() => {
					this.onSubmit(null);
					this.close();
				})
			)
			.addButton(btn =>
				btn
					.setButtonText(t('confirm'))
					.setCta()
					.onClick(() => {
						let context = '';
						const selectedParticipants = this.plugin.settings.editor.participants.filter(p =>
							this.selectedParticipantIds.has(p.id)
						);
						if (selectedParticipants.length) {
							context +=
								`${t('contextParticipantsTitle')}\n` +
								selectedParticipants
									.map(
										p =>
											`- ${p.name}${p.org ? ` (${p.org})` : ''}${p.intro ? ` — ${p.intro}` : ''}`
									)
									.join('\n');
						}
						if (this.meetingPurpose && this.meetingPurpose.trim()) {
							context += `${context ? '\n\n' : ''}${t('contextPurposeTitle')}\n${this.meetingPurpose.trim()}`;
						}
						this.onSubmit({
							name: this.selectedName,
							context,
							participants: selectedParticipants,
							purpose: this.meetingPurpose,
						});
						this.close();
					})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

import { App, Modal, Notice, Setting } from 'obsidian';
import ObsidianAITranscriber from '../../main';
import { Participant } from '../settings/types';
import { t } from '../i18n';

export default class ParticipantModal extends Modal {
	private plugin: ObsidianAITranscriber;
	private onSubmit: (participant: Participant | null) => void;
	private participant?: Participant;

	constructor(
		app: App,
		plugin: ObsidianAITranscriber,
		onSubmit: (participant: Participant | null) => void,
		participant?: Participant
	) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
		this.participant = participant;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ai-transcriber-participant-modal');
		contentEl.createEl('h2', { text: this.participant ? t('participantModalEditTitle') : t('participantModalAddTitle') });

		let name = this.participant ? this.participant.name : '';
		let org = this.participant ? this.participant.org : '';
		let intro = this.participant ? this.participant.intro : '';

		new Setting(contentEl)
			.setName(t('participantName'))
			.setDesc(t('participantNameDesc'))
			.addText(text => {
				text.setPlaceholder(t('participantNamePlaceholder'));
				text.setValue(name);
				text.onChange(value => {
					name = value;
				});
			});

		new Setting(contentEl)
			.setName(t('participantOrg'))
			.setDesc(t('participantOrgDesc'))
			.addText(text => {
				text.setPlaceholder(t('participantOrgPlaceholder'));
				text.setValue(org);
				text.onChange(value => {
					org = value;
				});
			});

		new Setting(contentEl)
			.setName(t('participantIntro'))
			.setDesc(t('participantIntroDesc'))
			.addTextArea(text => {
				text.setPlaceholder(t('participantIntroPlaceholder'));
				text.setValue(intro);
				text.onChange(value => {
					intro = value;
				});
				text.inputEl.rows = 4;
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
					.setButtonText(t('save'))
					.setCta()
					.onClick(() => {
						const trimmedName = name.trim();
						if (!trimmedName) {
							new Notice(t('participantNameEmpty'));
							return;
						}
						const participant: Participant = {
							id:
								this.participant?.id ??
								`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
							name: trimmedName,
							org: org.trim(),
							intro: intro.trim(),
						};
						this.onSubmit(participant);
						this.close();
					})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

import { App, Modal, Notice, Setting } from 'obsidian';
import ObsidianAITranscriber from '../../main';
import { Participant } from '../settings/types';

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
		contentEl.createEl('h2', { text: this.participant ? '编辑人物' : '新增人物' });

		let name = this.participant ? this.participant.name : '';
		let org = this.participant ? this.participant.org : '';
		let intro = this.participant ? this.participant.intro : '';

		new Setting(contentEl)
			.setName('姓名')
			.setDesc('必填')
			.addText(text => {
				text.setPlaceholder('姓名');
				text.setValue(name);
				text.onChange(value => {
					name = value;
				});
			});

		new Setting(contentEl)
			.setName('组织/公司')
			.setDesc('可选')
			.addText(text => {
				text.setPlaceholder('Organization');
				text.setValue(org);
				text.onChange(value => {
					org = value;
				});
			});

		new Setting(contentEl)
			.setName('人物介绍')
			.setDesc('简要身份/职责，用于识别')
			.addTextArea(text => {
				text.setPlaceholder('如：产品负责人，负责XX');
				text.setValue(intro);
				text.onChange(value => {
					intro = value;
				});
				text.inputEl.rows = 4;
				text.inputEl.style.width = '100%';
			});

		new Setting(contentEl)
			.addButton(btn =>
				btn.setButtonText('取消').onClick(() => {
					this.onSubmit(null);
					this.close();
				})
			)
			.addButton(btn =>
				btn
					.setButtonText('保存')
					.setCta()
					.onClick(() => {
						const trimmedName = name.trim();
						if (!trimmedName) {
							new Notice('姓名不能为空');
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

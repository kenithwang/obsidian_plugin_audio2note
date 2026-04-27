import { App } from 'obsidian';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Participant } from '../settings/types';
import { SpeakerMapping } from './speakerMapping';
import { SpeakerAnalysis } from './sidecar';

interface VaultAdapterWithBasePath {
	basePath?: string;
}

interface VoiceSample {
	id: string;
	vector: number[];
	sourceRecordingId: string;
	sourceSpeakerId: string;
	createdAt: string;
}

interface VoiceProfilesFile {
	version: 1;
	participants: Record<string, { samples: VoiceSample[] }>;
}

export interface VoiceMatch {
	participantId: string;
	score: number;
}

export class VoiceProfileService {
	private readonly app: App;
	private readonly pluginId: string;

	constructor(app: App, pluginId: string) {
		this.app = app;
		this.pluginId = pluginId;
	}

	async suggestMapping(
		analyses: SpeakerAnalysis[],
		participants: Participant[],
	): Promise<Record<string, string>> {
		const store = await this.readStore();
		const participantIds = new Set(participants.map(participant => participant.id));
		const mapping: Record<string, string> = {};

		for (const analysis of analyses) {
			if (!analysis.embedding?.length) continue;
			const matches = this.rankMatches(analysis.embedding, store, participantIds);
			const [top, second] = matches;
			if (top && top.score >= 0.78 && (!second || top.score - second.score >= 0.04)) {
				mapping[analysis.speaker] = top.participantId;
			}
		}

		return mapping;
	}

	async learnFromConfirmedMapping(
		recordingId: string,
		analyses: SpeakerAnalysis[],
		mapping: SpeakerMapping,
	): Promise<void> {
		const store = await this.readStore();
		let changed = false;
		for (const analysis of analyses) {
			const participantId = mapping[analysis.speaker];
			if (!participantId || !analysis.embedding?.length) continue;
			const profile = store.participants[participantId] ?? { samples: [] };
			profile.samples.push({
				id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				vector: analysis.embedding,
				sourceRecordingId: recordingId,
				sourceSpeakerId: analysis.speaker,
				createdAt: new Date().toISOString(),
			});
			profile.samples = profile.samples.slice(-12);
			store.participants[participantId] = profile;
			changed = true;
		}
		if (changed) {
			await this.writeStore(store);
		}
	}

	private rankMatches(
		vector: number[],
		store: VoiceProfilesFile,
		participantIds: Set<string>,
	): VoiceMatch[] {
		const matches: VoiceMatch[] = [];
		for (const participantId of participantIds) {
			const samples = store.participants[participantId]?.samples ?? [];
			if (!samples.length) continue;
			const best = Math.max(...samples.map(sample => cosineSimilarity(vector, sample.vector)));
			if (Number.isFinite(best)) {
				matches.push({ participantId, score: best });
			}
		}
		return matches.sort((a, b) => b.score - a.score);
	}

	private async readStore(): Promise<VoiceProfilesFile> {
		const filePath = this.getStorePath();
		try {
			const raw = await fs.readFile(filePath, 'utf8');
			const parsed = JSON.parse(raw) as Partial<VoiceProfilesFile>;
			return {
				version: 1,
				participants: parsed.participants ?? {},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { version: 1, participants: {} };
			}
			throw error;
		}
	}

	private async writeStore(store: VoiceProfilesFile): Promise<void> {
		const filePath = this.getStorePath();
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
	}

	private getStorePath(): string {
		const adapter = this.app.vault.adapter as VaultAdapterWithBasePath;
		if (!adapter.basePath) {
			throw new Error('Voice profiles are only available on desktop vaults.');
		}
		const host = os.hostname().replace(/[^a-zA-Z0-9_.-]/g, '_') || 'unknown-host';
		return path.join(
			adapter.basePath,
			this.app.vault.configDir,
			'plugins',
			this.pluginId,
			`voice-profiles.local.${host}.json`,
		);
	}
}

function cosineSimilarity(a: number[], b: number[]): number {
	const length = Math.min(a.length, b.length);
	if (!length) return Number.NEGATIVE_INFINITY;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	if (!normA || !normB) return Number.NEGATIVE_INFINITY;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

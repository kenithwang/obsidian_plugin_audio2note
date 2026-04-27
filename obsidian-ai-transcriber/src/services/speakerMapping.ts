import { Participant } from '../settings/types';

export const SPEAKER_MARKER_PATTERN = /<!--\s*speaker:([A-Za-z0-9_-]+)\s*-->\s*([^:\n]+):/g;

export interface SpeakerMappingSession {
	speakerIds: string[];
	text: string;
}

export type SpeakerMapping = Record<string, string>;

function speakerNumberToId(value: string): string {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return `SPEAKER_${value}`;
	}
	return `SPEAKER_${String(parsed - 1).padStart(2, '0')}`;
}

export function prepareSpeakerMappingSession(transcript: string): SpeakerMappingSession | null {
	const speakerIds: string[] = [];
	const seen = new Set<string>();
	const textWithExistingMarkers = transcript.replace(SPEAKER_MARKER_PATTERN, (match, speakerId: string) => {
		if (!seen.has(speakerId)) {
			seen.add(speakerId);
			speakerIds.push(speakerId);
		}
		return match;
	});

	const text = textWithExistingMarkers.replace(
		/(^|\n)(\s*)(?:\*\*)?Speaker\s+(\d+)\s*(?::\*\*|\*\*:|:)/gi,
		(match, lineStart: string, indent: string, speakerNumber: string) => {
			const speakerId = speakerNumberToId(speakerNumber);
			if (!seen.has(speakerId)) {
				seen.add(speakerId);
				speakerIds.push(speakerId);
			}
			return `${lineStart}${indent}<!-- speaker:${speakerId} --> Speaker ${speakerNumber}:`;
		},
	);

	if (!speakerIds.length) {
		return null;
	}

	return { speakerIds, text };
}

export function extractSpeakerIds(text: string): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	let match: RegExpExecArray | null;
	SPEAKER_MARKER_PATTERN.lastIndex = 0;
	while ((match = SPEAKER_MARKER_PATTERN.exec(text)) !== null) {
		const speakerId = match[1];
		if (!seen.has(speakerId)) {
			seen.add(speakerId);
			ids.push(speakerId);
		}
	}
	return ids;
}

export function createDefaultSpeakerMapping(speakerIds: string[], participants: Participant[]): SpeakerMapping {
	const mapping: SpeakerMapping = {};
	speakerIds.forEach((speakerId, index) => {
		mapping[speakerId] = participants[index]?.id || '';
	});
	return mapping;
}

export function getParticipantDisplayName(participants: Participant[], participantId: string, fallback: string): string {
	const participant = participants.find(item => item.id === participantId);
	if (!participant) return fallback;
	return participant.org ? `${participant.name} (${participant.org})` : participant.name;
}

export function applySpeakerMapping(
	text: string,
	mapping: SpeakerMapping,
	participants: Participant[],
): string {
	return text.replace(SPEAKER_MARKER_PATTERN, (_match, speakerId: string) => {
		const participantId = mapping[speakerId] || '';
		const label = getParticipantDisplayName(participants, participantId, speakerId);
		return `<!-- speaker:${speakerId} --> ${label}:`;
	});
}

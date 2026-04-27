import { App } from 'obsidian';
import * as childProcess from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFile = promisify(childProcess.execFile);
const LOCAL_CONFIG_PREFIX = 'sidecar.local';
const LOCAL_CONFIG_EXT = '.json';
const DEFAULT_MODULE_NAME = 'obsidian_diarization_server';
const DEFAULT_PORT = 18765;
const SETUP_TIMEOUT_MS = 30 * 60 * 1000;

export type SidecarStatusCode = 'not_configured' | 'configured' | 'error';
export type SidecarSetupProgress = (message: string) => void;

export interface SidecarLocalConfig {
	pythonPath: string;
	venvPath: string;
	serverPath: string;
	moduleName: string;
	port: number;
	host: string;
	authToken?: string;
	configuredAt: string;
}

export interface SidecarStatus {
	code: SidecarStatusCode;
	message: string;
	config?: SidecarLocalConfig;
	configPath?: string;
	error?: string;
}

export interface SidecarConfigureOptions {
	authToken?: string;
	onProgress?: SidecarSetupProgress;
}

export interface DiarizationSegment {
	start: number;
	end: number;
	speaker: string;
}

export interface SpeakerAnalysis {
	speaker: string;
	segments: DiarizationSegment[];
	embedding?: number[];
}

interface VaultAdapterWithBasePath {
	basePath?: string;
}

export class SidecarService {
	private readonly app: App;
	private readonly pluginId: string;
	private process: childProcess.ChildProcessWithoutNullStreams | null = null;

	constructor(app: App, pluginId: string) {
		this.app = app;
		this.pluginId = pluginId;
	}

	async getStatus(): Promise<SidecarStatus> {
		try {
			const configPath = this.getHostConfigPath();
			const config = await this.readLocalConfig(configPath);
			if (!config) {
				return {
					code: 'not_configured',
					message: 'Not configured on this device',
					configPath,
				};
			}

			const pythonOk = await this.testBasePython(config.pythonPath);
			if (!pythonOk.ok) {
				return {
					code: 'error',
					message: 'Configured, but Python is not usable',
					config,
					configPath,
					error: pythonOk.error,
				};
			}

			return {
				code: 'configured',
				message: 'Configured',
				config,
				configPath,
			};
		} catch (error) {
			return {
				code: 'error',
				message: 'Failed to read local diarization config',
				error: (error as Error).message,
			};
		}
	}

	async configure(options: SidecarConfigureOptions = {}): Promise<SidecarStatus> {
		const progress = options.onProgress ?? (() => {});
		const sidecarDir = this.getSidecarDir();
		const venvPath = this.getVenvPath();
		const serverPath = path.join(sidecarDir, `${DEFAULT_MODULE_NAME}.py`);
		let pythonPath = this.getVenvPythonPath();

		progress('Preparing local sidecar files...');
		await fs.mkdir(sidecarDir, { recursive: true });
		await this.writeServerModule(serverPath);

		if (!(await this.fileExists(pythonPath))) {
			progress('Creating local Python virtual environment...');
			const basePython = await this.findBasePython();
			if (!basePython) {
				return {
					code: 'error',
					message: 'No usable Python was found',
					error: 'Install Python 3.10+ or set OBSIDIAN_AI_TRANSCRIBER_PYTHON.',
					configPath: this.getHostConfigPath(),
				};
			}
			await this.createVenv(basePython, venvPath, progress);
		}

		if (!(await this.fileExists(pythonPath))) {
			return {
				code: 'error',
				message: 'Failed to create local Python environment',
				error: `Expected Python was not created at ${pythonPath}`,
				configPath: this.getHostConfigPath(),
			};
		}

		progress('Installing local diarization dependencies...');
		await this.installDependencies(pythonPath, progress);

		progress('Checking local diarization dependencies...');
		const check = await this.testSidecarPython(pythonPath);
		if (!check.ok) {
			return {
				code: 'error',
				message: 'Local diarization dependency check failed',
				error: check.error,
				configPath: this.getHostConfigPath(),
			};
		}

		const configPath = this.getHostConfigPath();
		const config: SidecarLocalConfig = {
			pythonPath,
			venvPath,
			serverPath,
			moduleName: DEFAULT_MODULE_NAME,
			port: DEFAULT_PORT,
			host: os.hostname(),
			authToken: options.authToken?.trim() || undefined,
			configuredAt: new Date().toISOString(),
		};

		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
		progress('Local diarization configured.');

		return {
			code: 'configured',
			message: 'Configured',
			config,
			configPath,
		};
	}

	async getLocalConfig(): Promise<SidecarLocalConfig | null> {
		return this.readLocalConfig(this.getHostConfigPath());
	}

	async testConnection(progress: SidecarSetupProgress = () => {}): Promise<SidecarStatus> {
		const status = await this.getStatus();
		if (status.code !== 'configured' || !status.config) {
			return status;
		}

		progress('Starting local diarization server...');
		await this.ensureRunning(status.config, progress);
		progress('Local diarization server is ready.');
		return status;
	}

	async diarize(
		blob: Blob,
		filename: string,
		progress: SidecarSetupProgress = () => {},
	): Promise<DiarizationSegment[]> {
		const status = await this.getStatus();
		if (status.code !== 'configured' || !status.config) {
			throw new Error(status.error || status.message);
		}

		await this.ensureRunning(status.config, progress);
		progress('Running speaker diarization...');

		const form = new FormData();
		form.append('audio', new File([blob], filename, { type: blob.type || 'audio/webm' }));

		const response = await fetch(`http://127.0.0.1:${status.config.port}/diarize`, {
			method: 'POST',
			body: form,
		});
		if (!response.ok) {
			throw new Error(`Diarization request failed: ${response.status} ${response.statusText}`);
		}

		const payload = await response.json();
		if (!Array.isArray(payload)) {
			throw new Error('Diarization response was not an array.');
		}

		return payload
			.map(item => ({
				start: Number((item as { start?: unknown }).start),
				end: Number((item as { end?: unknown }).end),
				speaker: String((item as { speaker?: unknown }).speaker || ''),
			}))
			.filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.speaker);
	}

	async analyzeSpeakers(
		blob: Blob,
		filename: string,
		progress: SidecarSetupProgress = () => {},
	): Promise<SpeakerAnalysis[]> {
		const status = await this.getStatus();
		if (status.code !== 'configured' || !status.config) {
			throw new Error(status.error || status.message);
		}

		await this.ensureRunning(status.config, progress);
		progress('Running speaker analysis...');

		const form = new FormData();
		form.append('audio', new File([blob], filename, { type: blob.type || 'audio/webm' }));

		let response = await fetch(`http://127.0.0.1:${status.config.port}/analyze-speakers`, {
			method: 'POST',
			body: form,
		});
		if (response.status === 404) {
			this.stop();
			await new Promise(resolve => window.setTimeout(resolve, 500));
			await this.ensureRunning(status.config, progress);
			const retryForm = new FormData();
			retryForm.append('audio', new File([blob], filename, { type: blob.type || 'audio/webm' }));
			response = await fetch(`http://127.0.0.1:${status.config.port}/analyze-speakers`, {
				method: 'POST',
				body: retryForm,
			});
		}
		if (!response.ok) {
			throw new Error(`Speaker analysis request failed: ${response.status} ${response.statusText}`);
		}
		const payload = await response.json();
		if (!Array.isArray(payload)) {
			throw new Error('Speaker analysis response was not an array.');
		}

		return payload.map(item => {
			const raw = item as { speaker?: unknown; embedding?: unknown; segments?: unknown };
			const segments = Array.isArray(raw.segments)
				? raw.segments.map(segment => ({
					start: Number((segment as { start?: unknown }).start),
					end: Number((segment as { end?: unknown }).end),
					speaker: String((segment as { speaker?: unknown }).speaker || raw.speaker || ''),
				})).filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.speaker)
				: [];
			const embedding = Array.isArray(raw.embedding)
				? raw.embedding.map(value => Number(value)).filter(value => Number.isFinite(value))
				: undefined;
			return {
				speaker: String(raw.speaker || ''),
				segments,
				embedding,
			};
		}).filter(item => item.speaker && item.segments.length);
	}

	stop(): void {
		if (!this.process) return;
		this.process.kill();
		this.process = null;
	}

	async resetLocalConfig(): Promise<void> {
		this.stop();
		const configPath = this.getHostConfigPath();
		try {
			await fs.unlink(configPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}

	private async ensureRunning(config: SidecarLocalConfig, progress: SidecarSetupProgress): Promise<void> {
		await this.writeServerModule(config.serverPath);

		if (await this.healthCheck(config.port)) {
			return;
		}

		if (!this.process) {
			this.process = childProcess.spawn(
				config.pythonPath,
				['-m', 'uvicorn', `${config.moduleName}:app`, '--host', '127.0.0.1', '--port', String(config.port)],
				{
					cwd: path.dirname(config.serverPath),
					env: {
						...process.env,
						...(config.authToken ? { PYANNOTE_AUTH_TOKEN: config.authToken } : {}),
					},
					windowsHide: true,
				},
			);

			this.process.stdout.on('data', data => progress(data.toString().trim()));
			this.process.stderr.on('data', data => progress(data.toString().trim()));
			this.process.on('close', () => {
				this.process = null;
			});
		}

		await this.waitForHealth(config.port, 30000);
	}

	private async waitForHealth(port: number, timeoutMs: number): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (await this.healthCheck(port)) return;
			await new Promise(resolve => window.setTimeout(resolve, 500));
		}
		throw new Error(`Local diarization server did not become ready on port ${port}.`);
	}

	private async healthCheck(port: number): Promise<boolean> {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			return response.ok;
		} catch {
			return false;
		}
	}

	private getHostConfigPath(): string {
		const pluginDir = this.getPluginDir();
		const host = this.getSafeHostName();
		return path.join(pluginDir, `${LOCAL_CONFIG_PREFIX}.${host}${LOCAL_CONFIG_EXT}`);
	}

	private getSidecarDir(): string {
		return path.join(this.getPluginDir(), 'sidecar');
	}

	private getVenvPath(): string {
		return path.join(this.getSidecarDir(), '.venv');
	}

	private getVenvPythonPath(): string {
		return process.platform === 'win32'
			? path.join(this.getVenvPath(), 'Scripts', 'python.exe')
			: path.join(this.getVenvPath(), 'bin', 'python');
	}

	private getPluginDir(): string {
		const adapter = this.app.vault.adapter as VaultAdapterWithBasePath;
		if (!adapter.basePath) {
			throw new Error('Local diarization setup is only available on desktop vaults.');
		}
		return path.join(adapter.basePath, this.app.vault.configDir, 'plugins', this.pluginId);
	}

	private getSafeHostName(): string {
		return os.hostname().replace(/[^a-zA-Z0-9_.-]/g, '_') || 'unknown-host';
	}

	private async readLocalConfig(configPath: string): Promise<SidecarLocalConfig | null> {
		try {
			const raw = await fs.readFile(configPath, 'utf8');
			const parsed = JSON.parse(raw) as Partial<SidecarLocalConfig>;
			if (!parsed.pythonPath || typeof parsed.pythonPath !== 'string') {
				throw new Error('sidecar local config is missing pythonPath.');
			}
			return {
				pythonPath: parsed.pythonPath,
				venvPath: parsed.venvPath || this.getVenvPath(),
				serverPath: parsed.serverPath || path.join(this.getSidecarDir(), `${DEFAULT_MODULE_NAME}.py`),
				moduleName: parsed.moduleName || DEFAULT_MODULE_NAME,
				port: typeof parsed.port === 'number' ? parsed.port : DEFAULT_PORT,
				host: parsed.host || os.hostname(),
				authToken: typeof parsed.authToken === 'string' ? parsed.authToken : undefined,
				configuredAt: parsed.configuredAt || '',
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return null;
			}
			throw error;
		}
	}

	private async findBasePython(): Promise<string | null> {
		const candidates = this.getBasePythonCandidates();
		for (const candidate of candidates) {
			const result = await this.testBasePython(candidate);
			if (result.ok) {
				return candidate;
			}
		}
		return null;
	}

	private getBasePythonCandidates(): string[] {
		const candidates: string[] = [];
		const fromEnv = process.env.OBSIDIAN_AI_TRANSCRIBER_PYTHON;
		if (fromEnv) candidates.push(fromEnv);

		if (process.platform === 'win32') {
			candidates.push('python');
			candidates.push('py');
		} else {
			candidates.push('python3');
			candidates.push('python');
		}

		return Array.from(new Set(candidates));
	}

	private async testBasePython(pythonPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
		try {
			await this.execPython(pythonPath, [
				'-c',
				'import sys; assert sys.version_info >= (3, 10), sys.version; print(sys.executable)',
			], 10000);
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: (error as Error).message,
			};
		}
	}

	private async testSidecarPython(pythonPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
		try {
			await this.execPython(pythonPath, [
				'-c',
				'import fastapi, uvicorn, pyannote.audio; print("ok")',
			], 30000);
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: (error as Error).message,
			};
		}
	}

	private async createVenv(basePython: string, venvPath: string, progress: SidecarSetupProgress): Promise<void> {
		const args = basePython === 'py' ? ['-3', '-m', 'venv', venvPath] : ['-m', 'venv', venvPath];
		await this.runCommand(basePython, args, progress, SETUP_TIMEOUT_MS);
	}

	private async installDependencies(pythonPath: string, progress: SidecarSetupProgress): Promise<void> {
		await this.runCommand(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip'], progress, SETUP_TIMEOUT_MS);
		await this.runCommand(
			pythonPath,
			['-m', 'pip', 'install', 'fastapi', 'uvicorn[standard]', 'python-multipart', 'pyannote.audio'],
			progress,
			SETUP_TIMEOUT_MS,
		);
	}

	private async execPython(pythonPath: string, args: string[], timeout: number): Promise<void> {
		await execFile(pythonPath, args, { timeout });
	}

	private async runCommand(
		command: string,
		args: string[],
		progress: SidecarSetupProgress,
		timeout: number,
	): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const child = childProcess.spawn(command, args, {
				cwd: this.getSidecarDir(),
				env: process.env,
				windowsHide: true,
			});
			let output = '';
			const timer = window.setTimeout(() => {
				child.kill();
				reject(new Error(`Command timed out: ${command} ${args.join(' ')}`));
			}, timeout);

			const append = (data: Buffer) => {
				const text = data.toString();
				output += text;
				const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
				const lastLine = lines[lines.length - 1];
				if (lastLine) progress(lastLine);
			};

			child.stdout.on('data', append);
			child.stderr.on('data', append);
			child.on('error', error => {
				window.clearTimeout(timer);
				reject(error);
			});
			child.on('close', code => {
				window.clearTimeout(timer);
				if (code === 0) {
					resolve();
					return;
				}
				reject(new Error(`Command failed (${code}): ${command} ${args.join(' ')}\n${output.slice(-4000)}`));
			});
		});
	}

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	private async writeServerModule(serverPath: string): Promise<void> {
		await fs.writeFile(serverPath, SIDECAR_SERVER_SOURCE, 'utf8');
	}
}

const SIDECAR_SERVER_SOURCE = `from __future__ import annotations

import os
import tempfile
from typing import Any

import numpy as np
from fastapi import FastAPI, File, UploadFile
from pyannote.audio import Inference, Model, Pipeline
from pyannote.core import Segment

app = FastAPI()
_pipeline: Pipeline | None = None
_embedding_inference: Inference | None = None


def auth_kwargs() -> dict[str, Any]:
    token = (
        os.environ.get("PYANNOTE_AUTH_TOKEN")
        or os.environ.get("HF_TOKEN")
        or os.environ.get("HUGGINGFACE_TOKEN")
    )
    return {"use_auth_token": token} if token else {}


def get_pipeline() -> Pipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", **auth_kwargs())
    return _pipeline


def get_embedding_inference() -> Inference:
    global _embedding_inference
    if _embedding_inference is None:
        model = Model.from_pretrained("pyannote/embedding", **auth_kwargs())
        _embedding_inference = Inference(model, window="whole")
    return _embedding_inference


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/diarize")
async def diarize(audio: UploadFile = File(...)) -> list[dict[str, float | str]]:
    analyses = await analyze_speakers(audio)
    return [
        {"start": segment["start"], "end": segment["end"], "speaker": item["speaker"]}
        for item in analyses
        for segment in item["segments"]
    ]


@app.post("/analyze-speakers")
async def analyze_speakers(audio: UploadFile = File(...)) -> list[dict[str, Any]]:
    suffix = os.path.splitext(audio.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name
    try:
        diarization = get_pipeline()(tmp_path)
        grouped: dict[str, list[dict[str, float]]] = {}
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            grouped.setdefault(speaker, []).append({"start": turn.start, "end": turn.end})

        embedding_inference = get_embedding_inference()
        results: list[dict[str, Any]] = []
        for speaker, segments in grouped.items():
            vectors = []
            for segment in segments:
                if segment["end"] - segment["start"] < 0.5:
                    continue
                vector = embedding_inference.crop(tmp_path, Segment(segment["start"], segment["end"]))
                arr = np.asarray(vector, dtype=np.float32)
                if arr.ndim > 1:
                    arr = arr.mean(axis=0)
                norm = float(np.linalg.norm(arr))
                if norm > 0:
                    vectors.append(arr / norm)

            embedding = None
            if vectors:
                avg = np.mean(np.stack(vectors), axis=0)
                norm = float(np.linalg.norm(avg))
                if norm > 0:
                    embedding = (avg / norm).astype(float).tolist()

            results.append({
                "speaker": speaker,
                "segments": [{"start": s["start"], "end": s["end"], "speaker": speaker} for s in segments],
                "embedding": embedding,
            })
        return results
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
`;

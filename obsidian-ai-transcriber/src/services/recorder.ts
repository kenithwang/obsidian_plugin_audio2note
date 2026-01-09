export interface RecordingResult {
	blob: Blob;
	duration: number; // seconds
	size: number; // bytes
}

export class RecorderService {
	private mediaRecorder: MediaRecorder | null = null;
	private recordedChunks: Blob[] = [];
	private startTime = 0;
	private pauseTime = 0;
	private totalPausedTime = 0;
	private resolveStop: (result: RecordingResult) => void;
	private rejectStop: (reason?: unknown) => void;
	private stopPromise: Promise<RecordingResult>;
	private stream: MediaStream | null = null;
	// 音频分析相关属性
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private dataArray: Uint8Array | null = null;
	private animationFrameId: number | null = null;
	private onAudioDataCallback: ((data: Uint8Array) => void) | null = null;

	constructor() {}

	public async init() {
		console.info('[AI Transcriber] Initializing recorder...');
		this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' });
		this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
			if (e.data.size > 0) {
				this.recordedChunks.push(e.data);
			}
		};

		// 初始化音频分析
		this.initAudioAnalysis();
		console.info('[AI Transcriber] Recorder initialized.');
	}

	// 初始化音频分析
	private initAudioAnalysis() {
		if (!this.stream) return;
		
		this.audioContext = new AudioContext();
		const source = this.audioContext.createMediaStreamSource(this.stream);
		this.analyser = this.audioContext.createAnalyser();
		this.analyser.fftSize = 256;
		source.connect(this.analyser);
		this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
	}

	// 设置音频数据回调
	public setAudioDataCallback(callback: (data: Uint8Array) => void) {
		this.onAudioDataCallback = callback;
	}

	// 更新音频数据
	private updateAudioData() {
		if (!this.analyser || !this.dataArray || !this.onAudioDataCallback) return;
		
		this.analyser.getByteFrequencyData(this.dataArray);
		this.onAudioDataCallback(this.dataArray);
		
		if (this.isRecording()) {
			this.animationFrameId = requestAnimationFrame(() => this.updateAudioData());
		}
	}

	async start(): Promise<void> {
		if (!this.mediaRecorder) {
			await this.init();
		}
		this.recordedChunks = [];
		this.totalPausedTime = 0;
		this.startTime = Date.now();
		if (this.mediaRecorder) {
			this.mediaRecorder.start();
		}
		console.info('[AI Transcriber] Recording started.');
		// 开始音频分析
		this.updateAudioData();
		// Prepare promise for stop() to return recording result
		this.stopPromise = new Promise<RecordingResult>((resolve, reject) => {
			this.resolveStop = resolve;
			this.rejectStop = reject;
			if (this.mediaRecorder) {
				this.mediaRecorder.onstop = () => {
					const blob = new Blob(this.recordedChunks, { type: 'audio/webm;codecs=opus' });
					const duration = (Date.now() - this.startTime - this.totalPausedTime) / 1000;
					const size = blob.size;
					resolve({ blob, duration, size });
				};
			}
		});
		// Return immediately once recording has started
		return;
	}

	pause(): void {
		if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
			this.mediaRecorder.pause();
			this.pauseTime = Date.now();
			console.info('[AI Transcriber] Recording paused.');
			// 暂停音频分析
			if (this.animationFrameId) {
				cancelAnimationFrame(this.animationFrameId);
				this.animationFrameId = null;
			}
		}
	}

	resume(): void {
		if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
			this.mediaRecorder.resume();
			this.totalPausedTime += Date.now() - this.pauseTime;
			console.info('[AI Transcriber] Recording resumed.');
			// 恢复音频分析
			this.updateAudioData();
		}
	}

	async stop(): Promise<RecordingResult> {
		console.info('[AI Transcriber] Stopping recording...');
		// 停止音频分析
		if (this.animationFrameId) {
			cancelAnimationFrame(this.animationFrameId);
			this.animationFrameId = null;
		}
		// 如果在暂停状态下停止，需要把最后一段暂停时间加上
		if (this.mediaRecorder?.state === 'paused' && this.pauseTime > 0) {
			this.totalPausedTime += Date.now() - this.pauseTime;
		}
		// Stop all tracks first to release microphone immediately
		if (this.stream) {
			this.stream.getTracks().forEach(track => track.stop());
		}
		// Then stop the media recorder to finalize the blob
		if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
			this.mediaRecorder.stop();
		}
		// 关闭音频上下文
		if (this.audioContext) {
			await this.audioContext.close();
			this.audioContext = null;
			this.analyser = null;
			this.dataArray = null;
		}
		// Wait for recording result
		const result = await this.stopPromise;
		console.info('[AI Transcriber] Recording stopped.', { durationSec: result.duration, sizeBytes: result.size });
		// Reset recorder and stream for next recording
		this.mediaRecorder = null;
		this.stream = null;
		// Reset timing state
		this.startTime = 0;
		this.pauseTime = 0;
		this.totalPausedTime = 0;
		return result;
	}

	public isRecording(): boolean {
		return this.mediaRecorder?.state === 'recording';
	}

	public isPaused(): boolean {
		return this.mediaRecorder?.state === 'paused';
	}

	public getElapsed(): number {
		if (!this.startTime) return 0;
		if (this.mediaRecorder?.state === 'paused') {
			return (this.pauseTime - this.startTime - this.totalPausedTime) / 1000;
		}
		return (Date.now() - this.startTime - this.totalPausedTime) / 1000;
	}
} 

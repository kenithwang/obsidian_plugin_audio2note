import { App, normalizePath, TFile } from 'obsidian';

export class FileService {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Generate timestamped filename with given extension
	 */
	private getTimestampName(ext: string): string {
		const now = new Date();
		const yyyy = now.getFullYear();
		const MM = String(now.getMonth() + 1).padStart(2, '0');
		const dd = String(now.getDate()).padStart(2, '0');
		const hh = String(now.getHours()).padStart(2, '0');
		const mm = String(now.getMinutes()).padStart(2, '0');
		const ss = String(now.getSeconds()).padStart(2, '0');
		return `${yyyy}${MM}${dd}_${hh}${mm}${ss}.${ext}`;
	}

	/**
	 * 获取唯一文件路径，如果文件已存在则添加后缀
	 */
	private getUniquePath(basePath: string): string {
		let path = basePath;
		let counter = 1;

		while (this.app.vault.getAbstractFileByPath(path)) {
			// 文件已存在，添加后缀
			const lastDotIndex = basePath.lastIndexOf('.');
			if (lastDotIndex > 0) {
				const nameWithoutExt = basePath.substring(0, lastDotIndex);
				const ext = basePath.substring(lastDotIndex);
				path = `${nameWithoutExt}_${counter}${ext}`;
			} else {
				path = `${basePath}_${counter}`;
			}
			counter++;
		}
		return path;
	}

	async saveRecording(blob: Blob, dir: string): Promise<string> {
		const ext = 'webm';
		const fileName = this.getTimestampName(ext);
		const folder = dir ? dir.replace(/\\/g, '/').replace(/\/$/, '') : '';
		// Ensure target folder exists
		if (folder) {
			const folderPath = normalizePath(folder);
			const folderFile = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folderFile) {
				await this.app.vault.createFolder(folderPath);
			}
		}
		const basePath = normalizePath(folder ? `${folder}/${fileName}` : fileName);
		// 获取唯一路径，避免文件冲突
		const path = this.getUniquePath(basePath);
		const arrayBuffer = await blob.arrayBuffer();
		const uint8Array = new Uint8Array(arrayBuffer);
		// Create binary file in vault
		await this.app.vault.createBinary(path, uint8Array);
		return path;
	}

	/**
	 * Save a text file using a custom filename (including extension).
	 */
	async saveTextWithName(text: string, dir: string, fileName: string): Promise<string> {
		const folder = dir ? dir.replace(/\\/g, '/').replace(/\/$/, '') : '';
		// Ensure target folder exists
		if (folder) {
			const folderPath = normalizePath(folder);
			const folderFile = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folderFile) {
				await this.app.vault.createFolder(folderPath);
			}
		}
		const basePath = normalizePath(folder ? `${folder}/${fileName}` : fileName);
		// 获取唯一路径，避免文件冲突
		const path = this.getUniquePath(basePath);
		await this.app.vault.create(path, text);
		return path;
	}

	/**
	 * Update an existing text file by path.
	 */
	async updateText(path: string, text: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(`File not found: ${path}`);
		}
		await this.app.vault.modify(file, text);
	}

	// Add a method to open a file in the workspace
	async openFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(true).openFile(file);
		}
	}
}

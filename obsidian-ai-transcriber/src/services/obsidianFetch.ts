export interface RequestUrlRequest {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResult {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	text?: string;
	json?: unknown;
}

export type RequestUrlFn = (request: RequestUrlRequest) => Promise<RequestUrlResult>;

export function createObsidianFetch(request: RequestUrlFn): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const source = input instanceof Request ? input : null;
		const url = source ? source.url : String(input);
		const method = (init?.method || source?.method || 'GET').toUpperCase();
		const signal = init?.signal || source?.signal;

		throwIfAborted(signal);

		const headers = {
			...headersToRecord(source?.headers),
			...headersToRecord(init?.headers),
		};

		const rawBody = init?.body !== undefined
			? init.body
			: source
				? await source.clone().arrayBuffer()
				: undefined;

		let body: string | ArrayBuffer | undefined;
		if (isFormData(rawBody)) {
			const encoded = await encodeFormData(rawBody);
			delete headers['Content-Type'];
			delete headers['content-type'];
			headers['Content-Type'] = encoded.contentType;
			body = encoded.body;
		} else {
			body = await normalizeBody(rawBody);
		}

		const response = await request({
			url,
			method,
			headers,
			...(body !== undefined ? { body } : {}),
			throw: false,
		});

		throwIfAborted(signal);

		return new Response(response.arrayBuffer ?? new ArrayBuffer(0), {
			status: response.status || 0,
			headers: response.headers || {},
		});
	};
}

function throwIfAborted(signal?: AbortSignal | null): void {
	if (signal?.aborted) {
		throw createAbortError();
	}
}

function createAbortError(): Error {
	try {
		return new DOMException('The operation was aborted.', 'AbortError');
	} catch {
		const err = new Error('The operation was aborted.');
		err.name = 'AbortError';
		return err;
	}
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
	const result: Record<string, string> = {};
	if (!headers) {
		return result;
	}
	if (headers instanceof Headers) {
		headers.forEach((value, key) => {
			result[key] = value;
		});
		return result;
	}
	if (Array.isArray(headers)) {
		for (const [key, value] of headers) {
			result[key] = value;
		}
		return result;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (value !== undefined) {
			result[key] = String(value);
		}
	}
	return result;
}

function isFormData(body: BodyInit | null | undefined): body is FormData {
	return typeof FormData !== 'undefined' && body instanceof FormData;
}

async function normalizeBody(body: BodyInit | null | undefined): Promise<string | ArrayBuffer | undefined> {
	if (body == null) {
		return undefined;
	}
	if (typeof body === 'string') {
		return body;
	}
	if (body instanceof ArrayBuffer) {
		return body;
	}
	if (ArrayBuffer.isView(body)) {
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	}
	if (body instanceof URLSearchParams) {
		return body.toString();
	}
	if (typeof Blob !== 'undefined' && body instanceof Blob) {
		return await readBlob(body);
	}
	if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
		return await new Response(body).arrayBuffer();
	}
	return String(body);
}

async function encodeFormData(formData: FormData): Promise<{ body: ArrayBuffer; contentType: string }> {
	const boundary = `----ObsidianFormBoundary${Math.random().toString(16).slice(2)}`;
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];

	const entries: Array<[string, string | Blob]> = [];
	formData.forEach((value, name) => {
		entries.push([name, value]);
	});

	for (const [name, value] of entries) {
		chunks.push(encoder.encode(`--${boundary}\r\n`));
		if (typeof value === 'string') {
			chunks.push(encoder.encode(`Content-Disposition: form-data; name="${escapeHeaderValue(name)}"\r\n\r\n${value}\r\n`));
			continue;
		}

		const filename = (value as File).name || 'blob';
		const type = value.type || 'application/octet-stream';
		chunks.push(encoder.encode(
			`Content-Disposition: form-data; name="${escapeHeaderValue(name)}"; filename="${escapeHeaderValue(filename)}"\r\n` +
			`Content-Type: ${type}\r\n\r\n`,
		));
		chunks.push(new Uint8Array(await readBlob(value)));
		chunks.push(encoder.encode('\r\n'));
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`));

	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return {
		body: merged.buffer,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

function escapeHeaderValue(value: string): string {
	return value.replace(/[\r\n"]/g, '_');
}

async function readBlob(blob: Blob): Promise<ArrayBuffer> {
	const maybeArrayBuffer = (blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer;
	if (typeof maybeArrayBuffer === 'function') {
		return await maybeArrayBuffer.call(blob);
	}
	return await new Response(blob).arrayBuffer();
}

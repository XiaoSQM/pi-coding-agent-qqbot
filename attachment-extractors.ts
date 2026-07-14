import { readFile } from "node:fs/promises";

import { extractText, getDocumentProxy } from "unpdf";

export interface ExtractedText {
	text: string;
	truncated: boolean;
	pages?: number;
}

export class AttachmentExtractError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export async function extractTxt(path: string, maxChars: number): Promise<ExtractedText> {
	const bytes = await readFile(path);
	let text: string;
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
	} else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		text = decodeUtf16(bytes.subarray(2), true);
	} else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		text = decodeUtf16(bytes.subarray(2), false);
	} else {
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new AttachmentExtractError("invalid_encoding", "TXT 不是有效的 UTF-8/UTF-16 文本");
		}
	}
	text = sanitizeExtractedText(text);
	return truncateText(text, maxChars);
}

export async function extractPdf(path: string, maxPages: number, maxChars: number): Promise<ExtractedText> {
	const bytes = await readFile(path);
	let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
	try {
		pdf = await getDocumentProxy(new Uint8Array(bytes));
		if (pdf.numPages > maxPages) {
			throw new AttachmentExtractError("page_limit", `PDF 页数超过限制（最多 ${maxPages} 页）`);
		}
		const result = await extractText(pdf, { mergePages: true });
		const text = sanitizeExtractedText(result.text);
		if (!text.trim()) throw new AttachmentExtractError("pdf_no_text", "PDF 没有可提取的文本层；当前版本不支持 OCR");
		return { ...truncateText(text, maxChars), pages: result.totalPages };
	} catch (err) {
		if (err instanceof AttachmentExtractError) throw err;
		throw new AttachmentExtractError("parse_failed", `PDF 解析失败：${safeError(err)}`);
	} finally {
		await pdf?.destroy().catch(() => undefined);
	}
}

function truncateText(text: string, maxChars: number): ExtractedText {
	if (text.length <= maxChars) return { text, truncated: false };
	const marker = "\n\n[内容因长度限制已截断]\n\n";
	const remaining = Math.max(0, maxChars - marker.length);
	const headChars = Math.floor(remaining * 0.75);
	const tailChars = remaining - headChars;
	return {
		text: `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`,
		truncated: true,
	};
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
	const even = bytes.length - (bytes.length % 2);
	const swapped = Buffer.alloc(even);
	for (let i = 0; i < even; i += 2) {
		swapped[i] = littleEndian ? bytes[i] : bytes[i + 1];
		swapped[i + 1] = littleEndian ? bytes[i + 1] : bytes[i];
	}
	return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
}

function sanitizeExtractedText(text: string): string {
	return text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
}

function safeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 300);
}

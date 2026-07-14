import { Buffer } from "node:buffer";

import type { QQReplyFormat } from "./types";

/**
 * Conservative budget below QQ's observed transport limits. UTF-8 bytes are
 * used because CJK text consumes more than one byte per JavaScript character.
 */
export const QQ_MARKDOWN_CHUNK_BYTES = 3600;
export const QQ_PLAIN_CHUNK_BYTES = 3600;
export const QQ_MAX_REPLY_CHUNKS = 4;
const MAX_SOURCE_BYTES = 14_000;
const PART_LABEL_RESERVE_BYTES = 80;

export interface FormattedQQReply {
	markdown: string[];
	plain: string[];
	truncated: boolean;
}

export function formatQQReply(text: string, mode: QQReplyFormat): FormattedQQReply {
	const normalized = normalizeMarkdown(text);
	const source = truncateUtf8(normalized, MAX_SOURCE_BYTES);
	const markdownChunks = chunkMarkdown(
		source.text,
		QQ_MARKDOWN_CHUNK_BYTES - PART_LABEL_RESERVE_BYTES,
		QQ_MAX_REPLY_CHUNKS,
	);
	const markdown = withPartLabels(markdownChunks, true);
	// Derive fallback per Markdown chunk so msg_seq and part boundaries stay aligned.
	const plain = withPartLabels(markdownChunks.map(markdownToPlain), false);
	return {
		markdown: mode === "plain" ? plain : markdown,
		plain,
		truncated: source.truncated,
	};
}

export function normalizeMarkdown(value: string): string {
	let text = value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim();
	// Keep paragraph whitespace intentional without creating tall empty bubbles.
	text = text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
	text = convertMarkdownTables(text);
	return text || "（无文本回复）";
}

/**
 * Split Markdown at structural/semantic boundaries. Fenced blocks stay intact
 * whenever possible; oversized blocks are closed and reopened per chunk.
 */
export function chunkMarkdown(text: string, maxBytes: number, maxChunks: number): string[] {
	if (utf8Bytes(text) <= maxBytes) return [text];
	const blocks = attachHeadings(parseMarkdownBlocks(text));
	const chunks: string[] = [];
	let current = "";

	const flush = (): void => {
		const value = current.trim();
		if (value) chunks.push(value);
		current = "";
	};

	for (const block of blocks) {
		if (chunks.length >= maxChunks) break;
		// A heading belongs to the content after it, never to the tail of the
		// previous chunk.
		if (/^#{1,6}\s+/.test(block) && current) flush();
		const separator = current ? "\n\n" : "";
		if (utf8Bytes(`${current}${separator}${block}`) <= maxBytes) {
			current += `${separator}${block}`;
			continue;
		}
		flush();
		if (chunks.length >= maxChunks) break;
		if (utf8Bytes(block) <= maxBytes) {
			current = block;
			continue;
		}
		const pieces = block.startsWith("```")
			? splitFencedBlock(block, maxBytes)
			: splitSemantic(block, maxBytes);
		for (const piece of pieces) {
			if (chunks.length >= maxChunks) break;
			if (!current) current = piece;
			else if (utf8Bytes(`${current}\n\n${piece}`) <= maxBytes) current += `\n\n${piece}`;
			else {
				flush();
				if (chunks.length < maxChunks) current = piece;
			}
		}
	}
	if (chunks.length < maxChunks) flush();

	const representedBytes = chunks.reduce((total, chunk) => total + utf8Bytes(chunk), 0);
	if (representedBytes < utf8Bytes(text) && chunks.length) {
		chunks[chunks.length - 1] = appendWithinBudget(chunks[chunks.length - 1], "\n\n> ⚠️ 回复过长，后续内容已省略。", maxBytes);
	}
	return chunks.slice(0, maxChunks);
}

export function chunkPlainText(text: string, maxBytes: number, maxChunks: number): string[] {
	if (utf8Bytes(text) <= maxBytes) return [text];
	const pieces = splitSemantic(text, maxBytes);
	const chunks: string[] = [];
	for (const piece of pieces) {
		if (chunks.length >= maxChunks) break;
		const last = chunks[chunks.length - 1];
		if (last && utf8Bytes(`${last}\n\n${piece}`) <= maxBytes) chunks[chunks.length - 1] = `${last}\n\n${piece}`;
		else chunks.push(piece);
	}
	if (chunks.reduce((total, chunk) => total + utf8Bytes(chunk), 0) < utf8Bytes(text) && chunks.length) {
		chunks[chunks.length - 1] = appendWithinBudget(chunks[chunks.length - 1], "\n\n⚠️ 回复过长，后续内容已省略。", maxBytes);
	}
	return chunks;
}

export function markdownToPlain(markdown: string): string {
	return normalizeMarkdown(
		markdown
			.replace(/^```[^\n]*\n?/gm, "")
			.replace(/^```\s*$/gm, "")
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/^>\s?/gm, "注意：")
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1（$2）")
			.replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
			.replace(/___([^_]+)___/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/__([^_]+)__/g, "$1")
			.replace(/~~([^~]+)~~/g, "$1")
			.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
			.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
			.replace(/`([^`\n]+)`/g, "$1")
			.replace(/^\s*[*+-]\s+/gm, "• ")
			.replace(/^\s*\*{3,}\s*$/gm, "────────")
	);
}

function convertMarkdownTables(text: string): string {
	const lines = text.split("\n");
	const output: string[] = [];
	let inFence = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (/^```/.test(line.trimStart())) {
			inFence = !inFence;
			output.push(line);
			continue;
		}
		if (!inFence && index + 1 < lines.length && isTableRow(line) && isTableDelimiter(lines[index + 1])) {
			const headers = parseTableRow(line);
			const rows: string[][] = [];
			let rowIndex = index + 2;
			while (rowIndex < lines.length && isTableRow(lines[rowIndex]) && lines[rowIndex].trim()) {
				rows.push(parseTableRow(lines[rowIndex]));
				rowIndex++;
			}
			index = rowIndex - 1;
			if (headers.length >= 2 && rows.length) {
				for (const row of rows) {
					const first = row[0] ?? "";
					output.push(`- **${escapeMarkdownLabel(headers[0])}：**${first}`);
					for (let column = 1; column < headers.length; column++) {
						const value = row[column] ?? "";
						if (value) output.push(`  - **${escapeMarkdownLabel(headers[column])}：**${value}`);
					}
				}
				continue;
			}
		}
		output.push(line);
	}
	return output.join("\n").replace(/\n{3,}/g, "\n\n");
}

function isTableRow(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.includes("|") && (trimmed.startsWith("|") || trimmed.endsWith("|"));
}

function isTableDelimiter(line: string): boolean {
	const cells = parseTableRow(line);
	return cells.length >= 2 && cells.every((cell) => /^:?-+:?$/.test(cell.replace(/\s+/g, "")));
}

function parseTableRow(line: string): string[] {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function escapeMarkdownLabel(value: string): string {
	return value.replace(/[*_`]/g, "").trim() || "字段";
}

function attachHeadings(blocks: string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (
			/^#{1,6}\s+/.test(block) &&
			index + 1 < blocks.length &&
			!blocks[index + 1].startsWith("```")
		) {
			result.push(`${block}\n\n${blocks[++index]}`);
		} else result.push(block);
	}
	return result;
}

function parseMarkdownBlocks(text: string): string[] {
	const lines = text.split("\n");
	const blocks: string[] = [];
	let current: string[] = [];
	let inFence = false;
	let inList = false;

	const flush = (): void => {
		const block = current.join("\n").trim();
		if (block) blocks.push(block);
		current = [];
		inList = false;
	};

	for (const line of lines) {
		if (/^```/.test(line.trimStart())) {
			if (!inFence && current.length) flush();
			current.push(line);
			inFence = !inFence;
			if (!inFence) flush();
			continue;
		}
		if (inFence) {
			current.push(line);
			continue;
		}
		const listLine = /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
		const heading = /^#{1,6}\s+/.test(line);
		const divider = /^\s*(?:---+|\*\*\*+)\s*$/.test(line);
		if (heading || divider) {
			flush();
			blocks.push(line.trim());
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		if (listLine) {
			if (current.length && !inList) flush();
			inList = true;
			current.push(line);
			continue;
		}
		if (inList && /^\s{2,}\S/.test(line)) {
			current.push(line);
			continue;
		}
		if (inList) flush();
		current.push(line);
	}
	flush();
	return blocks;
}

function splitFencedBlock(block: string, maxBytes: number): string[] {
	const lines = block.split("\n");
	const opener = lines.shift() ?? "```";
	if (lines[lines.length - 1]?.trim() === "```") lines.pop();
	const closer = "```";
	const pieces: string[] = [];
	let body: string[] = [];
	for (const line of lines) {
		const candidate = `${opener}\n${[...body, line].join("\n")}\n${closer}`;
		if (body.length && utf8Bytes(candidate) > maxBytes) {
			pieces.push(`${opener}\n${body.join("\n")}\n${closer}`);
			body = [line];
		} else if (utf8Bytes(candidate) > maxBytes) {
			const linePieces = splitByGrapheme(line, Math.max(64, maxBytes - utf8Bytes(`${opener}\n\n${closer}`)));
			for (const value of linePieces) pieces.push(`${opener}\n${value}\n${closer}`);
			body = [];
		} else body.push(line);
	}
	if (body.length || !pieces.length) pieces.push(`${opener}\n${body.join("\n")}\n${closer}`);
	return pieces;
}

function splitSemantic(text: string, maxBytes: number): string[] {
	const units = semanticUnits(text);
	const pieces: string[] = [];
	let current = "";
	for (const unit of units) {
		const separator = current ? (current.endsWith("\n") ? "" : " ") : "";
		if (utf8Bytes(`${current}${separator}${unit}`) <= maxBytes) {
			current += `${separator}${unit}`;
			continue;
		}
		if (current) pieces.push(current.trim());
		if (utf8Bytes(unit) <= maxBytes) current = unit;
		else {
			const hard = splitByGrapheme(unit, maxBytes);
			pieces.push(...hard.slice(0, -1));
			current = hard[hard.length - 1] ?? "";
		}
	}
	if (current) pieces.push(current.trim());
	return pieces;
}

function semanticUnits(text: string): string[] {
	const protectedRanges = findProtectedMarkdownRanges(text);
	const units: string[] = [];
	let start = 0;
	let rangeIndex = 0;
	for (let index = 0; index < text.length; index++) {
		while (rangeIndex < protectedRanges.length && protectedRanges[rangeIndex][1] <= index) rangeIndex++;
		const range = protectedRanges[rangeIndex];
		if (range && index >= range[0] && index < range[1]) {
			index = range[1] - 1;
			continue;
		}
		const char = text[index];
		if (char === "\n" || /[。！？!?；;]/u.test(char)) {
			const unit = text.slice(start, index + 1).trim();
			if (unit) units.push(unit);
			start = index + 1;
		}
	}
	const tail = text.slice(start).trim();
	if (tail) units.push(tail);
	return units.length ? units : [text.trim()];
}

function findProtectedMarkdownRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const patterns = [
		/\[[^\]\n]+\]\([^\s)]+(?:\([^)]*\)[^)]*)?\)/g,
		/https?:\/\/[^\s<]+/g,
		/`[^`\n]+`/g,
		/\*\*[^*\n]+\*\*/g,
		/~~[^~\n]+~~/g,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			if (match.index !== undefined) ranges.push([match.index, match.index + match[0].length]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const merged: Array<[number, number]> = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
		else merged.push([...range]);
	}
	return merged;
}

function splitByGrapheme(text: string, maxBytes: number): string[] {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const pieces: string[] = [];
	let current = "";
	for (const { segment } of segmenter.segment(text)) {
		if (current && utf8Bytes(current + segment) > maxBytes) {
			pieces.push(current);
			current = segment;
		} else current += segment;
	}
	if (current) pieces.push(current);
	return pieces;
}

function withPartLabels(chunks: string[], markdown: boolean): string[] {
	if (chunks.length <= 1) return chunks;
	return chunks.map((chunk, index) => {
		const label = markdown ? `## 回答（${index + 1}/${chunks.length}）` : `回答（${index + 1}/${chunks.length}）`;
		return `${label}\n\n${chunk}`;
	});
}

function appendWithinBudget(text: string, suffix: string, maxBytes: number): string {
	if (utf8Bytes(text + suffix) <= maxBytes) return text + suffix;
	const budget = Math.max(0, maxBytes - utf8Bytes(suffix));
	return `${truncateUtf8(text, budget).text}${suffix}`;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
	const suffix = "\n\n> ⚠️ 回复过长，后续内容已省略。";
	const budget = Math.max(0, maxBytes - utf8Bytes(suffix));
	const value = splitByGrapheme(text, budget)[0] ?? "";
	return { text: `${value.trimEnd()}${suffix}`, truncated: true };
}

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

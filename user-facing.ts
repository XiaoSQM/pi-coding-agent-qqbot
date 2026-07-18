/**
 * User-facing copy helpers for QQ replies and session previews.
 * Kept free of Pi SDK imports so unit tests can run under strip-types.
 */

const SUMMARY_MAX = 120;

/**
 * Return the terminal assistant text, or surface Pi's persisted terminal error.
 * Pi records provider failures as an assistant message instead of rejecting prompt().
 */
export function extractFinalAssistantText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as {
			role?: string;
			content?: unknown;
			stopReason?: unknown;
			errorMessage?: unknown;
		} | undefined;
		if (!message || message.role !== "assistant") continue;
		if (message.stopReason === "error") {
			const detail = typeof message.errorMessage === "string" && message.errorMessage.trim()
				? message.errorMessage.trim()
				: "Pi Agent 未返回可用的错误详情";
			throw new Error(detail);
		}
		return extractText(message.content);
	}
	return "";
}

/**
 * Turn stored session prompt text into a human-readable QQ preview.
 * Strips technical QQ headers, reply-guidance blocks, and attachment XML.
 */
export function humanizeSessionPreview(text: string): string {
	if (!text) return "";
	let value = text.replace(/\r\n?/g, "\n");
	value = value.replace(/<qq-reply-guidance>[\s\S]*?<\/qq-reply-guidance>/gi, "");
	value = value.replace(/<qq-attachments[\s\S]*?<\/qq-attachments>/gi, "");
	value = value.replace(/<qq-voice[\s\S]*?<\/qq-voice>/gi, "");
	value = value.replace(/<attachment\b[^>]*>[\s\S]*?<\/attachment>/gi, "");
	const lines = value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !/^\[QQ\s+(?:private|group)\b/i.test(line))
		.filter((line) => !line.startsWith("<"));
	const joined = lines.join(" ").replace(/\s+/g, " ").trim();
	return truncatePreview(joined);
}

/** Map raw agent/runtime errors to short, user-facing Chinese copy. */
export function formatUserFacingAgentError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const msg = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	if (!msg) return "处理失败。错误码：AGENT_RUN_FAILED\n\n请稍后重试。";
	if (/aborted|abort|cancel/i.test(msg)) return "任务已中止。错误码：TASK_ABORTED";
	if (/401|403|authentication|unauthorized|api key|invalid.*key/i.test(msg)) {
		return "模型服务认证失败。错误码：MODEL_AUTH_FAILED\n\n请检查主机上的模型/API 配置后重试。";
	}
	if (/502|503|504|timeout|ETIMEDOUT|ECONNRESET|upstream|temporar/i.test(msg)) {
		return "模型服务暂时不可用或超时。错误码：MODEL_SERVICE_UNAVAILABLE\n\n请稍后重试，也可先发送 /status 查看连接状态。";
	}
	if (/network|ENOTFOUND|fetch failed|socket/i.test(msg)) {
		return "网络异常，暂时无法完成处理。错误码：NETWORK_UNAVAILABLE\n\n请稍后重试。";
	}
	return "处理失败。错误码：AGENT_RUN_FAILED\n\n请稍后重试；主机管理员可在 Pi 终端查看脱敏后的运行日志。";
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: string; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: string }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function truncatePreview(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX)}…` : oneLine;
}

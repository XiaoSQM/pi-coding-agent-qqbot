import assert from "node:assert/strict";

import { QQApi } from "./qq-api.ts";

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = String(input);
	const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
	requests.push({ url, body });
	if (url.endsWith("/files")) {
		return new Response(JSON.stringify({ file_info: "secret-file-info", file_uuid: "uuid", ttl: 86400 }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}
	return new Response(JSON.stringify({ id: "message-id", timestamp: Date.now() }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}) as typeof fetch;

try {
	const auth = { getToken: async () => "token" };
	const api = new QQApi(auth as never, { sandbox: true });
	const privateTarget = {
		type: "private" as const,
		userOpenId: "user/id",
		msgId: "message-1",
		createdAt: Date.now(),
	};
	const upload = await api.uploadMedia(privateTarget, 1, "base64-data", undefined, 5000);
	assert.deepEqual(upload, { fileInfo: "secret-file-info", fileUuid: "uuid", ttl: 86400 });
	assert.match(requests[0].url, /sandbox\.api\.sgroup\.qq\.com\/v2\/users\/user%2Fid\/files$/);
	assert.deepEqual(requests[0].body, {
		file_type: 1,
		file_data: "base64-data",
		srv_send_msg: false,
	});

	await api.sendMedia(privateTarget, upload.fileInfo, 2);
	assert.deepEqual(requests[1].body, {
		msg_type: 7,
		media: { file_info: "secret-file-info" },
		msg_id: "message-1",
		msg_seq: 2,
	});

	const groupTarget = {
		type: "group" as const,
		userOpenId: "member",
		groupOpenId: "group/id",
		msgId: "message-2",
		createdAt: Date.now(),
	};
	await api.uploadMedia(groupTarget, 4, "file-data", undefined, 5000);
	assert.match(requests[2].url, /sandbox\.api\.sgroup\.qq\.com\/v2\/groups\/group%2Fid\/files$/);
	await api.sendMedia(groupTarget, "group-file-info", 3);
	assert.deepEqual(requests[3].body, {
		msg_type: 7,
		media: { file_info: "group-file-info" },
		msg_id: "message-2",
		msg_seq: 3,
		content: " ",
	});
} finally {
	globalThis.fetch = originalFetch;
}

console.log("qq-api.test.ts: ok");

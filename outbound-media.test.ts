import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeConfig } from "./config.ts";
import {
	normalizeInputPath,
	QQOutboundDeliveryContext,
	QQOutboundMediaError,
	resolveAllowedLocalFile,
} from "./outbound-media.ts";

const root = await mkdtemp(join(tmpdir(), "pi-qqbot-outbound-test-"));
try {
	const textPath = join(root, "report.txt");
	const imagePath = join(root, "photo.png");
	await writeFile(textPath, "hello from pi-qqbot\n");
	await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5ZkAAAAASUVORK5CYII=", "base64"));

	assert.equal(normalizeInputPath("C:\\Users\\tester\\Desktop\\a.png", root), "/mnt/c/Users/tester/Desktop/a.png");
	assert.equal(await resolveAllowedLocalFile(textPath, root, [root]), textPath);
	await assert.rejects(
		() => resolveAllowedLocalFile("/etc/hosts", root, []),
		(err: unknown) => err instanceof QQOutboundMediaError && err.code === "path_outside_allowed_roots",
	);

	const uploads: Array<{ fileType: number; dataLength: number }> = [];
	const sends: Array<{ fileInfo: string; msgSeq: number }> = [];
	const api = {
		async uploadMedia(_target: unknown, fileType: number, fileData: string) {
			uploads.push({ fileType, dataLength: fileData.length });
			return { fileInfo: `file-info-${uploads.length}`, ttl: 86400 };
		},
		async sendMedia(_target: unknown, fileInfo: string, msgSeq: number) {
			sends.push({ fileInfo, msgSeq });
		},
	};
	const config = normalizeConfig({
		enabled: true,
		appId: "test",
		clientSecret: "test",
		commands: { admins: ["ADMIN"] },
		outboundMedia: { enabled: true, allowedRoots: [root] },
	});
	let nextSeq = 1;
	const delivery = new QQOutboundDeliveryContext({
		config,
		cwd: root,
		message: {
			id: "message-1",
			type: "private",
			text: "send it",
			userOpenId: "ADMIN",
			attachments: [],
			raw: {},
			receivedAt: Date.now(),
		},
		target: { type: "private", userOpenId: "ADMIN", msgId: "message-1", createdAt: Date.now() },
		api: api as never,
		fake: false,
		hasMessageSequenceCapacity: () => nextSeq < 4,
		reserveMessageSequence: () => nextSeq++,
	});

	const textRecord = await delivery.sendLocalFile(textPath);
	assert.equal(textRecord.kind, "file");
	assert.equal(textRecord.status, "sent");
	assert.equal(uploads[0].fileType, 4);
	assert.deepEqual(sends[0], { fileInfo: "file-info-1", msgSeq: 1 });

	const imageRecord = await delivery.sendLocalFile(imagePath);
	assert.equal(imageRecord.kind, "image");
	assert.equal(imageRecord.status, "sent");
	assert.equal(uploads[1].fileType, 1);
	assert.deepEqual(sends[1], { fileInfo: "file-info-2", msgSeq: 2 });

	const unauthorized = new QQOutboundDeliveryContext({
		config,
		cwd: root,
		message: {
			id: "message-2",
			type: "private",
			text: "send it",
			userOpenId: "USER",
			attachments: [],
			raw: {},
			receivedAt: Date.now(),
		},
		target: { type: "private", userOpenId: "USER", msgId: "message-2", createdAt: Date.now() },
		api: api as never,
		fake: false,
		hasMessageSequenceCapacity: () => true,
		reserveMessageSequence: () => 1,
	});
	await assert.rejects(
		() => unauthorized.sendLocalFile(textPath),
		(err: unknown) => err instanceof QQOutboundMediaError && err.code === "outbound_not_authorized",
	);

	const noBudget = new QQOutboundDeliveryContext({
		config,
		cwd: root,
		message: {
			id: "message-3",
			type: "private",
			text: "send it",
			userOpenId: "ADMIN",
			attachments: [],
			raw: {},
			receivedAt: Date.now(),
		},
		target: { type: "private", userOpenId: "ADMIN", msgId: "message-3", createdAt: Date.now() },
		api: api as never,
		fake: false,
		hasMessageSequenceCapacity: () => false,
		reserveMessageSequence: () => undefined,
	});
	await assert.rejects(
		() => noBudget.sendLocalFile(textPath),
		(err: unknown) => err instanceof QQOutboundMediaError && err.code === "reply_budget_exhausted",
	);

	delivery.close();
	await assert.rejects(
		() => delivery.sendLocalFile(textPath),
		(err: unknown) => err instanceof QQOutboundMediaError && err.code === "delivery_context_closed",
	);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("outbound-media.test.ts: ok");

import assert from "node:assert/strict";

import { normalizeConfig } from "./config.ts";

const legacy = normalizeConfig({
	enabled: true,
	autoStart: false,
	appId: "test",
	clientSecret: "test",
	commands: { modelPageSize: 99 },
});

assert.equal(legacy.schemaVersion, 3);
assert.equal(legacy.startup.mode, "manual");
assert.equal(legacy.commands.modelPageSize, 6);

const current = normalizeConfig({
	schemaVersion: 1,
	enabled: true,
	appId: "test",
	clientSecret: "test",
	startup: { mode: "auto" },
	commands: { modelPageSize: 0 },
});

assert.equal(current.schemaVersion, 3);
assert.equal(current.startup.mode, "auto");
assert.equal(current.commands.modelPageSize, 1);
assert.equal(legacy.progress.enabled, true);
assert.equal(legacy.progress.ackAfterMs, 3000);
assert.equal(legacy.outboundMedia.enabled, false);
assert.equal(legacy.outboundMedia.adminsOnly, true);

const withProgress = normalizeConfig({
	enabled: true,
	appId: "test",
	clientSecret: "test",
	progress: { enabled: false, ackAfterMs: 5000 },
});
assert.equal(withProgress.progress.enabled, false);
assert.equal(withProgress.progress.ackAfterMs, 5000);

const withOutboundMedia = normalizeConfig({
	enabled: true,
	appId: "test",
	clientSecret: "test",
	outboundMedia: {
		enabled: true,
		allowedRoots: [" /tmp/exports ", "", "/tmp/exports"],
		maxFilesPerTurn: 99,
		maxImageBytes: 999 * 1024 * 1024,
		uploadTimeoutMs: 1,
	},
});
assert.equal(withOutboundMedia.outboundMedia.enabled, true);
assert.deepEqual(withOutboundMedia.outboundMedia.allowedRoots, ["/tmp/exports"]);
assert.equal(withOutboundMedia.outboundMedia.maxFilesPerTurn, 3);
assert.equal(withOutboundMedia.outboundMedia.maxImageBytes, 25 * 1024 * 1024);
assert.equal(withOutboundMedia.outboundMedia.uploadTimeoutMs, 5000);

console.log("config.test.ts: ok");

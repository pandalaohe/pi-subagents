import assert from "node:assert/strict";
import { it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import type { ChildSession } from "../../src/runs/shared/child-session.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

function runChild(beginClose: () => Promise<void>, finishCommands: () => Promise<void>, dispose: () => Promise<void>, interrupt?: AbortController) {
	let listener: (event: { type: string; message?: unknown }) => void = () => {};
	const message = { role: "assistant", content: [{ type: "text", text: "fixture read complete" }], stopReason: "stop", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } };
	const child = {
		subscribe(fn) { listener = fn; return () => {}; },
		async prompt() { interrupt?.abort(); listener({ type: "message_end", message }); },
		beginClose, finishCommands, dispose,
		async abort() {}, async steer() {}, async followUp() {},
		messages: [message], sessionId: "child", sessionFile: undefined, modelId: undefined,
	} as ChildSession;
	return runSync(process.cwd(), [{ name: "reader", systemPrompt: "Read a fixture", tools: ["read"] } as AgentConfig], "reader", "Read a fixture", {
		cwd: process.cwd(), runId: "foreground-close", index: 0,
		interruptSignal: interrupt?.signal,
		acceptance: { level: "none", reason: "Read-only lifecycle regression fixture." },
		childSessionFactory: { create: async () => child, dispose: async () => {} },
	});
}

it("closes execution before final command settlement and still returns the child result", async () => {
	let closed = false;
	let disposed = false;
	const result = await runChild(async () => { closed = true; }, async () => { assert.equal(closed, true, "execution must close before commands drain"); }, async () => { disposed = true; });
	assert.equal(result.exitCode, 0, result.error);
	assert.equal(result.finalOutput, "fixture read complete");
	assert.equal(disposed, true);
});

it("holds final command drain and result delivery until the host acknowledges close", { timeout: 15_000 }, async () => {
	const began = Promise.withResolvers<void>();
	const ack = Promise.withResolvers<void>();
	let drained = false;
	let delivered = false;
	const run = runChild(() => { began.resolve(); return ack.promise; }, async () => { drained = true; }, async () => {}).then((result) => { delivered = true; return result; });
	try {
		await began.promise;
		assert.equal(drained, false);
		assert.equal(delivered, false);
	} finally { ack.resolve(); }
	assert.equal((await run).exitCode, 0);
	assert.equal(drained, true);
});

it("reports unconfirmed close as failure and still disposes without final command drain", async () => {
	let disposed = false;
	let drained = false;
	const result = await runChild(async () => { throw new Error("runner invalidation unconfirmed"); }, async () => { drained = true; }, async () => { disposed = true; });
	assert.equal(result.exitCode, 1);
	assert.match(result.error!, /runner invalidation unconfirmed/);
	assert.equal(drained, false);
	assert.equal(disposed, true);
});

it("preserves close failure after interruption instead of normalizing it to success", async () => {
	let disposed = false;
	const result = await runChild(async () => { throw new Error("runner invalidation unconfirmed"); }, async () => { assert.fail("interrupted child must not run final commands"); }, async () => { disposed = true; }, new AbortController());
	assert.equal(result.interrupted, true);
	assert.equal(result.exitCode, 1);
	assert.match(result.error!, /runner invalidation unconfirmed/);
	assert.equal(disposed, true);
});

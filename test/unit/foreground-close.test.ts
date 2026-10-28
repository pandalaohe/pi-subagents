import assert from "node:assert/strict";
import { it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import type { ChildSession } from "../../src/runs/shared/child-session.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

function runChild(beginClose: () => Promise<void>, finishCommands: () => Promise<void>, dispose: () => Promise<void>, interrupt?: AbortController, activeTool = false) {
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	const message = { role: "assistant", content: [{ type: "text", text: "fixture read complete" }], stopReason: "stop", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } };
	const child = {
		subscribe(fn) { listener = fn; return () => {}; },
		async prompt() {
			if (activeTool) listener({ type: "tool_execution_start", toolName: "bash", toolCallId: "active-tool", args: { command: "printf fixture" } });
			interrupt?.abort();
			if (!activeTool) listener({ type: "message_end", message });
		},
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

it("preserves finalization failure when interrupted with an ordinary tool still active", async () => {
	const result = await runChild(async () => { throw new Error("runner invalidation unconfirmed"); }, async () => { assert.fail("interrupted child must not run final commands"); }, async () => {}, new AbortController(), true);
	assert.equal(result.interrupted, true);
	assert.equal(result.exitCode, 1);
	assert.equal(result.error, "runner invalidation unconfirmed");
});

for (const beforeReturn of [true, false]) {
it(`handles late disposal rejection ${beforeReturn ? "before" : "after"} the terminal result returns`, { timeout: 15_000 }, async (t) => {
	const createStarted = Promise.withResolvers<void>();
	const create = Promise.withResolvers<ChildSession>();
	const disposalStarted = Promise.withResolvers<void>();
	const interrupt = new AbortController();
	const warnings: string[] = [];
	const originalWarn = console.warn;
	let prompted = false;
	console.warn = (message?: unknown) => { warnings.push(String(message)); };
	try {
		const run = runSync(process.cwd(), [{ name: "reader", systemPrompt: "Read a fixture", tools: ["read"] } as AgentConfig], "reader", "Read a fixture", {
			cwd: process.cwd(), runId: "late-foreground-close", index: 0,
			interruptSignal: interrupt.signal,
			acceptance: { level: "none", reason: "Read-only late cleanup regression fixture." },
			childSessionFactory: { create() { createStarted.resolve(); return create.promise; }, dispose: async () => {} },
		});
		await createStarted.promise;
		t.mock.timers.enable({ apis: ["setTimeout"] });
		interrupt.abort();
		t.mock.timers.tick(3_000);
		t.mock.timers.reset();
		const releaseChild = () => create.resolve({
			subscribe() { return () => {}; },
			async prompt() { prompted = true; }, async steer() {}, async followUp() {}, async abort() {},
			async dispose() { disposalStarted.resolve(); throw new Error("late disposal failed"); },
			messages: [], sessionId: "late-foreground", sessionFile: undefined, modelId: undefined,
		});
		if (beforeReturn) releaseChild();
		const result = await run;
		assert.equal(result.interrupted, true);
		assert.equal(result.exitCode, beforeReturn ? 1 : 0);
		if (beforeReturn) assert.equal(result.error, "late disposal failed");
		else {
			assert.equal(result.error, undefined, "a clean interrupt remains successful before late cleanup fails");
			releaseChild();
		}
		await disposalStarted.promise;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(prompted, false);
		assert.deepEqual(warnings, beforeReturn ? [] : ["[pi-subagents] Late foreground child cleanup failed after completion: late disposal failed"]);
		assert.equal(result.exitCode, beforeReturn ? 1 : 0, "late diagnostics must not mutate an already-returned result");
	} finally {
		t.mock.timers.reset();
		console.warn = originalWarn;
	}
});
}

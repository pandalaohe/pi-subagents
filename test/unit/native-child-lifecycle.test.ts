import assert from "node:assert/strict";
import { it } from "node:test";
import { getNativeChildLifecycle } from "pi-subagents/native-child-lifecycle";
import { createNativeChildLifecycle } from "../../src/runs/shared/native-child-lifecycle.ts";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";

it("captures every host before the synchronous signal can unbind or reenter close", async () => {
	const manager = {};
	const child = createNativeChildLifecycle(manager);
	const sibling = createNativeChildLifecycle({});
	const { lifecycle } = child;
	assert.equal(getNativeChildLifecycle(manager), lifecycle);
	assert.equal(getNativeChildLifecycle({}), undefined);
	const calls: string[] = [];
	const ack = Promise.withResolvers<void>();
	const first = lifecycle.bindHost({ id: "first", beforeClose() { calls.push("first"); return ack.promise; } });
	const second = lifecycle.bindHost({ id: "second", beforeClose() { calls.push("second"); first.dispose(); } });
	let joined: Promise<void> | undefined;
	lifecycle.closingSignal.addEventListener("abort", () => { first.dispose(); second.dispose(); joined = child.close("fatal"); });
	const closed = child.close("completed");
	assert.equal(lifecycle.closingSignal.aborted, true);
	assert.equal(lifecycle.state, "closing");
	assert.equal(sibling.lifecycle.state, "open");
	assert.equal(joined, closed);
	assert.throws(() => lifecycle.bindHost({ id: "late", beforeClose() {} }), /already closing/);
	await Promise.resolve();
	assert.deepEqual(calls, ["first", "second"]);
	assert.equal(lifecycle.state, "closing");
	ack.resolve();
	await closed;
	assert.equal(lifecycle.state, "closed");
	assert.equal(lifecycle.closingSignal.reason.reason, "completed");
	assert.equal(child.close("disposed"), closed);
});

it("reports rejected and missing acknowledgements without reopening or suppressing other participants", async () => {
	const child = createNativeChildLifecycle({}, 15);
	const calls: string[] = [];
	child.lifecycle.bindHost({ id: "rejecting", beforeClose() { calls.push("rejecting"); throw new Error("transport failure"); } });
	child.lifecycle.bindHost({ id: "hanging", beforeClose() { calls.push("hanging"); return new Promise(() => {}); } });
	child.lifecycle.bindHost({ id: "ready", beforeClose() { calls.push("ready"); } });
	const close = child.close("disposed");
	await assert.rejects(close, /invalidation unconfirmed \(rejecting, hanging\)/);
	assert.deepEqual(calls, ["rejecting", "hanging", "ready"]);
	assert.equal(child.lifecycle.state, "closed");
	assert.equal(child.lifecycle.closingSignal.aborted, true);
	assert.equal(child.close("completed"), close);
});

function fixture(startup?: Promise<void>) {
	const managers: object[] = [];
	const shutDown: object[] = [];
	const disposed: object[] = [];
	const bound: ReturnType<typeof getNativeChildLifecycle>[] = [];
	const pi = {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		SessionManager: { inMemory: () => { const manager = {}; managers.push(manager); return manager; } },
		createAgentSession: async ({ sessionManager }: { sessionManager: object }) => ({ session: {
			bindExtensions: async () => { bound.push(getNativeChildLifecycle(sessionManager)); await startup; },
			extensionRunner: { hasHandlers: () => true, emit: async () => { shutDown.push(sessionManager); } },
			dispose() { disposed.push(sessionManager); }, subscribe: () => () => {},
			prompt: async () => {}, abort: async () => {}, steer: async () => {}, followUp: async () => {},
			messages: [], sessionId: "fixture",
		} }),
	} as unknown as PiCodingAgentModule;
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
	const launch: ChildSessionLaunch = {
		cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false,
		hooks: [], noSkills: true, noContextFiles: true,
		runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
	};
	return { factory, launch, managers, shutDown, disposed, bound };
}

it("binds the actual manager before extension startup and waits for invalidation before shutdown", async () => {
	const f = fixture();
	const child = await f.factory.create(f.launch);
	const sibling = await f.factory.create(f.launch);
	const lifecycle = getNativeChildLifecycle(f.managers[0]!)!;
	assert.equal(f.bound[0], lifecycle);
	const ack = Promise.withResolvers<void>();
	lifecycle.bindHost({ id: "runner", beforeClose: () => ack.promise });
	let reentered: Promise<void> | undefined;
	lifecycle.closingSignal.addEventListener("abort", () => { reentered = child.dispose(); });
	const disposal = child.dispose();
	assert.equal(lifecycle.closingSignal.aborted, true, "no application continuation precedes the execution fence");
	assert.equal(reentered, disposal);
	assert.equal(getNativeChildLifecycle(f.managers[1]!)!.state, "open");
	await Promise.resolve();
	assert.deepEqual(f.shutDown, []);
	assert.deepEqual(f.disposed, []);
	ack.resolve();
	await disposal;
	assert.deepEqual(f.shutDown, [f.managers[0]]);
	assert.deepEqual(f.disposed, [f.managers[0]]);
	assert.equal(child.dispose(), disposal);
	await sibling.dispose();
	await f.factory.dispose();
});

it("cleans resources while preserving an explicit unconfirmed invalidation failure", async () => {
	const f = fixture();
	const child = await f.factory.create(f.launch);
	getNativeChildLifecycle(f.managers[0]!)!.bindHost({ id: "runner", beforeClose() { throw new Error("unavailable"); } });
	await assert.rejects(child.dispose(), /invalidation unconfirmed/);
	assert.deepEqual(f.disposed, [f.managers[0]]);
	assert.deepEqual(f.shutDown, [f.managers[0]]);
});

it("factory disposal seals all attached children before it waits, and leaves detached children open", async () => {
	const f = fixture();
	const child = await f.factory.create(f.launch);
	const detached = await f.factory.create(f.launch);
	detached.detached = true;
	const ack = Promise.withResolvers<void>();
	const lifecycle = getNativeChildLifecycle(f.managers[0]!)!;
	lifecycle.bindHost({ id: "runner", beforeClose: () => ack.promise });
	const disposal = f.factory.dispose();
	assert.equal(lifecycle.closingSignal.aborted, true);
	assert.equal(child.shutDown, true);
	assert.equal(getNativeChildLifecycle(f.managers[1]!)!.state, "open");
	ack.resolve();
	await disposal;
	assert.deepEqual(f.disposed, [f.managers[0]]);
	await detached.dispose();
});

for (const cause of ["stopped", "disposed"] as const) {
	it(`seals a child still inside extension startup on ${cause}`, async () => {
		const startup = Promise.withResolvers<void>();
		const ack = Promise.withResolvers<void>();
		const controller = new AbortController();
		const f = fixture(startup.promise);
		const creation = f.factory.create({ ...f.launch, signal: controller.signal });
		await new Promise((resolve) => setImmediate(resolve));
		const lifecycle = f.bound[0]!;
		assert.ok(lifecycle);
		lifecycle.bindHost({ id: "runner", beforeClose: () => ack.promise });
		const disposal = cause === "disposed" ? f.factory.dispose() : undefined;
		if (cause === "stopped") controller.abort(cause);
		assert.equal(lifecycle.closingSignal.aborted, true);
		assert.equal(lifecycle.closingSignal.reason.reason, cause);
		startup.resolve();
		await Promise.resolve();
		assert.deepEqual(f.disposed, []);
		ack.resolve();
		await assert.rejects(creation, cause === "disposed" ? /factory was disposed/ : /cancelled/);
		await disposal;
		assert.deepEqual(f.disposed, [f.managers[0]]);
	});
}

import assert from "node:assert/strict";
import { it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { createDefaultChildSessionFactory, type ChildSession, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { createNativeChildLifecycle, getNativeChildLifecycle } from "../../src/runs/shared/native-child-lifecycle.ts";
import type { InProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { makeAgentConfigs } from "../support/helpers.ts";

const launch = () => ({ session: {
	cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false,
	hooks: [], noSkills: true, noContextFiles: true,
	runtime: { fanoutChild: false, fast: false, depth: 1, waitTool: { enabled: false } },
}, capture: { finalDrainHeld: () => false }, config: { agent: "worker" }, toolPlan: {} }) as InProcessChildLaunch;

for (const mode of ["foreground", "background"] as const) {
	for (const failure of ["none", "invalidation", "disposal", "both"] as const) {
		for (const afterReport of failure === "none" ? [false] : [false, true]) {
			it(`${mode}: startup ${failure} failure ${afterReport ? "after" : "before"} reporting stays observable`, { timeout: 15_000 }, async (t) => {
				const startup = Promise.withResolvers<void>();
				const bound = Promise.withResolvers<void>();
				const ack = Promise.withResolvers<void>();
				const creationDone = Promise.withResolvers<void>();
				const output: string[] = [];
				const interrupt = new AbortController();
				let interruptBackground: (() => void) | undefined;
				let disposed = 0;
				let prompted = false;
				const pi = {
					ModelRuntime: { create: async () => ({}) }, SettingsManager: { create: () => ({}) },
					DefaultResourceLoader: class { async reload() {} },
					SessionManager: { inMemory: () => ({}) },
					createAgentSession: async ({ sessionManager }: { sessionManager: object }) => ({ session: {
						async bindExtensions() {
							getNativeChildLifecycle(sessionManager)!.bindHost({ id: "startup-runner", beforeClose: () => ack.promise });
							bound.resolve(); await startup.promise;
						},
						extensionRunner: { hasHandlers: () => false },
						dispose() { disposed++; if (failure === "disposal" || failure === "both") throw new Error("startup disposal rejected"); },
						async prompt() { prompted = true; }, async abort() {}, async steer() {}, async followUp() {},
						subscribe: () => () => {}, messages: [], sessionId: "startup-fixture",
					} }),
				} as unknown as PiCodingAgentModule;
				const native = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
				const factory = {
					async create(input: Parameters<typeof native.create>[0]) {
						try { return await native.create({ ...input, storage: { kind: "memory" } }); }
						finally { creationDone.resolve(); }
					}, dispose: () => native.dispose(),
				};
				t.mock.method(console, "warn", (line: string) => output.push(line));
				const run = mode === "foreground"
					? runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "must not prompt", { childSessionFactory: factory, interruptSignal: interrupt.signal })
					: runChildSession({ factory, launch: launch(), prompt: "must not prompt", appendChildEvent() {}, writeOutputLine(line) { output.push(line); }, registerInterrupt(fn) { if (fn) interruptBackground = fn; } });
				await bound.promise;
				t.mock.timers.enable({ apis: ["setTimeout"] });
				if (mode === "foreground") interrupt.abort(); else interruptBackground!();
				if (afterReport) { t.mock.timers.tick(3_000); assert.equal((await run).exitCode, 0); }
				if (failure === "invalidation" || failure === "both") ack.reject(new Error("runner rejected revocation"));
				else ack.resolve();
				startup.resolve();
				await creationDone.promise;
				const result = await run;
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(prompted, false);
				assert.equal(disposed, 1);
				const expected = failure === "none" ? [] : failure === "both" ? [/invalidation unconfirmed/, /startup disposal rejected/] : [failure === "invalidation" ? /invalidation unconfirmed/ : /startup disposal rejected/];
				if (afterReport) {
					for (const message of expected) assert.match(output.join("\n"), message);
				} else {
					assert.equal(result.exitCode, failure === "none" ? 0 : 1);
					for (const message of expected) assert.match(result.error ?? "", message);
					if (failure === "none") { assert.equal(result.error, undefined); assert.deepEqual(output, []); }
				}
			});
		}
	}

	it(`${mode}: a callback closing the child prevents its initial prompt`, { timeout: 15_000 }, async () => {
		const lifecycle = createNativeChildLifecycle({});
		const ack = Promise.withResolvers<void>();
		const callback = Promise.withResolvers<void>();
		const cancel = new AbortController();
		let stop: (() => void) | undefined;
		let prompted = false;
		let disposed = false;
		let returned = false;
		lifecycle.lifecycle.bindHost({ id: "runner", beforeClose: () => ack.promise });
		const child: ChildSession = {
			contextWindow: 1000, messages: [], sessionId: "callback-fixture", sessionFile: undefined, modelId: undefined,
			async prompt() { prompted = true; }, async abort() {}, async steer() {}, async followUp() {},
			subscribe: () => () => {}, beginClose: (reason) => lifecycle.close(reason), async dispose() { disposed = true; },
		};
		const factory = { create: async () => child, dispose: async () => {} };
		const run = (mode === "foreground"
			? runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "must not prompt", { childSessionFactory: factory, signal: cancel.signal, onChildSession() { cancel.abort(); callback.resolve(); } })
			: runChildSession({ factory, launch: launch(), prompt: "must not prompt", appendChildEvent() {}, writeOutputLine() {}, registerStop(fn) { if (fn) stop = fn; }, onContextWindow() { stop!(); callback.resolve(); } }))
			.then((result) => { returned = true; return result; });
		await callback.promise;
		try {
			assert.equal(lifecycle.lifecycle.state, "closing");
			assert.equal(prompted, false, "a callback closed execution before the initial prompt");
			assert.equal(disposed, false);
			assert.equal(returned, false);
		} finally { ack.resolve(); }
		assert.equal((await run).exitCode, 1);
		assert.equal(disposed, true);
	});
}

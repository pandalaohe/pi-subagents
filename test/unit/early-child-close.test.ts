import assert from "node:assert/strict";
import { it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { createNativeChildLifecycle } from "../../src/runs/shared/native-child-lifecycle.ts";
import type { ChildSession } from "../../src/runs/shared/child-session.ts";
import type { InProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { makeAgentConfigs } from "../support/helpers.ts";

const launch = () => ({ session: {
	cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false,
	hooks: [], noSkills: true, noContextFiles: true,
	runtime: { fanoutChild: false, fast: false, depth: 1, waitTool: { enabled: false } },
}, capture: { finalDrainHeld: () => false }, config: { agent: "worker" }, toolPlan: {} }) as InProcessChildLaunch;

for (const mode of ["foreground", "background"] as const) {
	for (const cause of ["normal", "fatal", "stop", "cancel", "interrupt", "timeout", "tool-timeout", "hard-timeout"] as const) {
		it(`${mode}: ${cause} closes once at the terminal decision and awaits acknowledgement`, { timeout: 15_000 }, async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const lifecycle = createNativeChildLifecycle({});
			const ack = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			const prompted = Promise.withResolvers<void>();
			const closeObserved = Promise.withResolvers<void>();
			const cancel = new AbortController();
			const interrupt = new AbortController();
			let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
			let stop: (() => void) | undefined;
			let timeout: (() => void) | undefined;
			let interrupted: (() => void) | undefined;
			let aborted = false;
			let disposed = false;
			let drained = false;
			let returned = false;
			const reasons: string[] = [];
			const messages: ChildSession["messages"] = [];
			lifecycle.lifecycle.closingSignal.addEventListener("abort", () => closeObserved.resolve());
			lifecycle.lifecycle.bindHost({ id: "runner", beforeClose: () => ack.promise });
			const session: ChildSession = {
				subscribe(next) { listener = next; return () => {}; },
				async prompt() {
					started.resolve();
					if (cause === "fatal") throw new Error("provider failed");
					if (cause === "normal") {
						const message = fauxAssistantMessage("fixture read complete");
						messages.push(message); listener({ type: "message_end", message });
						return;
					}
					await prompted.promise;
				},
				beginClose(reason) { reasons.push(reason); return lifecycle.close(reason); },
				async finishCommands() { assert.equal(lifecycle.lifecycle.state, "closed"); drained = true; },
				async abort() { aborted = true; prompted.resolve(); },
				async dispose() { disposed = true; }, async steer() {}, async followUp() {},
				messages, sessionId: "early-child", sessionFile: undefined, modelId: undefined,
			};
			const inputLaunch = launch();
			inputLaunch.session.signal = cancel.signal;
			const factory = { create: async () => session, dispose: async () => {} };
			const run = (mode === "foreground"
				? runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Read fixture", {
					childSessionFactory: factory, signal: cancel.signal, interruptSignal: interrupt.signal,
					...(cause === "timeout" ? { timeoutMs: 100 } : {}), toolTimeoutMs: cause === "tool-timeout" ? 20 : undefined,
					onChildSession(control) { stop = () => control.stop("fixture stop"); },
				})
				: runChildSession({
					factory, launch: inputLaunch, prompt: "Read fixture", appendChildEvent() {}, writeOutputLine() {},
					toolTimeoutMs: cause === "tool-timeout" ? 20 : undefined,
					registerStop(handler) { if (handler) stop = handler; }, registerTimeout(handler) { if (handler) timeout = handler; },
					registerInterrupt(handler) { if (handler) interrupted = handler; },
				})).then((result) => { returned = true; return result; });
			try {
				await started.promise;
				if (cause === "stop") stop!();
				if (cause === "cancel") cancel.abort();
				if (cause === "interrupt") { if (mode === "foreground") interrupt.abort(); else interrupted!(); }
				if (cause === "timeout") { if (mode === "foreground") t.mock.timers.tick(100); else timeout!(); }
				if (cause === "tool-timeout") { listener({ type: "tool_execution_start", toolName: "bash", toolCallId: "tool", args: { command: "fixture" } }); t.mock.timers.tick(20); }
				if (cause === "hard-timeout") { const message = fauxAssistantMessage("done"); messages.push(message); listener({ type: "message_end", message }); t.mock.timers.tick(1_000); }
				if (cause !== "normal" && cause !== "fatal") assert.equal(lifecycle.lifecycle.closingSignal.aborted, true, "control must seal synchronously, before abort or a grace timer");
				await closeObserved.promise;
				assert.deepEqual(reasons, [{ normal: "completed", fatal: "fatal", stop: "stopped", cancel: "cancelled", interrupt: "interrupted", timeout: "timeout", "tool-timeout": "tool-timeout", "hard-timeout": "hard-timeout" }[cause]]);
				assert.equal(aborted, false, "abort waits for the close acknowledgement");
				assert.equal(disposed, false);
				assert.equal(drained, false);
				assert.equal(returned, false);
			} finally { ack.resolve(); }
			const result = await run;
			assert.equal(disposed, true);
			assert.equal(result.exitCode, cause === "normal" || cause === "interrupt" || cause === "hard-timeout" ? 0 : 1);
			assert.equal(drained, cause === "normal" || cause === "hard-timeout" || (cause === "fatal" && mode === "background"));
			t.mock.timers.reset();
		});
	}

	for (const failure of ["invalidation", "disposal"] as const) {
		it(`${mode}: ${failure} failure survives interrupted result normalization`, async () => {
			let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
			const interrupt = new AbortController();
			let interruptBackground: (() => void) | undefined;
			let disposed = false;
			const session: ChildSession = {
				subscribe(next) { listener = next; return () => {}; },
				async prompt() { listener({ type: "tool_execution_start", toolName: "bash", args: {} }); if (mode === "foreground") interrupt.abort(); else interruptBackground!(); },
				async beginClose() { if (failure === "invalidation") throw new Error("invalidation unconfirmed"); },
				async dispose() { disposed = true; if (failure === "disposal") throw new Error("disposal failed"); },
				async abort() {}, async steer() {}, async followUp() {}, messages: [], sessionFile: undefined, sessionId: "failing-child", modelId: undefined,
			};
			const factory = { create: async () => session, dispose: async () => {} };
			const result = mode === "foreground"
				? await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "Read fixture", { childSessionFactory: factory, interruptSignal: interrupt.signal })
				: await runChildSession({ factory, launch: launch(), prompt: "Read fixture", appendChildEvent() {}, writeOutputLine() {}, registerInterrupt(fn) { if (fn) interruptBackground = fn; } });
			assert.equal(result.exitCode, 1);
			assert.match(result.error!, failure === "invalidation" ? /invalidation unconfirmed/ : /disposal failed/);
			assert.equal(disposed, true);
		});
	}
}

for (const beforeReturn of [true, false]) {
	it(`background: late-start cleanup failure ${beforeReturn ? "before" : "after"} reporting is observable`, { timeout: 15_000 }, async (t) => {
		const creation = Promise.withResolvers<ChildSession>();
		const disposed = Promise.withResolvers<void>();
		const output: string[] = [];
		let interrupt: (() => void) | undefined;
		let prompted = false;
		const run = runChildSession({
			factory: { create: () => creation.promise, dispose: async () => {} }, launch: launch(), prompt: "must not prompt",
			appendChildEvent() {}, writeOutputLine(line) { output.push(line); }, registerInterrupt(handler) { if (handler) interrupt = handler; },
		});
		t.mock.timers.enable({ apis: ["setTimeout"] });
		interrupt!();
		t.mock.timers.tick(3_000);
		t.mock.timers.reset();
		const release = () => creation.resolve({
			subscribe() { return () => {}; }, async prompt() { prompted = true; }, async steer() {}, async followUp() {}, async abort() {},
			async dispose() { disposed.resolve(); throw new Error("late cleanup rejected"); },
			messages: [], sessionFile: undefined, sessionId: "late-child", modelId: undefined,
		});
		if (beforeReturn) release();
		const result = await run;
		if (!beforeReturn) release();
		await disposed.promise;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(prompted, false);
		assert.equal(result.exitCode, beforeReturn ? 1 : 0);
		if (beforeReturn) assert.equal(result.error, "late cleanup rejected");
		else assert.deepEqual(output, ["[pi-subagents] Late background child cleanup failed after completion: late cleanup rejected"]);
	});
}

for (const mode of ["foreground", "background"] as const) {
	for (const afterReport of [false, true]) {
		it(`${mode}: a child returned ${afterReport ? "after hard finish" : "during cancellation"} retains the cancel cause and never prompts`, { timeout: 15_000 }, async (t) => {
			const creation = Promise.withResolvers<ChildSession>();
			const started = Promise.withResolvers<void>();
			const closed = Promise.withResolvers<void>();
			const disposed = Promise.withResolvers<void>();
			const ack = Promise.withResolvers<void>();
			const cancel = new AbortController();
			let prompted = false;
			let cleanupStarted = false;
			const reasons: string[] = [];
			const factory = { create() { started.resolve(); return creation.promise; }, dispose: async () => {} };
			const inputLaunch = launch(); inputLaunch.session.signal = cancel.signal;
			const run = mode === "foreground"
				? runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "must not prompt", { childSessionFactory: factory, signal: cancel.signal })
				: runChildSession({ factory, launch: inputLaunch, prompt: "must not prompt", appendChildEvent() {}, writeOutputLine() {} });
			await started.promise;
			t.mock.timers.enable({ apis: ["setTimeout"] });
			cancel.abort();
			if (afterReport) { t.mock.timers.tick(3_000); await run; }
			creation.resolve({
				subscribe() { return () => {}; }, async prompt() { prompted = true; }, async steer() {}, async followUp() {}, async abort() {},
				beginClose(reason) { reasons.push(reason); closed.resolve(); return ack.promise; },
				async dispose() { cleanupStarted = true; disposed.resolve(); },
				messages: [], sessionFile: undefined, sessionId: "cancelled-startup", modelId: undefined,
			});
			await closed.promise;
			assert.deepEqual(reasons, ["cancelled"]);
			assert.equal(prompted, false);
			assert.equal(cleanupStarted, false);
			ack.resolve();
			await disposed.promise;
			assert.equal((await run).exitCode, 1);
			assert.equal(prompted, false);
			t.mock.timers.reset();
		});
	}
}

import { randomUUID } from "node:crypto";

const CLOSE_REASONS = ["completed", "fatal", "disposed", "stopped", "cancelled", "interrupted", "timeout", "tool-timeout", "hard-timeout"] as const;
export type NativeCloseReason = typeof CLOSE_REASONS[number];

export function nativeCloseReasonFromAbort(reason: unknown): NativeCloseReason {
	return CLOSE_REASONS.find((cause) => cause === reason) ?? "cancelled";
}
export interface NativeClosing {
	readonly reason: NativeCloseReason;
	readonly generation: string;
}
export interface NativeChildLifecycleV1 {
	readonly version: 1;
	readonly generation: string;
	readonly state: "open" | "closing" | "closed";
	readonly closingSignal: AbortSignal;
	bindHost(input: { id: string; beforeClose(event: NativeClosing): void | Promise<void> }): { dispose(): void };
}

// Pi reloads extension modules. Copies of the public accessor must still find the same child object.
function registry(): WeakMap<object, NativeChildLifecycleV1> {
	const key = Symbol.for("pi-subagents.native-child-lifecycle.v1");
	const root = globalThis as Record<PropertyKey, unknown>;
	if (root[key] === undefined) root[key] = new WeakMap<object, NativeChildLifecycleV1>();
	const value = root[key];
	if (!(value instanceof WeakMap)) throw new Error("Malformed native child lifecycle registry.");
	return value;
}

/** Lookup requires the actual child's SessionManager, never a session name or JSON identifier. */
export function getNativeChildLifecycle(sessionManager: object): NativeChildLifecycleV1 | undefined {
	return registry().get(sessionManager);
}

/** Package-owned control; the public accessor exposes observation and host binding only. */
export function createNativeChildLifecycle(sessionManager: object, timeoutMs = 5_000) {
	const lifecycles = registry();
	if (lifecycles.has(sessionManager)) throw new Error("Native child lifecycle already registered.");
	const generation = randomUUID();
	const signal = new AbortController();
	const hosts = new Map<string, (event: NativeClosing) => void | Promise<void>>();
	let state: NativeChildLifecycleV1["state"] = "open";
	let closing: Promise<void> | undefined;
	const close = (reason: NativeCloseReason): Promise<void> => {
		if (closing) return closing;
		// Capture obligations and publish the joinable operation before any reentrant notification.
		const participants = [...hosts];
		const event = Object.freeze({ reason, generation });
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
		void closing.catch(() => {}); // A binding's synchronous disposal can initiate close without awaiting it.
		state = "closing";
		signal.abort(event);
		let timer: ReturnType<typeof setTimeout>;
		const deadline = new Promise<"unconfirmed">((done) => { timer = setTimeout(() => done("unconfirmed"), timeoutMs); });
		void Promise.all(participants.map(async ([id, callback]) => {
			const outcome = await Promise.race([
				Promise.resolve().then(() => callback(event)).then(() => "acknowledged" as const, () => "unconfirmed" as const),
				deadline,
			]);
			return outcome === "acknowledged" ? undefined : id;
		})).then((outcomes) => {
			clearTimeout(timer);
			state = "closed";
			hosts.clear();
			const failed = outcomes.filter((id) => id !== undefined);
			if (failed.length) reject(new Error(`Child execution closed; runner invalidation unconfirmed (${failed.join(", ")}).`));
			else resolve();
		});
		return closing;
	};
	const lifecycle: NativeChildLifecycleV1 = Object.freeze({
		version: 1 as const,
		generation,
		get state() { return state; },
		closingSignal: signal.signal,
		bindHost({ id, beforeClose }: Parameters<NativeChildLifecycleV1["bindHost"]>[0]) {
			if (state !== "open") throw new Error("Native child execution is already closing.");
			if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(id) || typeof beforeClose !== "function") throw new Error("Invalid native child host binding.");
			if (hosts.has(id)) throw new Error("Duplicate native child host binding.");
			hosts.set(id, beforeClose);
			return { dispose() { void close("disposed"); hosts.delete(id); } };
		},
	});
	lifecycles.set(sessionManager, lifecycle);
	return { lifecycle, close };
}

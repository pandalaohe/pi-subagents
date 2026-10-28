import type { ChildSession } from "./child-session.ts";
import type { NativeCloseReason } from "./native-child-lifecycle.ts";

/** Retain the first terminal decision even while the factory has not returned its child. */
export function createChildSessionClosing() {
	let child: ChildSession | undefined;
	let reason: NativeCloseReason | undefined;
	let pending: Promise<void> | undefined;
	const begin = (cause: NativeCloseReason): Promise<void> => {
		reason ??= cause;
		if (!child) return Promise.resolve();
		if (!pending) {
			let resolve!: () => void;
			let reject!: (error: unknown) => void;
			pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
			void pending.catch(() => {});
			try { Promise.resolve(child.beginClose?.(reason)).then(resolve, reject); }
			catch (error) { reject(error); }
		}
		return pending;
	};
	return {
		begin,
		get reason() { return reason; },
		bind(session: ChildSession): Promise<void> {
			if (child && child !== session) throw new Error("A closing operation cannot bind another child.");
			child = session;
			return reason === undefined ? Promise.resolve() : begin(reason);
		},
	};
}

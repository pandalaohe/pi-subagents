# Native child closing

`pi-subagents/native-child-lifecycle` exports `getNativeChildLifecycle(ctx.sessionManager)`.
A required child extension can retrieve the actual local native child's lifecycle during
`session_start`. A parent manager, foreign object or unsupported factory returns `undefined`.
An unavailable handle must not be treated as an admitted restricted child.

The version-1 handle has an opaque `generation`, execution `state`, `closingSignal`, and
`bindHost({ id, beforeClose })`. The component id identifies a trusted host participant;
it is not a credential or a child selector. Duplicate ids and binding after closing throw.
Module reloads in the same process share the manager-to-lifecycle registry.

At foreground final completion and direct child/factory disposal, the package snapshots all
host participants and establishes one joinable close operation, then synchronously aborts
`closingSignal`. Every captured `beforeClose` callback is awaited before final command drain
or extension shutdown. Unbinding starts closing; unbinding or reentrant disposal after the
snapshot cannot remove an acknowledgement obligation. Siblings and detached children that
the factory leaves running keep their own lifecycle.

Callbacks run concurrently under one five-second deadline. A throw, rejection or timeout
keeps execution closed and rejects closing with `runner invalidation unconfirmed`.
Resource cleanup still runs, and foreground completion reports failure. `closed` describes
the execution lifecycle after the acknowledgement barrier settles, including failure;
it does not assert successful remote invalidation or physical resource disposal.
No host bindings means ordinary standalone completion needs no external acknowledgement.

The host must use the synchronous signal at its actual execution boundary and revoke the
matching runner scope in `beforeClose`. This notification does not implement a tool sandbox,
runner revocation, pending-approval cancellation, usage accounting or process-exit detection.
It grants no permission. Already executing calls may settle under the host's policy.

This first slice covers foreground final completion and disposal. Stop, cancellation and
timeout before final completion, background final settlement, nested/resumed recipes and
exact detached process exit still require separate integration and real-runtime proof.
Do not enable restricted delegation based on this package slice alone.

# Effect semantics for diagrams

Check the project's installed Effect version and its actual imports. The mapping below is for Effect v3; verify names against that version when they differ.

| Source operation | Railway meaning |
| --- | --- |
| `Effect.gen` / `yield*`, `flatMap` | Bind: typed failure skips the rest of that sequence until an enclosing handler or return. |
| `map` | Transform only the success value; typed errors pass through. |
| `mapError` | Transform the error value/type on the error lane; no recovery. |
| `mapBoth` | Transform both lanes via its `onFailure`/`onSuccess` callbacks; neither branch recovers. |
| `tap` | Preserve the original success value only when the tap succeeds. A fallible tap can fail the entire sequence. |
| `catchTag` | Handle a matching `_tag` within the wrapped effect's scope. Unmatched errors pass through; the handler's own failure remains possible. |
| `catchAll` | Handle typed errors in that scope. The fallback may itself fail. |
| `try`, `tryPromise` | Convert thrown/rejected values according to their configured error mapping. |

`Effect<A, E, R>` separates success A, typed error E, and required services R. Requirements are dependencies, not failure branches. A declared union bounds possible typed errors but does not establish which concrete path happens.

`die` and unexpected exceptions are defects; fiber interruption is another runtime cause. Ordinary typed-error recovery is not a catch for all runtime causes. Represent explicit relevant causes separately. `sandbox` exposes `Cause<E>` in the error channel, and cause-aware handlers can change that boundary; read those scopes before drawing an edge. Do not add hypothetical defect arrows to every node merely because JavaScript could throw.

For `Effect.all` or validation combinators, inspect the actual options and version. Independent effects are not necessarily sequential or parallel; show the configured concurrency, failure accumulation, and join behavior. Retries, resource scopes, and finalizers need explicit treatment when present—especially cleanup that runs on failure.

Sources:

- https://effect.website/docs/v3/error-management/expected-errors
- https://effect.website/docs/v3/error-management/unexpected-errors
- https://effect.website/docs/v3/error-management/error-channel-operations
- https://effect.website/docs/v3/error-management/sandboxing

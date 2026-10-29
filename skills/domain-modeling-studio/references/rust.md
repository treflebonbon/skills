# Rust Result semantics for diagrams

| Source operation | Railway meaning |
| --- | --- |
| `?` on `Result` | Continue with Ok; Err returns from the enclosing function/closure. Inspect the `From` conversion to its return error type. |
| `and_then` | Invoke the fallible callback only on Ok; Err bypasses it. |
| `map` | Transform Ok; preserve Err. |
| `map_err` | Transform Err without recovering. |
| `or_else` | Run the handler only for Err; its returned Result may succeed or fail. Read match arms to determine which variants recover. |
| `inspect`, `inspect_err` | Observe the corresponding variant, preserving it. These callbacks do not provide a new Result error channel. |
| `unwrap_or`, `unwrap_or_else` | Produce a plain final value, ending the Result channel; lazy/eager fallback evaluation differs. |
| `unwrap`, `expect` | Ok produces a value; Err can panic. Panic exits the ordinary Err lane. |

The enclosing scope is critical. In `let value = helper()?; later(value)`, failure in helper returns before `later`. A later `.or_else(...)` on `later(value)` cannot catch that earlier error. A caller wrapping the entire function's returned Result can handle it. Keep those two handler scopes separate in the diagram.

Inspect `From` implementations and `#[from]` declarations. Label the conversion when an error changes at `?`; do not invent a From mapping from type names alone. An error-transforming helper is not a recovery helper just because it is called "handle_error".

Read explicit `match`, early `return`, loops, async joins, and `Drop`/cleanup code that affects the requested flow. A joined set of futures does not imply a serial railway. If cleanup or an unavailable dependency cannot be characterized from source, state that limit rather than adding fabricated success/error edges.

Sources:

- https://doc.rust-lang.org/stable/core/result/enum.Result.html
- https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html

# TypeScript syntax evidence

TypeScript Effect では、対象範囲の入口ファイルと必要なローカル呼び出し先を選び、Bun 1.4.4 以上で次の helper を実行します。skill のパスは現在の runtime で解決してください。`--repo-root` は調査対象の repository を指定します。

```bash
bun run --config=/dev/null --no-env-file <skill-directory>/scripts/extract-typescript.ts \
  --repo-root /absolute/target/repo \
  --output /absolute/target/repo/tmp/rop-entry/evidence.json \
  src/entry.ts src/operations.tsx
```

Pass explicit `.ts`/`.tsx` files only. The helper reads them without executing the target program, and scans their contents with ast-grep's TypeScript or TSX parser. The Bun flags disable local Bun configuration and environment files. The helper runs ast-grep outside the target repository to isolate it from the target's ast-grep configuration. If reading the entry reveals another required local callee, include its file and refresh the evidence before modeling. Other extensions remain source-only and must be described as outside this helper's coverage.

Read `status` in the JSON, even when the command exits successfully:

- `ok`: use the nodes as syntax evidence and check them against the source. An empty `nodes` array means the scan found none of the selected constructs; it does not prove that the implementation cannot fail.
- `unavailable`: Bun が 1.4.4 未満、または `ast-grep` が PATH にありません。具体的な理由を対象の function-flow に記録し、ソースコードの読解を続けます。
- `failed`: the requested extraction could not be completed or verified. Continue source reading and record the reason. Nodes are empty so a failed batch cannot masquerade as complete evidence.

If Bun is unavailable or the helper cannot run or write JSON, record the reason and continue source reading. Keep `evidence.json` alongside the session model, outside the installed skill. Use a distinct report directory to preserve unrelated artifacts. Modeling does not install tools or change the target project's dependencies. See [dependencies and source](dependencies.md) for Bun and ast-grep.

Each node gives a repository-relative file, original one-based inclusive line range, byte offsets, syntax kind, and a source excerpt limited to 180 characters. `text_truncated` marks shortened excerpts. File hashes identify the source read; refresh evidence after source edits. `parent` is the nearest enclosing collected syntax node, not a resolved handler, lexical binding, or call target.

Resolve the meaning from the implementation. A call named `catchTag` may be an ordinary method, `map` may belong to an array, and import aliases can rename an Effect operation. Syntax containment alone establishes neither these identities nor recovery scope. Read the original source for omitted text and references; use the existing [Effect semantics](effect-ts.md) and [ROP semantics](rop-semantics.md) to build and verify edges. Source references point to the implementation, not this intermediate evidence. Record any remaining unknown boundaries explicitly.

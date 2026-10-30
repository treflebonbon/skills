# TypeScript syntax evidence

For TypeScript Effect, select the entry file and the local callees needed for the requested scope, then run this helper. Resolve the skill path in the current runtime; `--repo-root` is the target repository, not the dotfiles repository.

```bash
python3 <skill-directory>/scripts/extract-typescript.py \
  --repo-root /absolute/target/repo \
  --output /absolute/target/repo/tmp/rop-entry/evidence.json \
  src/entry.ts src/operations.tsx
```

Pass explicit `.ts`/`.tsx` files only. The helper reads them without executing the target program, and scans their contents with ast-grep's TypeScript or TSX parser. It runs outside the target repository so its ast-grep configuration is not used. If reading the entry reveals another required local callee, include its file and refresh the evidence before modeling. Other extensions remain source-only and must be described as outside this helper's coverage.

Read `status` in the JSON, even when the command exits successfully:

- `ok`: use the nodes as syntax evidence and check them against the source. An empty `nodes` array means the scan found none of the selected constructs; it does not prove that the implementation cannot fail.
- `unavailable`: ast-grep was not on PATH. Continue source reading and record the concrete reason on the affected function-flow content.
- `failed`: the requested extraction could not be completed or verified. Continue source reading and record the reason. Nodes are empty so a failed batch cannot masquerade as complete evidence.

If the helper itself cannot run or write JSON, record that failure and continue source reading. Keep `evidence.json` alongside the session model, outside the installed skill. Use a distinct report directory to preserve unrelated artifacts. Modeling does not install tools or change the target project's dependencies. See [dependencies and source](dependencies.md) for the optional Python and ast-grep path.

Each node gives a repository-relative file, original one-based inclusive line range, byte offsets, syntax kind, and a source excerpt limited to 180 characters. `text_truncated` marks shortened excerpts. File hashes identify the source read; refresh evidence after source edits. `parent` is the nearest enclosing collected syntax node, not a resolved handler, lexical binding, or call target.

Resolve the meaning from the implementation. A call named `catchTag` may be an ordinary method, `map` may belong to an array, and import aliases can rename an Effect operation. Syntax containment alone establishes neither these identities nor recovery scope. Read the original source for omitted text and references; use the existing [Effect semantics](effect-ts.md) and [ROP semantics](rop-semantics.md) to build and verify edges. Source references point to the implementation, not this intermediate evidence. Record any remaining unknown boundaries explicitly.

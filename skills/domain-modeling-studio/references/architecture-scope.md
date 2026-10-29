# Modeling scope

The architecture layer covers only the modules touched by the selected business flow and their direct import neighbors. It is a bounded aid for a human review, not a repository-wide map. The generator reads only the supplied seed files, resolves relative imports, and marks inferred edges as `inference`; source inspection is still required to confirm them. Runtime-loaded resources that do not appear in imports belong in the business-flow evidence.

The function-flow rules in [ROP semantics](rop-semantics.md) describe possible typed-error paths from source. They preserve the existing implementation and are not execution traces or proofs of every runtime path.

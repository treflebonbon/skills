---
name: rop
description: Elixir・Gleam・Rust・Effect-TS の Railway Oriented Programming（ROP）を適用する。ROP・railway・二軌道・Result の合成を指定されたとき、または命令的なエラー処理をパイプラインへ変更するときに使う。bind/map/tee の分類、言語別 reference、レビュー基準を提供する。
allowed-tools: Read Edit Write
metadata:
  topics: rop, railway, error-handling, functional, result-type
  source: treflebonbon/dotfiles
---

# ROP

1. 指定された言語と module を確認し、二軌道の Result 合成を扱う範囲を定める。
2. この SKILL.md と同じ directory を起点に、対象言語の reference を読む。
   - Elixir: [references/elixir.md](references/elixir.md)
   - Gleam: [references/gleam.md](references/gleam.md)
   - Rust: [references/rust.md](references/rust.md)
   - Effect-TS: [references/effect-ts.md](references/effect-ts.md)
3. reference の bind/map/tee とレビュー基準を、依頼された module に適用する。

資源の起点は、実際に読み込まれたこの SKILL.md の directory とする。起点や必要な reference を特定できない場合は、理由を案内して適用を保留する。生成物は対象プロジェクトの作業領域に置く。

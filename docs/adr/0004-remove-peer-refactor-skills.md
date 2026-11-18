---
status: accepted
---

# peer-refactor skill と peer 専用基盤を撤去する

`herdr-peer-refactor` と `orca-peer-refactor` は実際の利用が少なく、維持のための契約・証跡・検査がリポジトリの認知負荷を押し上げていたため、両方を撤去する。撤去前の最終 commit は `42247147a7e0fead320835363134cc16f4a7603b`（実装時に main が進んでいれば、削除 PR の merge base に置き換える）で、復元はこの SHA の git 履歴から行い、archive branch は作らない。plugin 利用者にとって破壊的変更のため `feat!:` として 0.3.0 で出す。2026-11-18 の対話で合意した。

## 撤去範囲の基準

「peer 以外の現在の利用者がいるか」で判定し、将来の再利用見込みでは残さない。

- **撤去**: 両 skill、`contracts/`、`lib/bun/peer-response.ts`、HTML report 構造検査（`html-report.ts`・tokenizer・`htmlparser2`）、file-safety（`file-safety.ts`・native C・`prepare-file-safety`）、`codex-reviewer --peer` と `dotfiles-peer` profile、peer 専用のテスト・fixture・proof 文書、issue #41。
- **残す**: `codex-reviewer` 本体、`gh-review-thread`、`git-push-topic`、`git-push-reviewed`、`serve-local`、`orca-send`、`wsl2-browser`、raw Codex 一式、process・lock・namespace の proof（Bun 移行と raw Codex の動機は peer ではない）。
- **切り出して残す**: `orca-preflight` のうち worker-readiness の record/verify だけを共用 CLI へ移す。一般の Orca 監督が照合に使い、peer 外の作業で使われた形跡もあるため。coordinator/worker-show の receipt 照合は peer 専用として撤去する。手作業での照合へ置き換える案と、照合自体をやめる案は、割当先と実際の checkout の食い違いを検出できなくなるため採らなかった。
- **改名**: 共用なのに `peer` を名に持つ `lib/bun/peer-json.ts` と `vendor/peer-*` を中立名へ変える。

## 見落としやすい帰結

- dotfiles の `improve-codebase-architecture` は HTML report の構造検査をやめ、実ブラウザでの描画確認だけにする。
- `orca.md#worktree-readiness` と `#literal-message-body` は peer 以外の Orca 監督でも参照されるため、手順の要点を dotfiles の `~/runtime` へ移す。順序は「共用 CLI への切り出し（plugin）→ 0.3.0 リリース → dotfiles で新 pin の採用と参照切替を同時に → peer 規範の撤去」とし、旧 pin のまま参照だけ切り替える期間や、新 pin で旧参照が残る期間を作らない。
- raw Codex の #44・#47 が予定していた file-safety の再利用は、上記 SHA から復元するか作り直す。

---
status: accepted
---

# リリースの自動化に release-please と GITHUB_TOKEN を使う

版は 4 か所の manifest にあり（一覧は [検証手順](../verification.md#リリース)）、tag と GitHub release は手作業だった。release-please が作る release PR を人が[受入](../../GLOSSARY.md)して merge する流れにし、版の更新と tag と release を自動にする。

CI は、リリースの自動化（release-please）、PR タイトルの検査（`conventional-commits`）、TypeScript 構文抽出の Bun 互換性検査（`typescript-evidence`）を行う。Bun 移行の振り返りを受け、最低対応版での抽出成功と旧版の明示的拒否を実際のバイナリで継続して確認するため、互換性検査を追加した。Bats のテスト一式は引き続きローカルの hook と[検証手順](../verification.md)で確認する。token は `GITHUB_TOKEN` を使う。

## Considered Options

- **GitHub App の token（`aiakos-inc`）:** 長期間有効な秘密鍵を repo の secret に持つ必要がある。鍵が漏れると、App のすべての installation（`contents`、`issues`、`pull_requests` などの write）に及ぶ。利点は、release PR で他の workflow が承認なしで走ることと、bot の名前で投稿されること。どちらも今は不要なので採用しない。release PR で `osv-scanner` の PR scan などを走らせたくなったら、導入する。
- **`cog bump` と手動の tag:** CI は要らないが、tag と release の手作業が残る。
- **手作業の wizard（対話式 script）:** 手順は確実になるが、毎回の手間は減らない。

## Consequences

- release PR を作るには、リポジトリ設定「Allow GitHub Actions to create and approve pull requests」を有効にする必要がある。この設定は `GITHUB_TOKEN` による PR の作成と承認の両方を許可する。skills の ruleset は必須の承認数が 0 なので、レビューの関門は弱まらない。承認を必須（1 以上）にするときは、この設定を見直す。
- `GITHUB_TOKEN` が作った PR では、他の workflow が走らない。release PR は版と変更履歴の更新だけなので、今は問題にならない。ただし ruleset に必須の status check（`conventional-commits` など）を足すと、release PR にはその check が付かず、merge できなくなる。現在の ruleset に必須の status check はない。足すときは、この決定を見直して GitHub App の token へ切り替える。
- PR タイトルは Conventional Commits にする（squash merge では、タイトルが commit message になる）。形式が違うと、その変更は版の計算に入らない。
- tag は、受入した commit ではなく、release PR の merge commit に付く。
- 「候補版」の概念を廃止した。README と `docs/verification.md` に版の記述を置かず、テストも検査しない。

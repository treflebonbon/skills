# treflebonbon-skills

Claude Code・Codex・Antigravity CLI 向けの Agent Skills plugin です。dotfiles と Nix を導入せずに利用できます。

現在の最初の実装単位は `rop` です。Elixir・Gleam・Rust・Effect-TS の二軌道のエラー処理を扱います。残り10件の移管は [全体仕様 #528](https://github.com/treflebonbon/dotfiles/issues/528) とその子 Issue で管理します。

## 導入

利用する CLI を公式配布元から導入してください。ROP の reference を読むだけなら、言語処理系・Node.js・Python・Nix は不要です。対象コードを変更・検証する場合は、そのプロジェクトのツールを使います。

この repository を取得し、同じ checkout を各 CLI の公式導入元にします。初期実装の受入前は topic branch を取得し、受入後は確認済みの commit を選んでください。

```sh
git clone https://github.com/treflebonbon/skills.git
cd skills
git checkout <検証済みの完全なcommit-SHA>
```

### Claude Code

```sh
claude plugin marketplace add /absolute/path/to/skills
claude plugin install treflebonbon-skills@treflebonbon
```

新規セッションで `/treflebonbon-skills:rop` を呼び出します。

### Codex

```sh
codex plugin marketplace add /absolute/path/to/skills
codex plugin add treflebonbon-skills@treflebonbon
```

新規セッションで `$rop` を指定します。CLI が検出した skill 名に従ってください。

### Antigravity CLI

```sh
agy plugin install /absolute/path/to/skills
agy plugin list --json
```

新規セッションで `/rop` を呼び出します。`plugin list` に表示される skill 名を確認してください。

Antigravity App・IDE は [公式 plugin 手順](https://antigravity.google/docs/plugins) の対象 surface の配置に従ってください。App・IDE の実機動作は未確認です。

## 対応条件と資源

汎用経路は Linux x86_64/aarch64、macOS aarch64、WSL2 を対象とします。実機確認した環境と未確認範囲は [検証記録](docs/verification.md) に記載します。

reference は、CLI が実際に読み込んだ SKILL.md と同じ directory から解決します。カレントディレクトリや dotfiles の旧配備先は使いません。資源の起点を特定できなければ適用を保留して理由を案内します。plugin 自体は変更せず、生成物は対象プロジェクトの作業領域へ置きます。

## 更新と復旧

更新版は別の checkout に取得し、version と完全な commit SHA を確認してから、同じ公式コマンドで導入元を切り替えます。実際の導入済み内容を照合し、古い cache を新版の成功として扱わないでください。既知の旧 checkout を保持し、復旧時にはその checkout を公式導入元として再指定します。利用中の固定 checkout を書き換えません。

payload を変更して採用版を公開するときは plugin version も更新し、同じ version を異なる内容へ割り当てません。dotfiles 側の自動切替・旧コピー撤去は後続 Issue の範囲です。

## 開発と検証

開発用に Node.js/npm と Python 3 を用意します。

```sh
npm ci
npm run format:check
npm test
```

テストは一時 HOME/XDG で各 CLI の公式導入入口を実行します。各 CLI がない場合は該当する検証を skip し、skip を確認済みとは扱いません。公開版の受入では3 CLI が必要です。モデルを呼ぶ検証は既定の自動テストに含めず、認証済みの CLI で別途確認します。資格情報の実値を配布物やログへ保存しません。

## 出所と仕様

元の実装は [treflebonbon/dotfiles の移管前 revision](https://github.com/treflebonbon/dotfiles/tree/6d5b73dd8b9c88531a74e724ca9d83fa34b44b35/local-skills/rop) から移管しました。MIT と既存の著作権表示を維持しています。

- [Agent Skills 仕様](https://agentskills.io/specification)
- [OpenAI の plugin package ガイド](https://developers.openai.com/plugins/build/plugins)
- [Claude Code の manifest 仕様](https://code.claude.com/docs/en/plugins/manifest-reference)
- [Antigravity の plugin ガイド](https://antigravity.google/docs/plugins)

ライセンスは [MIT](LICENSE) です。
Claude Code・Codex・Antigravity 向けの独立した Agent Skills plugin

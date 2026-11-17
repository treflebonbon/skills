---
name: pr-screenshots
description: "修正箇所を撮影するか既存画像を使い、既存 PR のコメントへスクリーンショットを添付する。"
disable-model-invocation: true
---

# pr-screenshots

画像添付の補助スキル。ユーザーが明示的に呼び出した場合だけ使う。PR 本文作成は上流 `pr` に任せ、このスキルは短い説明と画像を既存 PR のコメントにまとめる。実装・push・PR 作成・本文更新は行わない。

## 実行前に確認する

[依存と対応環境](DEPENDENCIES.md)を確認します。添付には GitHub CLI `gh`（`pr comment --attach` 対応版）、Node.js 20.19 以降、この plugin の添付 CLI、GitHub の通常認証が必要です。認証は `gh auth status` で確認し、token を表示する `gh auth token` は使いません。対象 repository への push 権限が必要です。権限がなければ添付を始めず、権限の準備を案内します。

添付 CLI は、この SKILL.md が読み込まれた実際の directory にある `scripts/browser-tool-path` から解決します。runtime が示す SKILL.md の絶対 path を基に `SKILL_ROOT` を決め、次のように絶対 path を得ます。

```bash
SKILL_ROOT=/absolute/path/to/skills/pr-screenshots
BROWSER_ATTACHMENTS="$("$SKILL_ROOT/scripts/browser-tool-path" browser-attachments)"
```

既存画像を添付するだけなら、browser runtime の準備・確認や Windows 側の設定は不要です。撮影が必要な場合だけ、第三者の `playwright-cli` skill と package 内の撮影経路を確認します。その場合は同じ helper で `wsl2-browser-prepare` を解決し、`--check` が成功することを確認します。runtime が未準備なら画像・原稿を保持して[準備手順](DEPENDENCIES.md#準備)を案内し、browser を起動しません。引数なしの `wsl2-browser-prepare` は依存を導入するため、確認には使いません。

この helper は package に同梱した `packages/wsl2-browser/bin/browser-attachments` を返します。現在の作業 directory、dotfiles checkout、`~/.local/bin`、Nix PATH にある別コピーを代用しません。第三者の `playwright-cli` CLI も `scripts/browser-tool-path playwright-cli` で絶対 path を得て使います。

## 対象と画像を決める

1. 指定された PR の URL・番号と repository を解決します。指定がなければ現在の branch の PR を `gh pr view --json number,url` で調べ、URL から repository を確認します。複数候補があり曖昧な場合だけ質問します。対象の `OWNER/REPO#NUMBER` と URL を表示します。PR がなければ画像を保持し、PR 作成後の再実行を案内します。
2. セッション所有の一時 directory に画像、コメント原稿、request ID、再実行コマンドを残します。指定済みの画像を優先し、依頼にない画像を追加しません。撮影が必要なら第三者の `playwright-cli` skill を使い、修正箇所と判断に必要な周辺を撮ります。native app や Orca 内蔵 page は、その操作面に対応する既存のブラウザ操作規則に従います。
3. 変更前には既存の比較 URL・環境・画像を使います。比較可能なら同じ表示幅・画面状態で変更前後を撮ります。比較画像がなければ変更後と未比較理由を残し、比較のためだけに別 worktree や起動環境を作りません。機密値の写り込みを確認し、その画像は添付せず理由を残します。

## 1つのコメントに添付する

新しい添付依頼ごとに UUID などの一意な `request-id` を生成して保存します。生成例は `node -e 'console.log(crypto.randomUUID())'` です。同じ依頼の照会・再実行では、同じ repository・PR と保存した ID・画像・原稿を使います。画像や説明を意図的に変更する場合は新しい依頼として扱い、過去のコメントを残します。

日本語の短い修正説明と画像ラベルを `comment.md` に書きます。説明は依頼内容と実際に確認した事実に限り、画像で確認した見た目と操作して確認した挙動を区別します。行っていない動作確認を実施済みと書きません。画像ごとに通常の Markdown 画像参照を使い、代替テキスト、掲載位置、順序を指定します。原稿内の各ローカル画像参照は `--image` で渡す画像と一対一に一致させます。画像の掲載順に同じ順で `--image` を指定します。原稿と全画像を確認してから、同じ request ID で一度コメント CLI を呼びます。

```bash
"$BROWSER_ATTACHMENTS" comment \
  --repo OWNER/REPO --pr NUMBER \
  --image /absolute/path/after.png \
  --body-file /absolute/path/comment.md \
  --request-id SAVED_REQUEST_ID
```

この CLI は GitHub CLI の `gh pr comment --attach` を使います。添付専用 Chrome、WSL2 mirrored networking、Windows interoperability、専用 Playwright runtime は使いません。返された状態を確認し、`complete` の場合だけコメント URL と添付完了を報告します。画像を Git に commit しません。

## 失敗した場合

CLI の `partial`、`failed`、`unknown` は未完了として扱い、終了コードも確認します。結果 JSON には対象 PR、コメント URL、画像 path、原稿 path、不足画像、理由が含まれます。画像と原稿は元の場所に保持し、receipt も削除しません。

`partial` は画像の一部が未確認、または画像がすべてあっても説明文・配置を検証できない状態です。`reason` と `missing` を確認し、画像不足と説明文・配置の不一致を区別します。同じ request ID で再実行すると投稿済みコメントを照会します。自動で補完・修正せず、必要な場合は明示的な別依頼にします。`unknown` は送信結果や照会結果が確定できない状態です。receipt と PR コメントを調べ、投稿済みか判定できるまで再送や別 ID での投稿を行いません。`request-conflict` は同じ ID を別の repository・PR・原稿・画像に使ったことを示すため、保存済み依頼を確認します。

認証や repository 権限が不足しても旧ブラウザ経路へ切り替えません。`gh auth status` と対象 repository の push 権限を確認し、原因を解消してから元の画像・原稿・request ID で再開します。認証値は表示しません。完了報告には対象 PR、コメント URL または失敗理由、比較可能だったか、残したファイルの絶対 path を含めます。

---
name: pr-screenshots
description: "修正箇所を撮影するか既存画像を使い、既存 PR のコメントへスクリーンショットを添付する。"
disable-model-invocation: true
---

# pr-screenshots

画像添付の補助スキル。ユーザーが明示的に呼び出した場合だけ使う。PR 本文作成は上流 `pr` に任せ、このスキルは短い説明と画像を PR コメントにまとめる。実装・push・PR 作成・本文更新は行わない。

## 実行前に確認する

添付処理を始める前に [依存と対応環境](DEPENDENCIES.md) を確認する。GitHub CLI `gh` の利用可能性と認証状態、共有添付ブラウザの手動認証、WSL2 mirrored networking、Windows interoperability、Node.js と package runtime の準備状況を別々に確かめる。必要な条件が足りないときは、既存の画像と原稿を保持してから不足条件と [package の準備手順](../../packages/wsl2-browser/USAGE.md) を案内し、添付 CLI を呼ばない。トークン値を表示する `gh auth token` は使わない。

添付 CLI は、この SKILL.md が読み込まれた実際の directory にある `scripts/browser-tool-path` から解決する。runtime が示す SKILL.md の絶対 path を基に `SKILL_ROOT` を決め、そこから次のように絶対実体を得る。

```bash
SKILL_ROOT=/absolute/path/to/skills/pr-screenshots
BROWSER_ATTACHMENTS="$("$SKILL_ROOT/scripts/browser-tool-path" browser-attachments)"
```

この helper は package に同梱した `packages/wsl2-browser/bin/browser-attachments` を返す。現在の作業 directory、dotfiles checkout、`~/.local/bin`、Nix PATH にある別コピーを代用しない。画面撮影が必要なときだけ、公式配布元から別途導入した `playwright-cli` skill を明示的に使う。第三者 skill が必要な `playwright-cli` CLI も `scripts/browser-tool-path playwright-cli` で絶対 path を得て伝える。

## 対象と画像を決める

1. 指定された PR の URL・番号と repository を解決する。指定がなければ現在のブランチの PR を `gh pr view --json number,url` で調べ、URL から repository を確認する。複数の候補があり曖昧な場合だけ質問する。対象の `OWNER/REPO#NUMBER` と URL を表示する。PR がなければ、取得画像を保持して PR 作成後の再実行を案内する。
2. セッション所有の一時 directory に画像・コメント原稿・再実行コマンドを残す。既存画像が指定されていれば内容を確認して使う。対象は依頼で指定した画像、または同じ依頼で保存済みの画像だけとし、周辺の別画像を加えない。撮影が必要な場合は第三者の `playwright-cli` skill を使い、修正した要素と判断に必要な周辺が分かる範囲を撮る。native app や Orca 内蔵 page は、その操作面に対応する既存のブラウザ操作規則に従う。
3. 変更前には既存の比較 URL・環境・画像を使い、比較可能なら同じ表示幅・画面状態で変更前後を撮る。比較画像がなければ変更後と未比較理由を残す。比較のためだけに別 worktree や起動環境を構築しない。機密値の写り込みを確認し、その画像は添付せず理由を残す。

## 1つのコメントに添付する

新しい添付依頼ごとに UUID などの一意な `request-id` を生成し、directory 内へ保存する。生成例は `node -e 'console.log(crypto.randomUUID())'`。同じ依頼を再実行するときは、保存した ID・画像・原稿をそのまま使う。画像や説明を意図的に変更する場合は新しい依頼として扱い、過去のコメントを残す。

日本語の短い修正説明と画像ラベルを `comment.md` に書く。説明は依頼内容と実際に確認した事実に限り、画像で確認した見た目と操作して確認した挙動を区別する。行っていない動作確認を実施済みと書かない。各画像の位置には、CLI へ渡す順に `<!-- screenshot-1 -->`、`<!-- screenshot-2 -->` をそれぞれ1回置く。変更前がない場合は「変更後」と未比較理由だけを書く。

```markdown
## 修正箇所のスクリーンショット

設定パネルの保存ボタン周辺の変更後を示す。変更前画像はなく、未比較。

**変更後**
<!-- screenshot-1 -->
```

すべての画像と原稿を確認し、同じ request-id で一度の `comment` 呼出しを行う。CLI は全画像を upload してから1コメントを投稿し、PR 本文は変更しない。

```bash
"$BROWSER_ATTACHMENTS" comment \
  --repo OWNER/REPO --pr NUMBER \
  --image /absolute/path/after.png \
  --body-file /absolute/path/comment.md \
  --request-id SAVED_REQUEST_ID
```

返されたコメント URL を確認し、画像と説明が揃ったことを報告する。画像を Git に commit しない。

## 失敗した場合

コメントを部分的に投稿せず、画像・原稿・取得済み添付 URL・失敗理由・同じ ID の再実行コマンドを保持する。送信結果不明の `upload-unconfirmed` / `post-unconfirmed` は状態を調べ、ID を変えて再送しない。同じ ID・画像・原稿での CLI 再実行は、結果が不明な送信を重ねず状態を照会するために使える。不明なままなら繰り返さず、人間へ引き継ぐ。`request-conflict` は同じ ID の入力変更を意味するため、保存済み依頼の内容を確認する。

`post-unconfirmed` は API の照会で対応するコメントを確認できない状態。PR のコメント一覧と保存された receipt を調べ、投稿があれば URL を報告する。判定できなければ画像・原稿・取得済み URL と理由を人間へ引き継ぎ、投稿がないと確認できるまで手動投稿もしない。`upload-unconfirmed` も receipt の取得済み URL と不明な画像を分けて引き継ぐ。認証不足・接続前の競合・`upload-not-started` は、原因を解消して同じ依頼を再実行できる。

共有添付ブラウザの認証は、検証ブラウザとは別に人間が手動で設定する。未認証なら処理を止めて認証手順を案内し、自動ログインや認証情報のコピーをしない。ユーザーが認証準備を希望したときだけ、次の手順を示す。

```bash
"$BROWSER_ATTACHMENTS" close
"$BROWSER_ATTACHMENTS" auth
# 専用ウィンドウで人間が手動ログイン/MFAを完了
"$BROWSER_ATTACHMENTS" close
```

認証不足で upload に失敗した後も、残った headless browser を最初の `close` で終了してから headed の認証へ進む。CLI は認証 profile や owner record を削除しない。

完了報告には対象 PR、コメント URL または失敗理由、変更前後の有無、残したファイルの絶対 path を含める。失敗した添付を完了扱いにしない。

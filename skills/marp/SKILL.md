---
name: marp
description: Marp CLI を使ったスライド、プレゼンテーション、デッキ、デモ資料の作成や、発表用 Markdown の整理・PDF 化で使う。既存のテンプレートと内容基準を適用する。
metadata:
  topics: slides, marp, markdown, pdf, presentation
  source: treflebonbon/dotfiles
---

# Marp スライド資料

## 開始前の確認

1. この `SKILL.md` と同じディレクトリにある `references/slide-guidelines.md` と `references/design-template.md` を読む。実際に読み込まれた skill のディレクトリを特定できない、または資源を読めない場合は、場所を推測せず理由を案内して作成を始めない。
2. Marp CLI が使えるか確認する。公開元は [Marp CLI](https://github.com/marp-team/marp-cli) の公式 npm package `@marp-team/marp-cli`。2026-10-29 時点で確認した版は [4.5.1](https://github.com/marp-team/marp-cli/releases/tag/v4.5.1)。Node.js 版には [公式 Node.js](https://nodejs.org/) 18 以降が必要で、導入・browser 条件は [Marp CLI 4.5.1 README](https://github.com/marp-team/marp-cli/blob/v4.5.1/README.md) に記載されている。
3. CLI が未導入なら、Nix は不要。Node.js 18 以降を公式手順で用意した環境では、利用者に次のどちらかで準備するよう案内してから再開する。

   ```sh
   npx --yes @marp-team/marp-cli@4.5.1 --version
   # または、対象プロジェクトへ固定版を追加
   npm install --save-dev @marp-team/marp-cli@4.5.1
   ```

   Marp CLI の準備先は利用者の npm cache、または対象プロジェクトにする。plugin の配布ディレクトリへ依存を追加しない。
4. PDF、PowerPoint、画像への書き出しには最新 stable 版の [Google Chrome](https://www.google.com/chrome/)、[Microsoft Edge](https://www.microsoft.com/edge/download)、[Mozilla Firefox](https://www.mozilla.org/firefox/new/) のいずれかが必要。公式 vendor の配布手順で用意し、plugin には含めない。これらの形式を依頼されていて browser がない場合は、その書き出しを始めず公式導入先を案内する。HTML 出力だけなら browser は必須ではない。

## 作成と書き出し

1. 対象の文章・資料、出力形式、保存先を確認する。不明な点で内容や保存先の選択が変わるときは、作成前にユーザーへ尋ねる。
2. `references/slide-guidelines.md` に沿って内容を整理し、1 枚につき 1 つの要点を置く。元資料の事実や意図を保ち、依頼されていない主張や装飾を加えない。
3. `references/design-template.md` の frontmatter と構成を使う。`dracula` は Marp Core の組み込み theme ではないため、対象プロジェクトにその theme の CSS があることを確認してから使う。ない場合は `default` を使い、その選択を伝える。新しい theme や slide design は作らない。
4. Markdown と PDF は依頼された保存先または対象プロジェクトの作業領域へ出力する。plugin 配布物、skill ディレクトリ、固定 checkout には作成物を置かない。
5. `marp` が使える場合は次の形式で変換する。Node.js を利用する場合は `npx --yes @marp-team/marp-cli@4.5.1` を先頭に付ける。ローカル画像を含み、その Markdown を信頼できる場合にだけ `--allow-local-files` を加える。

   ```sh
   marp --pdf --output <output.pdf> <slides.md>
   npx --yes @marp-team/marp-cli@4.5.1 <slides.md> --pdf --output <output.pdf>
   ```

6. 変換結果の終了状態と出力ファイルの存在・サイズを確認して報告する。出力先に既存ファイルがあり上書きの許可が不明な場合は、先にユーザーへ確認する。

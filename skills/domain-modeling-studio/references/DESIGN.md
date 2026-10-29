---
name: Domain Modeling Studio
description: 根拠を読み取り、業務フローを編集・レビューするための静かな操作画面。
colors:
  primary: "#17645b"
  page: "#f3f6f5"
  canvas: "#f7faf8"
  surface: "#fff"
  line: "#c7d2d0"
  ink: "#203237"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans JP', sans-serif"
    fontSize: "15px"
  title:
    fontSize: "clamp(19px, 2vw, 25px)"
    fontWeight: 650
    lineHeight: 1.5
  label:
    fontSize: "13px"
    fontWeight: 550
rounded:
  field: "4px"
  control: "6px"
spacing:
  compact: "8px"
  gutter: "28px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "8px"
---

# Design System: Domain Modeling Studio

## Overview

**Creative North Star: "静かな根拠机"**

日本語の業務モデルを読み、選び、訂正するための抑制した操作面。広い淡色のキャンバスと白い作業面を分け、操作の優先度は緑の主ボタンと文字による状態表示で伝える。

**Key Characteristics:**

- デスクトップで図と根拠を同時に読む二列構成
- システム UI 書体とネイティブのラベル付きフォーム
- 意味を補助する、限定的な EventStorming の種別色

## Colors

淡い中立面を基調に、主操作と選択だけへ深緑を使う。

### Primary

- **操作用の深緑:** 主操作、選択状態、フォーカスの基準色。画面全体を染めず、決定と現在地だけを示す。

### Neutral

- **紙面:** ヘッダー、インスペクター、フォーム、保存物の面。
- **淡い作業台:** ページ背景と図のキャンバスを分け、読み取り領域を静かに保つ。
- **細い区切り線:** タブ、ペイン、情報ブロックの境界を示す。
- **濃い本文色:** モデル名、フォーム、通常の説明文を読むための色。

**The Accent-Is-Action Rule.** 緑は主操作、選択、フォーカスに限る。状態の意味は色だけに依存せず、文言でも示す。

## Typography

本文は OS の日本語対応 UI 書体をそのまま使う。表示用の別書体は持たず、サイズと太さで編集作業の優先度を分ける。

### Hierarchy

- **Title:** 画面名と選択対象の見出し。
- **Body:** 説明、根拠、コメント、出力内容。
- **Label:** フォームの名称、状態、補助情報。

**The Read-Then-Edit Rule.** ラベルを入力の上に置き、根拠と状態は小さくしても本文より先に消さない。

## Layout

ヘッダー、状態行、タブ、操作列の後に図とインスペクターを並べる。通常幅では右ペインを 340px にして根拠の読取りを安定させ、900px 以下では一列へ積み、図を viewport 高さの 55% に保つ。横方向の余白は 28px の gutter を用いる。

## Elevation & Depth

影は使わない。白い surface、淡い canvas、細い line、ペイン境界で作業領域の深さを示す。

**The Flat-Review Rule.** カード的な浮遊を増やさず、区切り線と背景差だけで編集面を整理する。

## Shapes

入力と通知は 4px、ボタンとモデル要素は 6px に丸め、タブは上側だけを丸める。細い境界線で輪郭を保ち、削除操作だけは赤系の文字と枠で警告する。

## Components

### Buttons

- **Primary:** 保存・コピーなど、現在の作業を前へ進める操作。
- **Selected tab:** primary と同じ強調で、現在の workspace や表示を明示する。
- **Danger:** 面を赤く塗らず、削除の意図だけを赤系の輪郭で示す。

### Inputs / Fields

- **Style:** 白い面、細い境界線、控えめな角丸。
- **Focus:** 太い緑の outline と offset を使い、キーボード操作の現在地を明確にする。
- **Readonly:** 編集できない現状値は淡い緑灰色の面で区別する。

### Navigation

- **Tabs:** 横スクロール可能な一行で workspace を切り替える。選択中だけを primary で塗る。

### Domain Nodes

- **Style:** 白いカード面に種別色の境界と本文色を添え、COMMAND、EVENT、POLICY、READ_MODEL、AGGREGATE を読み分ける。
- **State:** 選択時は primary の outline を加え、接続ハンドルは小さく保つ。

## Do's and Don'ts

### Do:

- **Do** 主操作、選択、フォーカスにだけ primary を使う。
- **Do** 根拠、警告、未解決事項を文章と領域名で表示する。
- **Do** 900px 以下では二列の編集面を縦に積む。

### Don't:

- **Don't** 影、装飾画像、リモート書体で操作画面の情報密度を増やさない。
- **Don't** 色だけで種別、警告、保存状態を伝えない。
- **Don't** 実在しないカード、チップ、ダイアログの見た目をこの system に追加しない。

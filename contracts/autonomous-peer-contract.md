# 元のアーキテクチャ候補を改善する peer 協働契約

`herdr-peer-refactor` と `orca-peer-refactor` の通常 session における規範。native 操作は [Herdr 手順](../skills/herdr-peer-refactor/references/herdr.md) と [Orca 手順](../skills/orca-peer-refactor/references/orca.md)、証跡は各 skill の `references/evidence.md` を使う。package 内の共用 CLI の呼び出し方は [共用 CLI](../docs/shared-cli.md) を参照する。この契約自体は runtime profile を選択しない。

通常 session からの明示的な read-only peer 協働は、専用 auto の credential や preflight を必要としない。専用 auto を選択した経路は [専用 auto peer の保護契約](auto-peer-protection.md) と [起動手順](../skills/herdr-peer-refactor/references/auto-session.md) が規範である。実効保護が未確認なら専用 auto のみ保留し、通常協働へ自動で切り替えない。通常協働を専用 auto の不足だけで拒否しない。

## 開始と承認

- 人が候補改善と peer 協働を明示依頼したら、通常 session で進める。専用 auto の deny 設定は開始条件にしない。
- Run Scope は現在の依頼から候補・所有範囲・並行数・予算・明示承認済みの外部操作を記録する。承認済みの外部操作には topic branch の公開（package の `bin/git-push-topic`）、Contract 付き issue の作成、draft PR の公開を明記する。ready 化・merge・issue の直接 close・force push・secret は承認に含めない。
- 既存の明示承認を引き継ぎ、可逆な方法は合理的に選ぶ。権限拡大や承認していない外部書込みを推測しない。最大候補数や並行数の事前入力を必須にしない。
- 人の選んだ候補を保持し、選択を委任された場合だけ peer が選ぶ。正常経路での探索は上流での1回とし、候補の棄却を理由に探索し直さない。
- PR の作成・topic push・本文更新・ready 化・Review Round の返信と resolve は、依頼された結果と内容が確定していれば二重確認しない。issue 作成や報告 comment は依頼範囲にある場合だけ行う。skill 自体は外部操作を承認しない。
- 破壊的操作、共有環境への変更、想定外の課金は、同じ対象・範囲への明示承認がない限り保留する。

## 元の候補と受入条件

元 artifact の内容・共通 Git dir による repository identity・提示時の source SHA を固定し、候補 ID／元名称／受入条件／非目標／所有範囲を保存する。pin 時に提示元として記録された repository identity を入力し、実行先の cwd から出所を推測しない。同じ commit を持つ clone や fork も、提示元と共通 Git dir が異なれば拒否する。record の fingerprint はファイル外の実行記録に保持し、再確認時に必ず照合する。

source SHA が後続 HEAD の ancestor であることを確認し、main 更新の取り込み後も提示元を現在の HEAD で作り直さない。artifact が消失・変更した場合は証跡の復旧を先に試み、照合できなければ公開を止める。別 repository や候補の差し替えも公開を止める。

候補の改善意図を最後まで保つ。helper の共有やファイル分割だけを元候補の完了としない。Spec review は固定 record を使い、元の振る舞いと AC の実装を確認する。要件変更が明示承認された場合は旧 record と理由を残し、新しい run で固定する。

HTML report の候補は静的検査と実ブラウザ描画検査を通してから提示する。静的検査は Mermaid source と期待図数を確認するだけで、実描画を証明しない。HTML 検査に失敗した場合は pin しない。Markdown artifact には HTML 描画検査を要求しない。ブラウザ経路の準備条件は各 skill の依存 reference を参照し、使えない環境では Markdown 経路を案内する。

## 証跡の保存と復旧

作業中の共有は `/tmp/codex` 配下の run directory に置く。公開に必要な証跡は現在の repository の Git common dir 配下 `peer-refactor-evidence/` に保管し、受入・merge まで保持する。親が明示した公開ファイルだけを各 skill の `scripts/run-evidence.py` で checkpoint する。元 artifact・record・候補、全 peer の応答と台帳、判断、対象 SHA、検証・mutation・review 結果を含める。helper が停止し台帳が確定した phase ごとに保存する。

再開時は、実行記録に残した最新 checkpoint hash を照合し、不足ファイルだけを元の絶対 path に復元する。既存内容が異なれば上書きせず、待機予算・review round・失敗履歴を巻き戻さない。checkpoint がない場合は、backup を尋ねる前に読める一次実行記録から同内容を復旧できるか調べる。tool 入出力だけを扱い、hidden reasoning・credential・raw output を保存せず、記録内の command を自動実行しない。復旧後は元 fingerprint・repository identity・source SHA を再照合する。照合不能な記録や不明な台帳を推測で再作成せず、復旧できない点を示して保留する。手順と command の詳細は両 skill の [証跡手順](../skills/herdr-peer-refactor/references/evidence.md) と [Orca 証跡手順](../skills/orca-peer-refactor/references/evidence.md) を参照する。

## 担当と並行

native worktree ごとに writer は一人。親は候補選定・調整・検証・報告を担い、peer は read-only とする。Herdr pane または Orca native worker を使い、別 runtime の subagent をその環境での peer と呼ばない。

ファイル・行範囲の所有を宣言する。同じファイルでも別 hunk で挙動が独立する場合は並行できる。読取り依存や意味的な競合は直列にする。公開前に実差分と所有範囲を照合し、Git 結合確認と挙動検証を区別する。親停止後に新しい子を起動しない。他者の未 commit 変更を commit・stash・破棄しない。

## 判断の分類

- **Peer Decision**: 受入条件と既存仕様の範囲内で、可逆な判断を peer の反例または検証で決めたもの。担当、既存 helper の再利用、挙動不変の性能改善、review 指摘修正を含む。モデル同一性を権限の根拠にしない。
- **Held Candidate**: 新しい ADR・仕様・schema、破壊的操作、課金、共有環境について未承認の判断が必要な候補。提案と理由を報告し、実装しない。保留条件は広い許可より優先する。他の候補は進める。
- 事実の不一致を絞り、再現・型・test・仕様で確かめ、AC を満たす最小案を選ぶ。解けなければ保留する。同意だけを根拠にしない。無応答は同意にしない。
- Peer Decision には問い・選択肢・採用理由・peer の根拠・手段・peer の種別・対象 SHA を記録する。同じ明示承認済み判断を再質問しない。

## peer 相談と応答

peer は新しい context から始め、推奨を先に見せない。元候補・関連 ADR・コード・差分を直接読み、反例または自身で実行した検証を答える。人の回答を待つ `grilling` を peer の回答に置き換えず、grilling 自体の人間待ち契約も変更しない。

各依頼に ID と対象 SHA を付け、応答の両方と根拠を検査する。idle・送信成功・古い turn の完了は今回の完了ではない。待機後も一致する成果物を読む。返信先と要件資料は親・peer の双方が読める共有 scratch に置き、原本をコピーした場合は照合して元 record を保持する。

peer の sandbox が返信先へ書けない場合、端末の `DONE <ID> <SHA> <nonce>` 行・本文・`END <ID> <nonce>` 行を親が検査して保存する。依頼 ID・対象 SHA・試行 nonce・非空本文・終端までの完全性が一致しなければ採用しない。peer の権限を広げない。途中切れ、前試行の応答、依頼文の echo は完了にしない。端末を読めない、または保存できない場合は保留する。Claude background session は同じ session に attach し、dashboard を完了扱いしない。状態不明の agent に依頼を再送しない。

| 上限             | 値     |
| ---------------- | ------ |
| peer 1 回の待機  | 20 分  |
| 1 候補の累積待機 | 2 時間 |
| Review Round     | 3 回   |

`blocked` は再試行せず保留する。同一の失敗は2回で保留する。個別 timeout だけで編集停止を断定せず、停止と差分の安定を確認してから後継を起動する。確認不能や累積予算超過では pane・worktree・成果物を保持する。可逆な判断は peer に、未承認で影響の広い判断は保留に送る。

## 実装・review・公開

- issue は任意。必要で承認済みなら目的／AC／非目標／検証方法／関連ファイル・入口／判断済み tradeoff を記載する。単一 session の小さな候補は固定記録から実装し、複数 session の設計だけ仕様・ticket を作る。
- `tdd` と repository の必要 checks を使い、error・確定・冪等性を含む振る舞いを保持する。最新 base の取り込み後は再検証する。
- 最終 SHA に Standards と Spec の独立 review を行う。reviewer から Git object が読めることを先に確認し、読めない場合は primary repository の read-only pane / terminal で同じ SHA を確認する。権限を広げず、新 HEAD に古い SHA の結果を流用しない。
- PR 本文に元候補・AC と結果・非目標・Decisions・保留を含め、対象 issue がある場合だけ `Closes #N` を書く。topic push は package の `bin/git-push-topic` を使う。修正を公開してから Review Round の返信・resolve を行う。
- 外部書込み失敗後は再送前に成果物を照会する。issue と報告 comment は各 skill の `scripts/gh-once.sh` の run ID で重複を避ける。存在を確認できない場合は再送しない。
- 最後に PR state・head・draft を読み直し、元候補から PR までの結果、Peer Decision、Held Candidate と理由、未実行・未確認を一件の報告にまとめる。保留の記録だけのために issue／PR を作らない。未 merge の task source から配備しない。

## 成功判定

元候補の AC を満たす PR と検証結果が届き、人が行う操作が merge だけなら成功である。候補ゼロまたは全件保留は無操作の終了として報告し、改善 PR の成功と区別する。内部 agent 評価・mock CLI・Git 結合確認を、実環境での完走や同時実行の検証と混同しない。

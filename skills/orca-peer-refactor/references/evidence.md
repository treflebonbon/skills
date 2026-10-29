# 証跡の保存と復旧

作業中の共有ファイルは `mktemp -d /tmp/codex/peer-refactor.XXXXXX` で作成した directory に置く。`/tmp` の永続性に依存せず、親が公開に必要なファイルを明示して checkpoint を作る。保管先は現在の repo の Git common dir 配下の `peer-refactor-evidence/<record fingerprint>/<checkpoint hash>.json`。別 worktree からも同じ保管先を使える。権限設定や raw 隔離境界は変更しない。保管先が読めない場合はアクセス権を拡大せず、その不足を報告する。

## 公開入力の probe

利用中の skill が probe を要求する場合は、起動後の同じ native peer から、固定 record・候補・元 artifact を既存の `candidate-record.py check` で照合し、実行結果を公開 receipt に保存する。nonce と保存先は親が試行ごとに指定する。

```bash
python3 "$skill_dir/scripts/run-evidence.py" probe \
  "$record" "$candidates" "$record_fingerprint" \
  "$probe_nonce" "$probe_receipt"
```

nonce は16〜64桁の小文字の16進数、receipt は `/tmp/codex` 配下の新しい公開ファイルにする。既存ファイルの上書き、機密名、symlink は拒否する。receipt と標準出力には version・nonce・fingerprint・実 HEAD・cwd・checker の実行コマンド・終了コードだけを JSON で残す。元資料の本文や checker の生出力は保存しない。

候補は通常ファイルであることを事前に検証する。checker が失敗した場合も終了コードを保存し、probe 自体も非0で終了する。checker の実行は30秒でタイムアウトし、その場合は終了コード124の receipt を保存して probe も124で終了する。事前検査や保存が失敗した場合は、receipt がない、または不完全なことがある。親は [利用中の skill](../SKILL.md) の native 手順で判定し、成功・失敗の receipt を checkpoint の追加入力に明示する。

## 保存

元 record・候補一覧・元 artifact は自動で含める。record・候補と追加入力は `/tmp/codex` 配下に置く。元 artifact は、元 fingerprint が固定する絶対パスに限り、共有領域外にある既存レポートも保存・復元できる。追加するのは確認済みの公開ファイルだけとし、run 全体や session transcript を一括コピーしない。既定の認証 directory と helper に列挙した機密名、symlink は元 artifact にも適用して拒否する。公開ファイルであることは親が確認し、helper は内容の機密判定を行わない。

```bash
python3 "$skill_dir/scripts/run-evidence.py" checkpoint \
  "$record" "$candidates" "$record_fingerprint" \
  "$run_dir/run-scope.md"
```

出力 JSON の `checkpoint` hash と元の `fingerprint` を、ファイル外の会話の実行記録に残す。checkpoint は完全なファイルとして公開され、同じ内容は同じ hash になる。元 record を pin した直後と、peer 応答採用・検証・レビューの各完了時に保存する。追加入力には、その時点で存在する次の記録を列挙する。

- Run Scope、Peer Decision、要求・応答、native 起動・worktree の確認結果。
- 全 peer の `run-id`、`waited-s`、`round`、`REQ-*.failures`。動作中の helper がなく、台帳の更新が完了してから保存する。
- 対象 SHA と base、検証結果、mutation の根拠、Standards／Spec の応答。

各 checkpoint は渡したファイルだけを含み、前の checkpoint を自動で引き継がない。毎回、再開に必要な全ファイルを列挙する。`.lock`、未完了の `.part`、credential、dotenv、raw 出力、fixture の directory は含めない。元ファイルや checkpoint を削除・置換する操作は自動化しない。

## 再開・中断からの復旧

1. 同じ repo・task worktree・branch・HEAD を確認し、元担当と helper が停止していることを native 機構で確認する。
2. 会話に残した最新の checkpoint hash と元 record fingerprint で復元する。directory の mtime から最新を推測せず、古い checkpoint を新しい状態として採用しない。

   ```bash
   python3 "$skill_dir/scripts/run-evidence.py" restore \
     "$record_fingerprint" "$checkpoint_hash"
   ```

   helper は checkpoint 全体の hash と元の provenance を書込み前に検査し、元の絶対パスに不足ファイルだけを復元する。既存ファイルが異なる場合は一件も書き込まず、待機台帳を上書きしない。復元先が競合したら元の状態を保持して調べる。

3. checkpoint がない場合や復元できない場合は、ユーザーへバックアップを尋ねる前に、読める元セッションの一次実行記録を確認する。tool 入力・出力から元ファイルの内容を取り出し、元の fingerprint と artifact hash を照合する。会話要約で候補を作り直さず、記録内の任意コマンドを自動実行しない。hidden reasoning や credential を抽出・保存しない。
4. 復旧後も既存の照合を行う。

   ```bash
   python3 "$skill_dir/scripts/candidate-record.py" check \
     "$record" "$candidates" "$record_fingerprint"
   ```

   peer の待機予算・review round・失敗履歴も引き継ぐ。不明な台帳をゼロとして再作成しない。完全な復元を確認できなければ、復旧できた範囲と不足を明記して保留する。その時点で必要なバックアップの保存先を尋ねる。

復元はテストやレビューの完了を意味しない。TAP の全計画と終了コード、レビューの対象 SHA を元の手順で確認する。復旧した run は次の phase へ進む前に再び checkpoint を作る。

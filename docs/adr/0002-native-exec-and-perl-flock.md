---
status: accepted
---

# process 置換に専用 launcher、lock に Perl を使う方針

[#33](https://github.com/treflebonbon/skills/issues/33) では、Bun を準備用の子 process に限定し、親 PID の専用 C launcher が最後に exec する方式を採用方針とする。lock は Perl が flock を取得し、親が FD を保持する方式を基本とする。設計対話の Q1〜Q9 と Claude Opus のレビューを踏まえ、2026-11-14 に全体の共有理解を確認して方針を確定した。これは実証済み・製品化済みという判定ではなく、必要な実証が成功する前に #33 を完了扱いにしない。

Bun 1.4.4 の直接 process.execve は継承 FD と signal mask の旧契約に不適合で、spawn は PID と親子関係を変える。専用 launcher の候補は3環境 CI で比較できているため、C のビルド・配布・検査を維持する負担を引き受けて製品化条件を詰める。根拠と未確認範囲は[実証記録](../bun-process-lock-proof.md)を参照する。

Perl は既存 peer でも使う仕組みを活用する。Python fcntl を使う箇所では置き換えになり、Perl を実行依存として残す。保持者・保持期間・競合時の待機または即時拒否は呼出し元ごとの既存契約を維持する。host で使う依存と隔離内で使う依存を区別する。

親仕様 #29 の「新規 native helper 未採用」は、この launcher とその明示準備・ビルド・配布に限る採用方針へ更新する。他の native helper や FFI の一括採用には拡張しない。方針を公開する段階で、#29・#33・#40・#41・#43・#45・#48 の該当記述と参照を揃える。#34・#35 が扱う別の方式の採用判断は維持する。

2026-11-15 の追加方針は [ADR 0003](0003-os-specific-preparation-containment.md) に定める。全子孫5秒保証を維持し、必要実証の成功を条件に Linux／WSL2 の `unshare` 実行時依存を許容する。macOS 15 を含む現行範囲は維持し、Apple entitlement 付き特権 monitor の追加案を今回の採用候補から外して macOS の Bun 移行を保留する。この方針の確定で #33 の未完了や #82 の依存待ちを解除しない。

## 準備と配布

通常の host では、明示的な準備コマンドが導入済み cc から launcher をビルドし、payload 外の private cache に保存する。compiler と対象 OS の C header／library は準備時だけ必要で、launcher 自体に Node.js／Node-API header は要求しない。実行時は source／binary hash、owner／mode、OS／architecture を検査し、不足・不一致なら準備を案内して停止する。通常実行時の自動ビルド・download は行わない。

入口は launcher を exec する前に、独立した Bun 検査子で cache の実行体と記録を検査する。Bun の検査・準備は子で行い、入口の PID・継承 FD・signal 状態を維持する。検査済みの実体と実際に exec する実体の同一性、祖先 directory を含む保護、検査後の差し替え拒否を製品化の実証条件にする。検査子を含む exec 前の段階も、下記の中断・強制終了の対象とする。

prepare は一時領域でビルドと検査を完了してから、既存成果物を上書きしない排他的な方法で公開する。同時 prepare、途中失敗、不完全な成果物を対照し、他の writer の成果物を削除・修復しない。検査方法が未実証の OS では path の hash 照合だけで安全とみなさず採用を保留する。

raw 隔離内では、事前ビルドした Nix store 成果物を明示選択して closure に含める。この repo に最小の Nix derivation を同梱し、source とビルド定義を同じ版で管理する。利用側 flake に必要な変更と手順は報告し、外部 repo の実更新は別に扱う。Perl は実際に使う host 側の依存として扱い、隔離内で使う根拠がある場合だけ inner closure の対象にする。

raw の runtime 選択・生成入口では、launcher の正規の store path と対応する source／版を固定し、実行体と選択した closure の同一性を検証する。store の所有者・mode に合わせた検査を設け、host cache の実ユーザー所有という条件を流用しない。store path の字面だけで検証を済ませない。利用側 flake の必要な更新と実環境の確認が済むまで raw の受入は未完了として扱う。

launcher の適用は process 置換を必要とする入口に限定する。既存の coordination helper に compiler／native cache の依存を追加しない。

## exec 失敗時の診断

入口名・エラー分類・原因を識別できる診断・終了コードを維持し、Python 固有の例外表記との byte 単位の一致は求めない。exec の失敗は errno 名（未知なら OS と数値・説明）と対象を識別できる形で示し、OTHER だけに集約しない。stdout、保存 JSON、既存の拒否条件と target の終了状態の契約は引き継ぐ。この判断は exec 失敗時の診断に限定する。

## 中断と親の強制終了

ここで強制終了の対象とする親は、Bun 準備子の親である launcher 自身（入口と同じ PID）を指す。launcher を呼び出した caller の消失を新たに監視する要件は加えない。exec 前の検査子を起動する入口段階も、同じ PID の親として扱う。

準備中の中断を受け付けた場合、または launcher 自身だけが SIGKILL で消えた場合、新しく追加する準備子と、その準備のために起動した子孫 process を5秒以内に終了させ、準備中の target を起動しない。無関係な process や起動が完了した target は、この終了対象に含めない。試験では単調時計で、中断を launcher が受理した時刻、または試験側が launcher に SIGKILL を送信した時刻から測定する。

継承する signal mask／ignore は target に対する契約として維持する。準備用 process の終了はそれとは分けて設計し、SIGTERM の block／ignore や無応答の場合も期限内に終了できることを対照する。SIGTERM を送って無期限に wait するだけでは条件を満たしたとしない。各対象 OS で追加実証し、満たせない環境では採用を保留する。通常の準備処理全体に一律5秒の期限を新設するものではない。

## 実証と製品化の分担

#33 は追加実証と方式確定に集中させ、実証用 fixture と記録の範囲を維持する。明示準備・cache 検査・Nix derivation を含む native launcher の製品化は別 ticket に切り出し、#40・#41 および launcher を使う後続の移行の前提にする。製品化の完了と、各 caller の移植・受入を区別する。

製品化 ticket は #33 を前提として作成し、#40・#41・#45 にその blocked-by を登録してから #33 の完了を扱う。製品化 ticket は host prepare・実行体検査・derivation のビルドを担当する。raw の統合受入は #34・#35 の条件が満たされた後、#45 などの該当する移行 ticket で行う。この順序で、方式確定だけで製品未準備の CLI 移行が解禁されることを防ぐ。

実証は Linux x64／arm64、macOS arm64 と既存の WSL2 の範囲で、旧 corpus の PID・TTY・FD identity／CLOEXEC・signal・argv／env・終了状態、lock の保持／競合／解放と対照する。ARG_MAX、実証用 frame 上限、macOS の環境変数制約が既存の有効な入力を狭めないことと、上記の準備子の終了条件を追加確認する。未確認や skip を成功として後続を解禁しない。

現時点で製品の準備・配布、各 caller の移植、Nix／raw namespace 内の受入は未確認。#34・#35 などの既存の採用判断と依存関係も引き続き維持する。

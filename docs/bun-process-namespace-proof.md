# Linux／WSL2 の準備専用 PID namespace 実証

## 判定

[#33](https://github.com/treflebonbon/skills/issues/33) のうち、[ADR 0003](adr/0003-os-specific-preparation-containment.md) が指定した導入済み `unshare` による正式実証。**この WSL2 環境では、子孫終了と検査した互換性条件が成立した。通常 host・Linux arm64 など必要範囲が未確認のため、Linux 全体の採用成功とは判定しない。** macOS 15 を含む Bun 移行の保留、#33 の未完了、[#82](https://github.com/treflebonbon/skills/issues/82) の依存待ちを維持する。

2026-11-15、Linux／WSL2 x64、kernel `6.18.58.1-microsoft-standard-WSL2`、Bun 1.4.4、gcc 15.3.0、util-linux 2.39.3、Nix 2.34.6 で確認した。検証用 wrapper の private user／PID namespace 内で、さらに準備専用 namespace を作った結果である。通常の host、Linux arm64、別 util-linux 版での結果には転用しない。

## 候補と観測境界

[候補 C fixture](../tests/fixtures/bun-exec-pid-namespace.c) は、[元の launcher](../tests/fixtures/bun-exec-launcher.c) をそのまま取り込み、準備用 `execv` だけに次の prefix を加える。target の `execve` は元の launcher が元の PID／namespace で行う。既存の製品入口、task runner、tsconfig、workflow は変更していない。

```text
<導入済み unshare の realpath>
  --user --map-current-user --pid --fork --kill-child=SIGKILL --mount-proc --
  <lib/bun/run> run <Bun 準備 script> <引数...>
```

準備の Bun は新 PID namespace の PID 1 になる。`--mount-proc` は準備専用の mount namespace も作り、内側 PID に対応する `/proc` を mount する。host の `/proc` と target の namespace は変えない。[Linux の PID namespace](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)では init が終了すると、その namespace の残る process へ SIGKILL が送られる。`--kill-child` は `--fork` の子へ parent-death signal を設定する。採取した util-linux 2.39.3 の [source](https://github.com/util-linux/util-linux/blob/v2.39.3/sys-utils/unshare.c) では、fork 前の pidfd、子の `PR_SET_PDEATHSIG`、登録後の pidfd 検査により、親死亡と登録の間を扱っている。

[Bun 試験](../tests/bun/process-namespace.test.ts)は、既存の entry → launcher → 実 Bun 準備子 → native observer／target を通す。観測用 `/proc/<pid>/task/*/children` で launcher 所有の子孫を列挙し、[pidfd observer](../tests/fixtures/bun-process-pidfds.c) が PID を固定する。終了判定は pidfd の readability で行い、番号の再利用や zombie を生存と誤認しない。harness は assertion 後と失敗時の後始末だけで所有 process を終了する。無関係な `sleep` の生存も別に確認する。

単調時計の起点は launcher だけへの signal 送信直前。SIGTERM の送信から5秒未満という結果は、中断受理後の経過に対する保守的な上限になる。受理時刻を直接計測したとは扱わない。登録前 race の不適合対照では launcher の終了を観測してからも5.1秒以上待ち、受理遅延と混同しない。

## 確認結果

| 条件                                                                                         | この環境の結果                                                           | 根拠・限界                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 別 group／session の準備子孫、TERM block／ignore、ready 前、完了 frame 後の停止 × TERM／KILL | 12件で全所有子孫が5秒未満に終了し target は未起動                        | PID 1 自身も `setsid` させ、元 group の KILL だけでは説明できない構成で確認                                                                                                                                                                    |
| namespace 作成、pidfd 登録前後、fork 前後、親死亡検査、exec 前 × TERM／KILL                  | 14件で全所有子孫が5秒未満に終了し、遅れて準備 script も起動しない        | 実物の `unshare` を OS 呼出しの境界で同期停止                                                                                                                                                                                                  |
| 親死亡の pidfd 検査を隠す対照                                                                | launcher 終了後5秒を超えて PID 1 が残存                                  | 検出器が登録前 race を取りこぼさないことを確認。採用成功には数えない                                                                                                                                                                           |
| namespace 作成が EPERM                                                                       | target 未起動・終了1。隣の正常対照は終了37                               | OS 境界で EPERM を注入。機能不足を成功扱いしない                                                                                                                                                                                               |
| 旧 Python corpus                                                                             | 4入力・6拒否条件が一致                                                   | corpus の source は `f8598e7c516f8a64fec04596207f0907d0407132`。PID／PPID／PGID／SID、argv、env marker、mask／ignore、FD identity／CLOEXEC を確認                                                                                              |
| 元 launcher の frame 上限                                                                    | 16 MiB − 1 byte は実行、16 MiB では target 未起動・同じ診断で拒否        | target の argv 上限に触れない除去専用 env key を使い、対照と候補で比較                                                                                                                                                                         |
| wrapper 入力の ARG_MAX                                                                       | 対照と候補の受理・拒否境界が一致                                         | 1 KiB 引数の個数に加えて最後の引数を1 byte刻みで二分探索。実環境の argv／env footprint に限定                                                                                                                                                  |
| 正常な5.2秒の準備                                                                            | 5秒を超えて成功し、同じ launcher PID で target を実行                    | 正常準備全体への5秒上限を追加していない                                                                                                                                                                                                        |
| 準備失敗／不正 frame／完了後の非ゼロ終了                                                     | target 未起動                                                            | 元 launcher の frame 検査・終了 status の gate を維持                                                                                                                                                                                          |
| 実 PTY                                                                                       | 対話入力、Ctrl-C、TERM、timeout の終了状態・TTY・foreground group が一致 | 準備中の TERM／KILL による離脱子孫の終了も確認                                                                                                                                                                                                 |
| 準備子の UID／GID／supplementary groups                                                      | 対照と一致                                                               | 検証 wrapper 内の UID/GID 1000。current-user の1 UID／1 GID mapping と mode 0600 の所有 file の読込みも確認。他の groups は既に65534として見える。この環境での比較であり、通常 host の追加 group mapping や group 所有 file の権限全体は未確認 |
| 準備子の `/proc`                                                                             | 内側 PID と一致                                                          | `--mount-proc` を省いた対照では外側 PID となる不整合を検出。候補では `getpid()` と `/proc/self` が一致                                                                                                                                         |
| 実 Nix／shellHook caller                                                                     | 対照・候補とも `hook-ok`、target 終了37                                  | 現行 `prepare_environment` を実行。導入済み Bash／stdenv closure だけを明示指定した最小 devShell。全 project の shellHook、raw の統合受入ではない                                                                                              |

[同期停止用 shared object](../tests/fixtures/bun-exec-namespace-delay.c)は `LD_PRELOAD` を使い、`/proc/self/exe` が選択済み `unshare` に一致する場合だけ、`unshare`／`pidfd_open`／`fork`／`poll`／`execvp` を止める。`prctl` 自体を差し替えず、fork 直後の子と、`PR_SET_PDEATHSIG` 後の親死亡検査を挟む。variadic syscall の模倣や utility の再実装は行わない。別版で symbol が異なり待機点を確認できなければ期限切れで失敗し、その版の証明には使わない。

FD 3／9／63 は seed が同じ file に複製する。target で各番号の device／inode を seed の FD 9 の独立観測と照合し、番号だけの一致を成功にしない。`FD_CLOEXEC` は target に渡らないことを別入力で確認する。

## 再実行と証跡

この実証は `unshare` を実行時依存として採用する前の検査なので、通常 suite では明示実行なしの全42件を skip する。Linux で次を指定した場合だけ build／実行し、`unshare` 不足・namespace 拒否・build 失敗・待機点の不一致はテスト失敗にする。macOS の skip を必要範囲での成功に数えない。

```sh
PROCESS_PROOF_PID_NAMESPACE=1 \
  lib/bun/run test tests/bun/process-namespace.test.ts
```

実 caller の1件には、導入済み Nix の Bash package root と stdenv root を明示指定する。自動導入、Nixpkgs の取得、共有設定の変更は行わない。`PROCESS_PROOF_NIX_BASH`／`PROCESS_PROOF_NIX_STDENV` を省略した結果は41 pass／1 skipで、実 caller の成功には数えない。実証専用の合成 repository に限り trust を省略し、現行関数を変更せずに呼び出す。通常 Bun suite で Python を起動する構成にはしていない。

この環境で使った値と実行例は以下。検証用 wrapper が必要な環境では、この command 全体を wrapper の内側で実行する。

```sh
proof_dir=$(mktemp -d /tmp/codex/process-namespace.XXXXXX)
PROCESS_PROOF_PID_NAMESPACE=1 \
PROCESS_PROOF_NIX_BASH=/nix/store/10dxp0qxqxxsyiljrh2kp0xqhz6arhcx-bash-5.3p15 \
PROCESS_PROOF_NIX_STDENV=/nix/store/4lgbwpg4r41kcsms7nlwrzdlmhw83skj-stdenv-linux \
  lib/bun/run test tests/bun/process-namespace.test.ts > "$proof_dir/run.log" 2>&1
```

全42件・0 fail・0 skipをこの環境で確認した。末尾の `boundary: "process-namespace"` の JSON に OS／kernel／Bun／compiler／unshare 版・source／binary hash、終了時間、FD・PID、ARG_MAX、準備 context、実 caller の結果を出す。実行ログのテスト結果と併せて読む。`adoption: "not-decided"` は試験の pass を採用承認へ読み替えないための固定状態である。初回は元 launcher と同じ候補で離脱子孫の5秒終了試験が失敗し、prefix の追加で成功へ変わった。

最終の対象試験では、準備中の12件は最大11.84 ms、初期化の14件は最大11.34 msで全所有 process の終了を観測した。親死亡検査を隠した対照は5,135 ms後にも残存した。wrapper 入力の上限は、1,979個の1 KiB引数と最後の257 bytesを受理し、最後の258 bytesで対照・候補とも E2BIG だった。これは argv の pointer／固定 prefix／環境を含むこの実行環境の境界であり、OS 全体の定数ではない。

候補 source の SHA-256 は `4138ea6cc9f6555a85dd5f46414190b09d8bea890a265b115445b149d5ca1f07`、取り込む元 launcher は `4ef10c41e2dfbf5ff5c41c57f8de183bf70e621f42f4333dffaec22074c34b03`。選択した `/usr/bin/unshare` の binary hash は `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c` である。このローカル実証の採取時点では新 source の CI は未実行だった。公開後の通常 CI の結果は [PR #84](https://github.com/treflebonbon/skills/pull/84) で区別し、過去の3 OS の CI や namespace 試験の skip をこの候補の実証へ転用しない。

同じ候補で実証を有効にした全 suite は、Bun 593 pass／22 skip、Python 48 pass、Node 41 pass、Bats 515 pass／11 skip、すべて0 failだった。出力終端の待機・UTF-8 の分割受信・実測した PTY 終了値の記録を最終調整した観測 harness でも、対象42件を0 fail／0 skipで再確認した。型検査・整形・規約／仕様の2軸レビューも実施した。既存 suite の opt-in skip は各実環境の成功に数えない。

PR #84 の初回 macOS CI では、既存 group 方式の不適合を期待どおり観測した後、cleanup の `kill` が `EPERM` を返して2件が失敗した。終了済みの正の PID への同じエラーを Linux の OS 境界で注入して再現し、`ps` でも終了を確認できた場合だけ後始末済みと扱うよう修正した。生存中 PID の `EPERM` を注入した対照は失敗したままで、group への権限エラーや状態観測の失敗も隠さない。実 macOS での効果は更新 CI で確認し、Linux の正式実証や macOS の移行保留とは分けて記録する。

## 残る条件と担当

通常 host の追加 groups と Linux x64／arm64 の必要範囲を実証するまで、Linux 全体の採用成功とは扱わない。最初の prefix は既存 proc mount を引き継いで PID が不整合になったため、同じ `unshare` の `--mount-proc` で準備専用 mount namespace を作る候補に修正し、正常対照との一致と省略時の不整合を両方検査した。全 exec 診断条件についても、元 launcher の別証跡だけを新候補へ無条件に転用しない。host の権限・mount 設定の変更や、代替 native 実装は行っていない。

macOS 15 の方式未成立と移行保留は維持する。#33 は必要 OS 全体の方式・条件が成立するまで OPEN、#82 は native blocked-by #33 のままとする。実行体の選択・検査・cache／build の排他・host の明示準備・Nix closure は #82、raw の実隔離の統合受入は #34／#35 の後の #45 などが担当する。公開 CLI、Perl flock、#34／#35 の採用判断は今回変更していない。

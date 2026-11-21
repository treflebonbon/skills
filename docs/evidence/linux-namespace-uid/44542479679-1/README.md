# 数値名検査後もUID mapping単独で同じEPERMが残った比較記録

[run 44542479679 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44542479679) は、source / workflowを `915de5f50fa2ff3154b1cb0dd71cdbc596ff87ad` に固定し、承認された `mode=probe-uid` を1回実行した。実行前にsourceの独立した仕様指摘0件・規約違反0件、[通常CI全6ジョブの成功](https://github.com/treflebonbon/skills/actions/runs/44539023151)を確認した。規約軸には既存fixtureのvariant分類重複に関する参考smell指摘1件があり、拒否理由と正常対照を明示する構成を維持した。

CodeRabbitの追加評価は回数制限で未完了だった。評価済み `9ae3b9d` の4項目成功と、追加指摘を修正した今回のsource `915de5f` を区別し、この制約をユーザーが了承した後に実行した。承認された1runは完了し、追加dispatchは行っていない。

確認済み（confirmed）: 両構成で数値名 `1001` の検査が `ready / numeric-fallback` となり、同じBashの現行argvとUID-onlyは各3回同じUID-map EPERM、namespace-only対照は各3回成功した。GID mappingとsetgroups指定を省いたargvでも、このrun内の条件で症状が再現した。runのfailureは予定exit 1によるもので、正式実証や修正の成功には数えない。

## 実測結果

Perl基準測定の最小argvと普通の対照を各3回測り、正確なEPERMと対照成功を確認した。その後、同じBashで現行argv、UID-only、namespace-only対照を各3回測った。

| architecture | Perl最小 / 普通の対照  | Bash現行argv | Bash UID-only | Bash namespace-only |
| ------------ | ---------------------- | ------------ | ------------- | ------------------- |
| x64          | 3/3同じEPERM / 3/3成功 | 3/3同じEPERM | 3/3同じEPERM  | 3/3成功             |
| arm64        | 3/3同じEPERM / 3/3成功 | 3/3同じEPERM | 3/3同じEPERM  | 3/3成功             |

Perl最小とBash現行argvは `--map-current-user -- /usr/bin/true`、Perl対照は `-- /usr/bin/true`、Bash UID-onlyは `--map-user=1001 -- /usr/bin/true`、Bash対照は `--user -- /usr/bin/true`。1001は測定時の現在EUIDで、sourceに固定した値ではない。

| architecture | requestedUid | resolvedUid | resolution         | outcome |
| ------------ | ------------ | ----------- | ------------------ | ------- |
| x64          | 1001         | null        | `numeric-fallback` | `ready` |
| arm64        | 1001         | null        | `numeric-fallback` | `ready` |

UID-only直前の名前検査を各1件記録し、最終結果の `uidMappingLookup` と全値が一致した。固定sourceでは `getpwnam_r` の戻り値0かつ結果pointerなしだけを正常な未登録として分類するため、検査時点で数値表記と同名の別アカウントへ解決される条件を除外できた。bufferは64KiB、呼出しは各構成1回で拡張・再試行しない。検査後の実unshare内のNSS検索までの変化や、NSS backendの内部動作は直接観測していない。この結果で [旧run](../44486490046-1/README.md) の未記録の名前解決を遡って確認したことにはしない。

mapping指定の計18回はexit 1・空stdoutと次のstderr全文、対照の計12回はexit 0・空stdout/stderrだった。全30回にsignal・spawn error・ログ省略はなかった。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

| architecture | 共通Bash PID | Perl PID | Bash現行argv PID   | UID-only PID       | namespace-only PID |
| ------------ | ------------ | -------- | ------------------ | ------------------ | ------------------ |
| x64          | 2493         | 2518     | 2548 / 2552 / 2556 | 2570 / 2574 / 2578 | 2582 / 2586 / 2590 |
| arm64        | 2518         | 2543     | 2573 / 2577 / 2581 | 2595 / 2599 / 2603 | 2607 / 2611 / 2615 |

各VM内の15 probe PIDは重複せず、Perl基準測定の終了後にBash側を開始した。全probeの時刻は各job内に収まり、経過時間はx64が約0.673〜1.700ms、arm64が約0.930〜1.975msだった。Bash側のwait statusはexit statusと一致し、全観測子はexit 0。exec前の子PID、所有するBashの親PID、Bash実体、process group、session、PID世代とpidfdの契約を照合した。namespace probe計30回とは別に、準備時の版確認が各1回と、名前検査が各1回ある構成である。

## 固定した条件と出所

| architecture | image            | kernel             | caller UID/EUID/GID | 補助group              |
| ------------ | ---------------- | ------------------ | ------------------- | ---------------------- |
| x64          | `20261116.133.1` | `7.0.0-1014-aws`   | 1001                | `[4,100,116,999,1001]` |
| arm64        | `20261116.188.1` | `7.0.0-1017-azure` | 1001                | `[4,100,117,999,1001]` |

Bashは `/usr/bin/bash` の `5.2.21(1)-release`、Perlは `/usr/bin/perl` の `5.38.2`。各VM内でPerl自身を除いた祖先列がBash側と一致した。共通Bashと上位祖先のPID・世代・process group・session、callerの資格情報、namespace識別子、map、capability / NoNewPrivs / Seccomp、限定LSM項目と5環境変数は両方式・各測定前後で一致した。環境の確認対象はPATH、HOME、LANG、LC_ALL、TMPDIRだけで、全環境やcommand lineは読んでいない。

callerは `unconfined`、AppArmorは有効、`apparmor_restrict_unprivileged_userns` は `1`。今回はjournalを検索しておらず、拒否時LSM、loaded policy全内容、当該syscallの直接traceは得ていない。別runの監査PIDを今回のPIDへ対応させない。

空環境、cwd `/`、exec直前のfd 0閉鎖、別々の匿名通常pipeとflags、5秒・合算32MiBの上限を維持した。fd・環境・cwdは固定sourceと実子fixtureで検証した設定であり、実unshareの拒否時状態を直接dumpしたものではない。`childBefore` はexec前のBash子の観測である。

unshareは `/usr/bin/unshare`、`util-linux 2.39.3`。各VM内で準備時・Perl側・Bash側・各Bash probeの実行前後のhashが一致した。VMのbinaryを取得して独立にhash計算したものではない。

| architecture | unshare SHA-256                                                    |
| ------------ | ------------------------------------------------------------------ |
| x64          | `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c` |
| arm64        | `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a` |

測定器6ファイルのSHA-256は、対象commitのGit blobから計算した値と両jobの記録が一致した。名前検査の記録も同じidentityとcontroller hashに対応した。

| 測定器のkey | SHA-256                                                            |
| ----------- | ------------------------------------------------------------------ |
| parent      | `650bf8323a4699064f2a7cea32fc1fb5eef344f54a66408cf4b4d27007857c4e` |
| python      | `23733c4730bf653dbb6f03ea829d9b0b184e3c00d176dc72070164b18c5497f4` |
| perl        | `b7fce1f8cb2ece6e10d3a373c4a798ba619c0baf0d66259d46852938c97b8319` |
| driver      | `495b7df6cb709088013e83e3d9df186ea72a76827585d9356c4bb86f6aecfe0f` |
| bash        | `711a02a8e0865963c212fff836a203dc09ede1c705faa502b703493208ed2cec` |
| observer    | `8f7bda06801faa091474b398b4c6a120300ceca6606b7186d62235f942163e2d` |

## 保存した証跡と結論の範囲

- [run.json](run.json): 公開run metadata14項目、両比較jobとスキップされた集約jobの全step結果。
- [observations.json](observations.json): [x64 job 135624230839](https://github.com/treflebonbon/skills/actions/runs/44542479679/job/135624230839) と [arm64 job 135624230313](https://github.com/treflebonbon/skills/actions/runs/44542479679/job/135624230313) の `[DEBUG-ns-uid]` JSON各22行・計44行の全値と掲載順、およびexit 1の終了行。
- 専用Nix/group準備・正式44件・監査・集約はスキップし、既存Bun setupを保持した。追加dispatch、既存Bun setup以外の追加install、Cビルド、root化、profile/sysctl変更、kernel journal検索、artifact取得/読取は行っていない。

今回のx64は `7.0.0-1014-aws` で、[旧run](../44486490046-1/README.md) の `7.0.0-1017-azure` とimage・kernel・祖先などが異なる。したがって、run間で検索検査だけを変えた差分実験とは扱わず、今回の各VM内のPerl基準・同じBash・3caseの比較として解釈する。[公開sourceの能力検査経路](../../../linux-namespace-capability-mapping.md)で参照したAzure kernel sourceを、新しいx64 kernelへそのまま対応させない。

検索時点の同名アカウントなしを確認したUID-only argvでも、このrunの条件で同じEPERMが残った。これはCLI操作の比較であり、syscall列やAppArmor拒否との直接因果の観測ではない。完全なpackage版、loaded policy、直接因果と、共通Bash・上位祖先・起動path・OS / LSMなど残る固定条件の要否は未確認である。

Phase 2全体・原因確定・#33は未完了、#82待ち、macOS 15のcontainment方式と全子孫5秒保証の未解決を維持する。条件は [再現ループ](../../../bun-process-linux-feedback-loop.md) で管理する。

## 後続の直接write比較

[run 44633267572](../../linux-namespace-uid-write/44633267572-1/README.md) では、同じVMでこのUID基準を再現してから、util-linuxを使わないPython直接経路を比較した。両構成でnamespace作成・mapのopenは各3回成功し、writeだけが各3回EPERM、namespace-only対照は各3回成功した。今回の記録を遡ってsyscall traceやLSMの因果確認とするものではなく、旧runのJSONは変更していない。

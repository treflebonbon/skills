# util-linuxを使わずUID-mapのwriteでEPERMを再現した記録

[run 44633267572 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44633267572) はsource / workflowを `c43477a91ae98a42fb6edfa12732e955e02f9542`、modeを `probe-uid-write` に固定し、承認された1回を実行した。実行前に[通常CIの全6ジョブ成功](https://github.com/treflebonbon/skills/actions/runs/44565557919)、本体と補足の独立した仕様・規約レビューの指摘解消、46スレッドの未解決0件を確認した。

CodeRabbitは本体 `b1877e8` の4評価項目が成功した。最新 `c43477a` のmock fixture修正5行への追加評価は[回数制限で未完了](https://github.com/treflebonbon/skills/pull/87#issuecomment-7015134768)だった。測定コードとworkflowは評価済み本体と同一であり、この制約をユーザーが了承した後に実行した。承認分は完了し、追加dispatchは行っていない。

確認済み（confirmed）: x64・arm64とも、同じVMで既存基準を再現した後、Pythonの `os.unshare(CLONE_NEWUSER)` と `/proc/self/uid_map` のopenが各3回成功し、writeだけが各3回 `errno=1 / EPERM` になった。namespace作成だけの直接対照は各3回成功した。最終判定は両構成とも `direct-write-reproduced`。比較stepのfailureは予定exit 1であり、修正や正式実証の成功ではない。

## 同じVM内の基準と直接比較

Perlの最小argv・普通の対照を各3回、同じBashの現行argv・現在EUIDのUID-only・namespace-only対照を各3回実行した。この15 probeで正確なEPERMと成功対照が揃った場合だけ、直接経路の6 probeへ進んだ。

| architecture | Perl最小 / 普通の対照  | Bash現行argv | Bash UID-only | Bash namespace-only |
| ------------ | ---------------------- | ------------ | ------------- | ------------------- |
| x64          | 3/3同じEPERM / 3/3成功 | 3/3同じEPERM | 3/3同じEPERM  | 3/3成功             |
| arm64        | 3/3同じEPERM / 3/3成功 | 3/3同じEPERM | 3/3同じEPERM  | 3/3成功             |

基準のargvは[数値名検査後のUID比較](../../linux-namespace-uid/44542479679-1/README.md)と同じ。今回も名前検査は両構成で `requestedUid=1001`、`resolvedUid=null`、`ready / numeric-fallback` だった。名前検査の記録と最終 `uidMappingLookup` の全値・出所が一致した。これは検査時点の名前解決であり、その後の実unshare内のNSS動作まで観測したものではない。直接経路ではこの記録を再利用し、追加の名前検査を行わない。

| architecture | 直接map: namespace作成 | 直接map: open | 直接map: write    | 直接namespace-only |
| ------------ | ---------------------- | ------------- | ----------------- | ------------------ |
| x64          | 3/3成功                | 3/3成功       | 3/3 EPERM、exit 1 | 3/3成功、exit 0    |
| arm64        | 3/3成功                | 3/3成功       | 3/3 EPERM、exit 1 | 3/3成功、exit 0    |

直接子のstdoutは `linux-namespace-uid-write-child/v1` のJSON。map側の操作記録は次のとおりで、対照は最初の1操作だけを記録した。全12直接probeのstderrは空で、signal・capture error・cleanup error・ログ省略はなかった。

```json
[
  { "operation": "unshare", "outcome": "passed" },
  { "operation": "open", "outcome": "passed" },
  { "operation": "write", "outcome": "failed", "errno": 1, "error": "EPERM" }
]
```

固定sourceは `os.unshare(os.CLONE_NEWUSER)` の後に `/proc/self/uid_map` を `O_WRONLY` と `O_CLOEXEC` で開き、現在EUIDによる1行 `1001 1001 1\n` を `os.write()` で1回書く構成である。1001は今回のcallerの値で、source内の固定UIDではない。callerのUID/EUIDはnamespace作成前に記録する。直接対照ではmapを開かず、`/usr/bin/true` も起動しない。直接mapの失敗段階は、固定sourceとhelperの操作別errno記録から確認したもので、独立したsyscall traceを取得したものではない。

基準のmapping指定18回はexit 1・空stdoutと `unshare: write failed /proc/self/uid_map: Operation not permitted\n` のstderr全文、基準の対照12回はexit 0・空stdout/stderrだった。直接map6回と直接対照6回を加え、全42 probeは失敗24回・成功18回。各VMの21 PIDは重複せず、全基準の終了後に直接経路を開始した。

| architecture | 共通Bash PID | Perl PID | 直接map PID        | 直接namespace-only PID |
| ------------ | ------------ | -------- | ------------------ | ---------------------- |
| x64          | 2503         | 2528     | 2663 / 2667 / 2671 | 2675 / 2680 / 2684     |
| arm64        | 2579         | 2604     | 2739 / 2743 / 2747 | 2751 / 2755 / 2759     |

各probeの開始・終了時刻は実行順に前後関係が成立し、直接側のownerは同じBashだった。Bash直接・Python直接のwait statusはexit statusと一致し、観測子はすべてexit 0。exec前の子のPID・親PID・Bash実体・process group・session・PID世代、実行体hash前後を照合した。所有する子のpidfdを使う契約は固定sourceで維持した。

直接mapの経過時間はx64約24.179〜24.203ms、arm64約28.403〜29.908ms。直接対照はx64約23.978〜24.188ms、arm64約28.834〜29.329msだった。Pythonの起動を含むprobe全体の時間であり、write syscall単体の所要時間ではない。42 namespace probeとは別に、固定sourceの準備経路で版確認を各1回、明示的な数値名の事前検査を各1回行う構成である。

## caller・実行体・source

| architecture | image            | kernel             | caller UID/EUID/GID | 補助group              |
| ------------ | ---------------- | ------------------ | ------------------- | ---------------------- |
| x64          | `20261116.133.1` | `7.0.0-1014-aws`   | 1001                | `[4,100,116,999,1001]` |
| arm64        | `20261116.188.1` | `7.0.0-1017-azure` | 1001                | `[4,100,117,999,1001]` |

Perl自身を除いた祖先列、Bashと直接経路の祖先列は各VM内で一致した。callerの資格情報、namespace識別子、map、capability / NoNewPrivs / Seccomp、限定LSM項目と5環境値は、両方式・各測定前後で一致した。環境の確認はPATH、HOME、LANG、LC_ALL、TMPDIRだけで、環境全体やcommand lineは取得していない。

callerは `unconfined`、AppArmorは有効、`apparmor_restrict_unprivileged_userns=1`。新しいjournal検索は行わず、直接子のnamespace作成後・拒否時LSM、loaded policy、今回のPIDに一致する能力拒否を観測したものではない。以前のrunの監査を今回のPIDへ対応させない。

直接経路の実行体は `/usr/bin/python3.12`、版は両構成とも `3.12.3 (main, Aug 31 2026, 10:18:26) [GCC 13.3.0]`。観測子と直接子の実行体hashが各VM内で一致し、各直接probeの実行前後でも変化しなかった。

| architecture | Python SHA-256                                                     |
| ------------ | ------------------------------------------------------------------ |
| x64          | `e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f` |
| arm64        | `c86f21d0da9290ece2d7d49a3f7ed52aed59cb029abdf0ea25c79634f6cbe960` |

基準のunshareは `/usr/bin/unshare`、util-linux `2.39.3`。Bashは `5.2.21(1)-release`、Perlは `5.38.2`。共通Bash、Perl、unshare、Pythonの実体・hashと記録された版を照合した。VMのbinaryを取得して独立にhash計算したものではない。

空exec環境・cwd `/`・exec直前のstdin閉鎖・stdout/stderrの通常pipe、5秒・合算32MiBを維持した。Pythonのlocale coercionが追加し得る既知の `LC_CTYPE` は直接子内でunsetする。これらのfd・環境設定とfd 0のcleanupは固定source・実子fixtureで検証した契約であり、拒否時の全fdや環境をdumpしていない。`childBefore` はexec前のBash子の記録で、直接子が開いたmapのfd番号は公開ログに記録していない。

測定器7ファイルのSHA-256は、対象commitのGit blobから計算した値と両jobの記録が一致した。基準側の6 hashはこのうちdirectを除いた値で、直接開始gateと最終結果は7 hashが一致した。

| 測定器のkey | SHA-256                                                            |
| ----------- | ------------------------------------------------------------------ |
| parent      | `ae7a03434756b2b58cd52a4741986c36916d8b2b7bd1ff2e561792e3859b2077` |
| python      | `23733c4730bf653dbb6f03ea829d9b0b184e3c00d176dc72070164b18c5497f4` |
| perl        | `b7fce1f8cb2ece6e10d3a373c4a798ba619c0baf0d66259d46852938c97b8319` |
| driver      | `495b7df6cb709088013e83e3d9df186ea72a76827585d9356c4bb86f6aecfe0f` |
| bash        | `485722d04a72503c5281a2015d37fbb6728606d0e70d0e395637ad3f91710fa6` |
| observer    | `3cbed54a7be65d398c69911f26561799809efccd05130b25c43b70720da039c7` |
| direct      | `11dcf2f1f2981940f6669d230f8164b4caa1905e873630abf4a97134d97f708b` |

## 保存した証跡と残る制約

- [run.json](run.json): 公開run metadata14項目、両比較jobとスキップされた集約job、全50 stepの結果。
- [observations.json](observations.json): [x64 job 135945205959](https://github.com/treflebonbon/skills/actions/runs/44633267572/job/135945205959) と [arm64 job 135945206347](https://github.com/treflebonbon/skills/actions/runs/44633267572/job/135945206347) のJSON各32行・計64行の全値と掲載順、exit 1の終了行。`[DEBUG-ns-uid]` 各22行と `[DEBUG-ns-uid-write]` 各10行を、各recordの `prefix` と `value` に分けて保存した。
- 専用Nix/group準備・正式44件・監査・集約はスキップし、既存Bun setupを保持した。追加dispatch・artifact取得/読取・journal検索・root化・sysctl/profile変更・既存Bun setup以外の追加install・Cビルドは行っていない。

推論（inferred）: 同じVMの基準を再現したうえで、util-linuxを起動しない直接経路でもUID-mapのwriteがEPERMになったため、この再現にutil-linuxのCLIや `true` のexecは必須ではない。作成・openの失敗とも分離できた。一方、Pythonの初期化を含む経路への変更であり、原症状と直接経路の拒否が同じkernel/LSM規則によることや、その規則の確定を意味しない。

今回のimage/kernelの表示は[前回のUID比較](../../linux-namespace-uid/44542479679-1/README.md)と同じだが、別VMである。run間で1条件だけを変えた実験とは扱わず、各VM内の基準と直接経路を比較する。[Azure kernelの固定公開source](../../../linux-namespace-capability-mapping.md)をx64のAWS kernelへ対応済みとは扱わない。完全なpackage版、loaded policy、拒否を返した具体的なkernel/LSM検査、残るBash・上位祖先・Python起動path・OS条件の要否は未確認である。

Phase 2全体・原因確定・#33は未完了、#82待ち、macOS 15のcontainment方式と全子孫5秒保証の未解決を維持する。[再現ループ](../../../bun-process-linux-feedback-loop.md)と[ADR 0003](../../../adr/0003-os-specific-preparation-containment.md)の条件を引き継ぐ。

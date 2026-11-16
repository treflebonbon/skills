# Linux 追加実証の前提検査を調べた記録

対象は [run 43869813149 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/43869813149)、source / workflow SHA は `752923f9e9992739bfd0195ec1f4a992686b8c1f`。[元の判定と証跡](evidence/linux-process-proof/43869813149-1/README.md)を保持したまま、2026-11-16 に image 検査を修正し、namespace probe 拒否の調査を行った。

## 確定した不具合と修正

arm64 VM の実際の `ImageOS` は `ubuntu24-arm64` だった。収集時の `preflight` と集約時の `readProofJob` は `ubuntu24` だけを受理していたため、arm64 を誤って拒否していた。

両箇所を同じ `validRunnerImage` 判定へ変更した。x64 は `ubuntu24`、arm64 は `ubuntu24-arm64` という組だけを受理する。Ubuntu 24.04、architecture、Bun、非root、namespace、Nix、資格情報、case、反復の既存条件は維持した。

`tests/bun/linux-process-proof.test.ts` の bundle 読込みテストで、正常な arm64 記録の受理を修正前に追加した。保護 wrapper 内の次のコマンドは、修正前に `実行環境・資格情報・namespace の必須観測が不足しています` で1件失敗し、修正後に1件成功・失敗0となった。

```bash
lib/bun/run test tests/bun/linux-process-proof.test.ts --test-name-pattern 'bundle の raw'
```

このテストでは architecture 別の installer checksum も切り替える。arm64 に x64 の image 名を渡す場合、x64 に arm64 の image 名を渡す場合、別版・空文字・欠落した image 名も拒否する。bundle fixture の成功は正式 VM 上の44件実証の成功を意味しない。

## namespace probe について確認できたこと

- 両 CI VM とも非root caller の probe が exit 1 となり、`/proc/self/uid_map` の書込みで `Operation not permitted` を返した。試験本体は始まっていない。
- 両 CI VM の caller は初期 user namespace の mapping を持ち、UID / EUID / primary GID は `1001`。`Seccomp: 0`、`CapEff: 0`、AppArmor の caller label は `unconfined` だった。
- `apparmor_restrict_unprivileged_userns = 1`、`unprivileged_userns_clone = 1`、`max_user_namespaces` は正の値だった。これらは caller の実行前の観測であり、`unshare` 実行後の profile / capability の観測ではない。
- 保存済み `setup.log` と追加取得した Actions の全ログには、対応する `apparmor="DENIED"` や `operation="userns_create"` / `operation="capable"` の記録がない。kernel audit log 自体は収集していないため、ログ内に見つからないことを「拒否イベントが発生しなかった」という根拠にはしない。
- ローカルの保護 wrapper 内で同じ `/usr/bin/unshare --user --map-current-user --pid --fork --kill-child=SIGKILL --mount-proc -- /usr/bin/true` を実行すると exit 0 だった。こちらの caller は UID / EUID `1000`、外側 `uid_map` は `1000 0 1` であり、CI VM とは条件が異なる。CI の拒否を再現した結果でも、正式実証の成功結果でもない。

`uid_map` の書込みは namespace、mapping、capability など複数の権限条件を満たす必要があり、EPERM だけで拒否元を一意に決めることはできない。[Linux man-pages の権限条件](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)を参照した。

Ubuntu の AppArmor は user namespace の使用とその中の capability を制限できる。ただし、その一般仕様だけで今回の VM の拒否原因が確定するわけではない。[Ubuntu Security Team の説明](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007)を参照した。

## 未確定事項と次の調査条件

namespace probe の拒否原因は未確定。失敗した CI VM は終了済みで、同じ拒否が起きる再現ループを現環境では構築できていない。現段階では仮説の検証や、環境原因が解決済みという認定へ進まない。

次回は、正式実証の条件を変えず、失敗した probe の PID / 時刻と結び付く kernel audit event、およびその process の実効 AppArmor profile / capability を得る必要がある。caller の状態だけで代用しない。読取り権限や取得可能性も未確認であり、取得できない場合はその不足を記録する。root で試験本体を実行する変更、sysctl / LSM の緩和、別 binary / profile への切替は行わない。

今回の image 修正は harness の変更なので、次の正式実証は新しい source SHA で x64 / arm64 の一組を測定する。workflow の再実行・新規 dispatch、追加の権限付与は行っていない。今回の run の未達判定と履歴を維持し、履歴解決記録も追加していない。#33 は OPEN、#82 は #33 待ち、macOS の Bun 移行は保留のままとする。

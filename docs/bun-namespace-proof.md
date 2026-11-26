# Bun と OS ツールによる namespace の実証

[#34](https://github.com/treflebonbon/skills/issues/34) の実証用 fixture と記録。WSL2 x86_64、Debian x86_64、NixOS arm64 では、`unshare` で user / network namespace を作ってから Bun を起動し、準備後に `setpriv` で capability を落とす候補が成立した。Ubuntu 24.04 x86_64 の既定設定では旧版と候補が準備段階で停止した。採用は、現行 raw の前提を満たす必要範囲に限る。

## 比較対象と観測境界

基準は `3ff7907083814d081114f96ae10e6a192541ac8e` の [codex-namespace.py](../share/codex-isolation/codex-namespace.py)。SHA-256 は `fa1b9de47711a6c25df0c2049ee1db10c29db89d83f3c0aa6564b2fe36cdc332`。実 [main](../share/codex-isolation/codex-namespace.py) を `runpy` で読み、`os.execv` の直前だけ観測を追加する。UID/GID mapping、`setgroups`、user / network namespace の inode、capability の5集合、sysctl を記録した後、元の `os.execv` を呼ぶ。観測を追加しない旧 CLI の直接起動でも終了37と port 53 の成功を確認する。通常の Bun suite からこの Python 比較を暗黙には起動しない。

[候補の fixture](../tests/fixtures/bun-namespace.ts) は既存の `lib/bun/run` を通して Bun を起動する。FFI、addon、新規 native helper は使用しない。観測は `/proc/self/`、network interface、合成の UDP 通信で行い、[process のテスト](../tests/bun/namespace.test.ts)から stdout / stderr・終了状態を検査する。新しい user / network namespace を確認する前に sysctl と loopback を変更しない。

```mermaid
flowchart TD
  P[Bun の実証 launcher] --> U[unshare / user と network namespace]
  U --> B[Bun / mapping と namespace を検査]
  B --> S[private sysctl を0に設定 / ip link set lo up]
  S --> C[setpriv / inheritable と ambient を除去して exec]
  C --> W[bubblewrap / unshare-all・share-net・cap-drop ALL]
  W --> T[合成 target / capability と UDP port 53 を観測]
```

`unshare --user --map-current-user --net --keep-caps` が namespace と本人だけの mapping を作る。Bun 内で `unshare(2)` を直接呼ぶ方式は評価していない。user / network namespace の作成は、複数 thread を持ちうる Bun を起動する前に OS ツールへ委ねる。

## 実測結果

2026-11-13 の Linux / WSL2 x86_64、非 root UID/GID 1000 で確認した。全て保護された検証入口の内側で実行し、通常 HOME・共有設定・host の sysctl は変更していない。検証 process の user / network namespace、UID/GID mapping、`setgroups`、sysctl が実行前後で同一であることも検査する。

| 境界                  | 旧版と候補の実測                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 準備段階の UID/GID    | 1000 / 1000。`uid_map` / `gid_map` はそれぞれ `1000 1000 1`。`setgroups` は `deny`                                        |
| network               | 親と異なる namespace。準備後は `lo` のみ。bubblewrap の前後で同じ private network を保持                                  |
| user namespace        | 親と異なる namespace。bubblewrap がさらに namespace を作る。最終 mapping は旧版・候補とも `1000 0 1`、最終 UID/GID は1000 |
| loopback / port       | `127.0.0.1` を観測。全 capability の除去後に UDP port 53 を bind し、合成 datagram を送受信                               |
| private sysctl        | `net.ipv4.ip_unprivileged_port_start=0`。対照として1024へ設定すると、最終 target の bind は `EACCES`                      |
| 旧版の exec 直前      | permitted / effective / bounding は非0、inheritable / ambient は0                                                         |
| 候補の準備中          | `--keep-caps` により5集合が非0。Bun と `ip` の起動をまたいで必要な権限を保持                                              |
| bubblewrap の起動直前 | 旧版・候補とも inheritable / permitted / effective / ambient は0、bounding は非0                                          |
| bubblewrap の内部     | 旧版・候補とも5集合が全て0                                                                                                |
| 終了状態              | 合成 target の終了37を外側まで保持。OS ツールの SIGTERM は signal 名と終了143を記録                                       |
| Python 非依存の候補   | Python のない PATH で同じ正常系が成立。比較元の Python は実証時だけ必要                                                   |

bubblewrap の内部の mapping は、準備段階の mapping と異なる。途中の namespace に対する番号であり、旧版と候補の同じ段階を比較する。準備段階と最終段階の literal が一致するという当初のテスト仮定は、旧版自体の実測と矛盾したため修正した。

`--keep-caps` のまま bubblewrap へ渡す対照では、非 root の capability を検出して `Unexpected capabilities but not setuid` で拒否される。`setpriv --inh-caps=-all --ambient-caps=-all` を通す候補は受理される。`--keep-caps` を省く対照は、exec 後の sysctl 書込みで拒否される。単に namespace の作成が成功することだけでは採用条件を満たさない。

この保持・除去の設計は [unshare(1)](https://man7.org/linux/man-pages/man1/unshare.1.html)、[capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html)、[bubblewrap の権限検査](https://github.com/containers/bubblewrap/blob/v0.12.0/bubblewrap.c)も参照する。API と資料の存在だけで成功扱いせず、上記の版・環境での実測に限定する。

## 失敗時の結果

- 共有 network namespace で準備を直接呼ぶと、sysctl 書込み前に終了1となる。
- `unshare`・`ip`・`setpriv`・`bwrap` を失敗する合成 executable に置き換えると、各段階で停止し、target の出力は現れない。各ツールの終了23 / 24 / 25 / 26と失敗理由が外側まで伝わる。
- `unshare` 不在でも明示的に失敗し、隔離なしの再実行を行わない。
- namespace 作成権限、sysctl 書込み権限、capability の除去、bubblewrap のいずれかが成立しない環境でも、同じ拒否を維持する。host の sysctl や AppArmor 設定を自動変更して成立させない。

## 対応環境・再実行

| 項目                        | ローカル実測                                              |
| --------------------------- | --------------------------------------------------------- |
| OS / kernel / architecture  | Linux / WSL2 `6.18.58.1-microsoft-standard-WSL2` / x86_64 |
| Bun                         | 1.4.4                                                     |
| `unshare` / `setpriv`       | util-linux 2.39.3                                         |
| `ip`                        | iproute2 6.1.0、libbpf 1.3.0                              |
| bubblewrap                  | 0.12.0                                                    |
| 比較元 Python               | 3.14.7、`os.unshare` 対応版                               |
| 通常 Linux x86_64 / aarch64 | Debian x86_64 と NixOS arm64 で合格。下記の追加実測を参照 |
| WSL2 aarch64                | 未確認                                                    |
| macOS                       | raw isolation の対象外                                    |

検証用の追加 npm package、自動 install、build はない。比較元以外の候補が必要とする OS ツールは `unshare`・`setpriv`・`ip`・`bwrap` と既存の Bash / Bun。標準の Linux user namespace、network namespace、ambient capability と namespace 内の sysctl 書込みを許す kernel / 実行 policy が必要になる。必要なツールの版の下限を、この1環境から推定しない。

`~/runtime/skill-harness.md` の保護された検証入口から、task worktree を指定して実行する。

```sh
python3 -B /home/ubuntu/ghq/github.com/treflebonbon/dotfiles/scripts/verification_env.py \
  /home/ubuntu/orca/workspaces/skills/bun-namespace -- \
  env NAMESPACE_PROOF_REAL=1 lib/bun/run test tests/bun/namespace.test.ts
```

ローカルでは13件が pass、失敗・skip は0。末尾の `boundary: "namespace"` の JSON に source revision、比較元と候補の source hash、版、namespace / capability の観測値、合成失敗の状態が残る。dirty checkout で実行する場合の source revision は base の HEAD なので、同じ記録の候補 source hash も照合する。

通常の `npm run test:bun` は共有 namespace での拒否を検査し、実 namespace の12件は明示 opt-in まで skip する。既存の3環境 CI は raw isolation を起動しない。この skip は OS 対応の証拠に数えない。opt-in の検証で必要なツールや権限がなければテストを失敗させ、成功へ置き換えない。

## Ubuntu 24.04 x86_64 の追加実測

2026-11-23 に `41f7703b2a475653ebacb1de822d8fabb52d5aa3` の候補と同じ `unshare` 引数を使い、旧 Python 入口と比較した。旧入口の SHA-256 は上の比較元と一致した。同じ source の WSL2 x86_64 では既存の実 namespace テスト13件が通った。

[Ubuntu 24.04 Server の公式 cloud image](https://cloud-images.ubuntu.com/releases/noble/release-20261017/)（SHA-256 `04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94`）を QEMU の検証用 VM で起動した。仮想 NIC の外部転送は無効。ゲストは Ubuntu 24.04.5 LTS、kernel `6.8.0-147-generic`、util-linux `2.39.3-9ubuntu6.6`、Python `3.12.3`。測定は UID/GID 1000、AppArmor label `unconfined` で実行した。イメージ既定の AppArmor `4.0.1really4.0.1-0ubuntu0.24.04.9` が有効で、`kernel.apparmor_restrict_unprivileged_userns=1` だった。

`/usr/bin/unshare` と `/usr/bin/python3` を使用した。コマンドの末尾には `/bin/sh -c '/usr/bin/printf "target_started=yes\n"'` を渡し、target の出力と終了状態を観測した。

| 実行                                                  | 終了状態 | 観測                                                                       |
| ----------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| 親から target を直接起動                              | 0        | target 起動                                                                |
| `unshare --user`                                      | 0        | target 起動                                                                |
| `unshare --user --map-current-user`                   | 1        | `/proc/self/uid_map` の書き込みが `Operation not permitted`。target 未起動 |
| `unshare --user --map-current-user --net --keep-caps` | 1        | 同じ UID map 書き込みの拒否。target 未起動                                 |
| `python3 codex-namespace.py`                          | 1        | 既存の private network setup エラー。target 未起動                         |

旧入口の `main()` を `runpy` から呼んだ追加観測では、`/proc/self/setgroups` への書き込みが `PermissionError`（errno 13）で停止した。ゲストの監査ログには、`unshare` と `python3` について `unprivileged_userns` profile が `CAP_SYS_ADMIN` を拒否した記録があった。Ubuntu の既定 profile が user namespace 内の capability を制限するという説明と整合する。 [Ubuntu 24.04 のリリースノート](https://documentation.ubuntu.com/release-notes/24.04/)

この VM では、旧入口と候補のどちらも準備段階で停止した。候補の Bun 起動、private sysctl・loopback・capability の設定、bubblewrap の受入はこの環境では未実測。raw 隔離には rootless user/network namespace が使える環境が必要になる。 [raw Codex の必要な環境](raw-codex-isolation.md#必要な環境)

## Debian x86_64 の追加実測

Debian GNU/Linux 13.7 の QEMU/KVM ゲストで、既定のセキュリティ設定のまま `176fa3678eca08e7404988d8ff08c6bffb24af2b` の実 namespace テスト13件が合格した。失敗・スキップはともに0件。 [#34 の Debian 実測記録](https://github.com/treflebonbon/skills/issues/34#issuecomment-7103915449)

## NixOS arm64 の追加実測

2026-11-26 に EC2 Graviton `t4g.small` の NixOS 26.05、kernel `6.18.57`、aarch64 で、`aa26b76c6f1f8f22625757ae87ed8d31e7ce1132` の既存テストを実行した。非 root の UID 995、GID 100 で実行し、ホストはイメージ既定のセキュリティ設定を使った。

起動時の LSM は `capability,landlock,yama,bpf,ima`、`NoNewPrivs` と `Seccomp` はともに0だった。`user.max_user_namespaces` と `user.max_net_namespaces` はともに7429、ホストの `net.ipv4.ip_unprivileged_port_start` は1024。`kernel.unprivileged_userns_clone` と `kernel.apparmor_restrict_unprivileged_userns` は取得できなかった。

配布用 dotfiles の pin と一致する Bun 1.4.4 を使った。比較元は `os.unshare` を持つ Python 3.14.7、候補の OS ツールは util-linux 2.42.3、iproute2 7.0.0（libbpf 1.7.0）、bubblewrap 0.12.0。 [Nix pin と Bun の照合](bun-nix-runtime-proof.md#nixos-arm64-の追加実測)

初回はゲストに `/bin/bash` がなく、`lib/bun/run` の shebang を解決できず終了127となった。再実行では固定済み Nix Bash 5.3p9 を検証用サンドボックスの `/bin/bash` に限って読み取り専用で公開した。同じ `NAMESPACE_PROOF_REAL=1` の実行で13件合格、失敗・スキップはともに0件、終了状態0。旧 Python 入口との mapping と capability の比較、private loopback と UDP port 53、bubblewrap の受理・拒否、準備失敗時の target 未起動を確認した。

## 追加実証の受入条件

必要範囲は、現行の raw 隔離の前提を満たす Linux／WSL2 とする。Ubuntu 24.04 x86_64 の既定設定で両入口が準備段階で停止した結果は、拒否時の証跡として扱う。 [raw Codex の必要な環境](raw-codex-isolation.md#必要な環境)

- 成立の実証は、成功済みの WSL2 x86_64 に加え、権限やセキュリティ設定を変えずに旧版が動作する通常 Linux の x86_64 と arm64 で行う。arm64 は arm64 CPU 上の Linux 実機または VM を使う。x86_64 上の arm64 エミュレーションは事前確認に使う。
- 各環境で既存の `tests/bun/namespace.test.ts` を `NAMESPACE_PROOF_REAL=1` で実行し、現行の13件が失敗・スキップともに0であれば合格とする。同じ fixture で旧 Python 入口と候補の namespace、capability、bubblewrap の挙動を比較し、準備に失敗したときの終了状態と理由、target の未起動を確認する。
- 対象 SHA、OS、CPU アーキテクチャ、カーネル、ツールの版、ホストの実効 policy と結果を記録する。

## 採用条件

2026-11-26 に、配布先の既定セキュリティ設定で、配布用 Nix pin から選んだ Bun、Bash、`unshare`、`setpriv`、`ip`、`bwrap` を使用する方針に合意した。必要な namespace やツールが利用できない環境では、準備を停止する。

ホスト側で `lib/bun/run` を呼ぶ際は、選択した Nix Bash の絶対パスと `-p` を指定する。隔離内の `/bin/bash` にも同じ Bash を使う条件は、`run_isolated` が検索するホスト側の `PATH` の先頭にその Bash の `bin` を置くこと。Bash の選択とホストの `/bin/bash` がない状態での起動は、[#35 のランナー起動の確認](bun-nix-runtime-proof.md#固定した-nix-bash-によるランナー起動)に記録した。

fixture の bubblewrap は保護済み filesystem を読み取り専用で再公開する合成構成であり、raw orchestrator の秘密情報の選別や完全な filesystem / PID / gateway 設計の受入ではない。複数段階の Bun 親子 process を使うため、同一 PID への置換や FD・signal の互換性は #33 の判断を引き継ぐ。本番の raw 呼び出し元と組み合わせた統合受入は #45 が担当する。

公開入口と本番 orchestrator を変更していないため、今回の repo 外の呼び出し元の更新はない。将来の切り替え ticket では dotfiles 側の raw 起動と Nix runtime closure へ OS ツールを含め、必要な版と拒否条件を確認する手順を報告する。repo 外の設定変更と本番配備は実行しない。

# Linux 正式実証（cgroup 経路）: run 45022533684 / attempt 1

2026-11-22 に承認された範囲で1回実行し、別途承認を得て判定 artifact だけを取得した（#121）。結果は**成功**。GitHub runner の x64／arm64 で、ホストが選んだ cgroup 経路について、manifest v2 の「共通＋cgroup 専用＋観測」の全45件を同じ run／attempt で3回ずつ実行し、3回とも skip 0・失敗 0 だった。集約 job も、artifact・同じ SHA の履歴を含む全条件を満たした。

| 項目                  | 記録                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| workflow / ref        | `linux-process-proof.yml` / `feat/121-host-adaptive-proof`                                 |
| source / workflow SHA | `76b591a7757ae79565bd55bac28112ee340a0092`（同じ SHA）                                     |
| run / attempt         | [45022533684 / 1](https://github.com/treflebonbon/skills/actions/runs/45022533684)         |
| 開始                  | `2026-11-22T12:29:28Z`（UTC）                                                              |
| 対象                  | Ubuntu 24.04 x64（image `20261116.133.1`、kernel `7.0.0-1014-aws`）／ arm64（image `20261116.188.1`、kernel `7.0.0-1017-azure`） |
| 選ばれた方式          | 両 architecture とも `cgroup`                                                              |
| 計画 / 実績           | 各45件×3反復 / 両構成とも 45 pass・0 fail・0 skip・exit 0 を3回                            |
| 判定                  | `verifyCohort` が `{"verified":true,"reasons":[]}`（[verdict.json](verdict.json)）         |
| Actions の結論        | 実証 job 2件と集約 job がすべて `success`                                                  |
| 収集                  | 判定 artifact 1件を取得。raw artifact 2件（90日保存）は取得していない                      |

## 確認したこと

[cohort.json](cohort.json) から、集約の判定とは別に次を確認した。

- 両 architecture とも、前提検査の namespace probe は `unshare: write failed /proc/self/uid_map: Operation not permitted` で失敗し、`systemd-run --user --scope -p Delegate=yes` の委譲 scope が選ばれた。user manager は `active`、linger は `yes`、user bus は存在した。AppArmor・sysctl・sudoers は変えていない。
- 3回とも、実行したケースの集合が manifest v2 の「共通30件＋cgroup 専用14件＋観測1件」と一致し、全件が `pass` だった。試験が使った方式も3回とも `cgroup` だった。
- cgroup 専用のケース: `systemd-run` の起動前・scope の登録前・登録後・watchdog の起動前・起動後・準備の exec 前の各段階で launcher が SIGTERM／SIGKILL を受けても準備子が残らなかった。watchdog を無効にした対照では残存を検出した。
- 拒否のケース（launcher に渡す環境から `XDG_RUNTIME_DIR` と `DBUS_SESSION_BUS_ADDRESS` を外す）は、終了コード 69 で準備を始めず、環境を戻した同じ実行体は終了コード 37 で target を実行した。
- 補助 group の2件（GID 30001、root 所有・mode `0060` の file）と、実 Nix・shellHook の caller のケースも3回とも成功した。
- artifact の保存期限は run の開始から 90 日と1秒で、同じ SHA の失敗履歴は無く、履歴の取得は完全だった。
- fixture は runner の Ubuntu の gcc 13.3.0（`x86_64-linux-gnu-gcc-13`／`aarch64-linux-gnu-gcc-13`）で build された。
- 試験の step（前提検査と3回の試行）はそれぞれ約70秒だった。

## 抜け出しの観測（合否に数えない）

準備の子孫が自分で `systemd-run --user --scope` を実行すると、両 architecture・3回とも、準備用 scope とは別の scope へ移った（`leftScope: true`）。launcher を SIGKILL した 5.1 秒後には、その子孫は生き残っていなかった（`survivedLauncherKill: false`）。この子孫は準備の process group に残ったまま cgroup だけを移ったため、準備 group の監視役による group kill で終了したと推測する（未確認）。cgroup の移動と process group の離脱を組み合わせた場合は測っていない。ADR 0005 の追記どおり、cgroup の移動による抜け出しは保証の外に置く。

## この SHA に至った経緯

同じ試験コードの source `c6947cd` で3回 dispatch し、3回とも試験本体は全件成功したが、集約で未達になった。

- [run 44976819303](../44976819303-1/README.md) と [run 45012162020](../45012162020-1/README.md): 公開 metadata API の認証なし rate limit。集約 job に `actions: read` の job token を与えて解消した。
- [run 45021161575](../45021161575-1/README.md): artifact の作成時刻を起点にした保存期間の検査で未達。後続の検証ロジックでは run の開始から数え、Q10 に従って新しい source SHA（この run）で再測定した。

`c6947cd` と `76b591a` の差は、集約の検証ロジック・その単体試験・解決記録・workflow だけで、launcher・正式実証の試験・manifest は同一である。[WSL2 の namespace 経路の実証](../../wsl2-host-adaptive/2026-11-21-c6947cd/README.md)は `c6947cd` で行った。runner と WSL2 の結果は分けて記録し、互いに読み替えない。

## 記録の範囲

`cohort.json` では固定 Nix store path のハッシュを含む接頭部を architecture ごとのプレースホルダーで表す。

`cohort.json` は、判定 artifact の cohort から、観測 JSON の `records` を実 caller・拒否・抜け出しの観測に絞ったものである。省いた件数は `trials[].observation.recordsOmitted` にある。ケースの結果・集計・終了状態・前提検査・artifact・履歴は省いていない。要約後の `cohort.json` に `verifyCohort` を適用しても、同じ判定（成功）になる。

## 示さないこと

- 通常の Ubuntu ホストで namespace 経路が使えること。runner の既定では userns が使えず、namespace 経路は手元の WSL2 で実証した。
- 他の distro、linger が既定で無効なホスト、user manager の無いホスト。
- macOS。この実証が成功しても、macOS が残る限り [#33](https://github.com/treflebonbon/skills/issues/33) は未完了で、[#82](https://github.com/treflebonbon/skills/issues/82) は依存待ちのままである。

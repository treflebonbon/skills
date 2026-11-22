# ホストに応じて方式を選ぶ正式実証の計画

状態: 計画確定・未実装。2026-11-21 の設計対話で Q1〜Q10 の回答と全体の共有理解を確認した。

[ADR 0005](adr/0005-linux-host-adaptive-preparation-containment.md) の**方式の選択**（PID namespace／cgroup v2／拒否）を、必要範囲の Linux ホストで正式に実証する計画。[cgroup v2 の可否確認](linux-cgroup-v2-feasibility.md)の結果を根拠に進める。この実証が成功しても、macOS が残る限り [#33](https://github.com/treflebonbon/skills/issues/33) は未完了で、[#82](https://github.com/treflebonbon/skills/issues/82) は依存待ちのままとする。

## ホストと分岐（Q1・Q10）

権限を変えない限り、各ホストで自然に通る分岐は一つだけである。そこで分岐ごとに実証するホストを割り当てる。

| 分岐 | ホスト | 条件 |
| --- | --- | --- |
| cgroup v2 | GitHub runner `ubuntu-24.04`（x64）と `ubuntu-24.04-arm`（arm64） | 既定のまま（userns の UID-map write が EPERM になる） |
| PID namespace | 手元の WSL2 x64 | 既定のまま。PR #84 の42件は古い source なので数えない |
| 拒否 | GitHub runner の x64／arm64 | launcher に渡す明示的な環境から `XDG_RUNTIME_DIR` と `DBUS_SESSION_BUS_ADDRESS` を外し、user manager に届かないホストを再現する |

拒否のケースでは、準備を始めないこと、target を起動しないこと、決められた終了コードを確かめる。同じ実行体で環境を戻した正常な対照も実行する。`PROBE_UNSHARE` のようなテスト専用の上書きや、user manager の停止はしない。WSL2 の結果は runner の結果と分けて記録し、互いに読み替えない。

## 方式の選択（Q2・Q7）

launcher は準備のたびに、次の順で方式を選ぶ。結果はキャッシュしない。

1. 本番と同じ argv の `unshare` で、中身の無い probe を実行する。成功すれば PID namespace を使う。
2. 失敗したら、準備子を `systemd-run --user --scope -p Delegate=yes` で起動し、その scope を準備用 cgroup にする。launcher と target は元の cgroup に残る。
3. `systemd-run` も失敗したら、準備を始めずに拒否する。

probe は成功したのに本番の `unshare` が失敗した場合は、cgroup へ切り替えず、準備失敗として target を起動しない。キャッシュや host prepare での事前判定は #82 の範囲とする。

## watchdog（Q6）

- watchdog は準備用 scope の外に置き、`setsid` で独自の session にする。Ctrl-C や timeout ツールによる process group へのシグナルで巻き添えにならない。
- launcher だけが pipe の書込み側を持つ。watchdog は EOF で launcher の死亡を知り、`cgroup.kill` を書く。
- 準備が正常に終わったら、launcher は target を exec する前に watchdog を解除する。
- watchdog だけが死んだときは、launcher が pidfd でそれを知り、自分で `cgroup.kill` を書いて target を起動しない。
- launcher と watchdog の両方が同時に kill される場合は保証しない（[ADR 0005 の追記](adr/0005-linux-host-adaptive-preparation-containment.md)）。

## 保証の範囲（Q3）

`setsid`／`setpgid`／二重 fork による**離脱**は、全子孫5秒保証の中に残す。子孫が委譲された scope の `cgroup.procs` へ自分を書き込んで準備用 cgroup から出る場合は、cgroup 経路の保証の外に置く。正式実証では抜け出せるかを1件観測して記録し、合否には数えない。

## ケース一覧（Q5）

[manifest](../development/linux-process-proof-cases.json) は1つのまま、ケースを3区分に分ける。各 job は、選ばれた方式に応じて「共通＋その方式専用」を全件実行する。共通ケースの名前は「PID namespace は…」から方式に依存しない表現に変える。

| 区分 | ケース |
| --- | --- |
| 共通 | 離脱・頑固な準備の12件（SIGTERM／SIGKILL）、旧 corpus 2件、正常な準備に5秒上限を設けない1件、準備失敗1件、ARG_MAX 1件、frame 上限1件、UID/GID/groups の一致1件、補助 group 2件、実 PTY 6件、実 Nix caller 1件、launcher の process group 全体への SIGKILL 1件、準備中に watchdog だけが死んだ場合1件（namespace では対照として扱う） |
| namespace 専用 | `unshare` の各段階14件、pidfd 検査を無効にした対照、namespace 拒否、`mount-proc` なしの不整合の検出 |
| cgroup 専用 | `systemd-run` の起動前、scope の登録前、登録後で準備の exec 前、watchdog の起動前、起動後の各段階で launcher が SIGTERM／SIGKILL を受けても準備子を残さないこと。watchdog を無効にした対照で残存を検出する1件。user manager に届かないときの拒否1件（正常な対照付き）。cgroup の移動で抜け出せるかの観測1件（合否には数えない） |

## 合格の判定（Q4・Q9）

runner では、[既存計画](bun-process-linux-proof-plan.md)の Q3〜Q10（証跡の単位、起動設計、保存先と保持期間、Nix と closure、補助 group の準備権限、反復と完了判定、組の定義、失敗後の再評価）をそのまま引き継ぐ。加えるのは次の2点である。

- job ごとに選ばれた方式を記録し、その方式のケース一覧と照合する。
- runner が cgroup 以外を選んだ組は、cgroup 経路の実証としては未達にする。
- 集約 job は、その job だけに与えた `actions: read` の job token（読取り専用・run 限定）で公開 metadata API を読む。既存計画の「認証なし read API を使い、認証権限は追加しない」から 2026-11-22 に変更した。runner の共有 IP では認証なしの上限（1時間60回）を他の利用者と分け合い、2回の run が上限で未達になったためである。repository 設定と secret は変えない。

WSL2 では、対象の SHA を固定し、手元で全件を3回連続して実行する。skip 0・失敗 0 を求める。証跡は `docs/evidence/wsl2-host-adaptive/<日付>-<SHA短縮>/` に置く。中身は、runner と同じ bundle の形式から GitHub 固有の項目を除いた要約、`job.json` 相当、ケースごとの結果である。補助 group の2件に必要な sudo の準備（試験用 group と他者所有 file の作成、`setpriv`）と後片付けは、人が `! sudo …` で実行する。共有の OS 設定（sysctl・AppArmor）は変えない。

## 確認しないこと

macOS、他の distro、linger が既定で無効なホストで委譲を得る手順は、この計画の範囲外とする。`systemd-run` の実行体の選択・検査と host prepare は #82 で扱う。

## 結果

| 分岐 | ホスト | 結果 |
| --- | --- | --- |
| PID namespace | 手元の WSL2 x64 | **成功**。2026-11-21、`c6947cd` を固定して全47件を3回連続で実行し、3回とも skip 0・失敗 0（[証跡](evidence/wsl2-host-adaptive/2026-11-21-c6947cd/README.md)） |
| cgroup v2 | GitHub runner x64／arm64 | **未達（証跡不足）**。2026-11-22 の [run 44976819303 / attempt 1](evidence/linux-process-proof/44976819303-1/README.md) と [run 45012162020 / attempt 1](evidence/linux-process-proof/45012162020-1/README.md) で、両構成とも cgroup が選ばれ、45件×3回が全件成功した。集約 job が公開 metadata API の認証なし rate limit で artifact・履歴を照合できず、どちらも成功には数えない |
| 拒否 | GitHub runner x64／arm64 | 同じ run の拒否ケースが3回とも成功（終了コード 69、正常な対照は 37）。認定は cgroup と同じ扱いで未達 |

WSL2 の成功は runner の結果に読み替えない。#33 は未完了のまま。

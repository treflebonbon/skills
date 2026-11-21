# 委譲された cgroup v2 での準備子孫の終了の可否確認

[run 44875717894 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44875717894) は、source と workflow を `068eb511065586e7c5d6a9f336089c9e4082bff5` に固定し、承認された1回の dispatch として x64／arm64 の2ジョブを実行した。入力は `mode=probe-cgroup`。Nix の準備・44 ケース・集約 job は実行していない。測定方法は [Linux cgroup v2 fallback の可否確認](../../../linux-cgroup-v2-feasibility.md) に書いた。

**両 architecture で、非 root の測定器は userns の UID-map write が EPERM になった後に cgroup を選んだ。委譲された scope と transient service の両方で、直接の `cgroup.kill` とランチャー SIGKILL 時の watchdog が各3回とも 5 秒未満で準備子孫を終了させた。委譲の無い job の cgroup では、準備を始めずに拒否した。**

| 項目 | x64 | arm64 |
| --- | --- | --- |
| kernel／runner image | `7.0.0-1017-azure`／`20261116.376.1` | `7.0.0-1017-azure`／`20261116.188.1` |
| 測定 caller | `runner`（UID/EUID 1001） | 同じ |
| 拒否（委譲の無い `system.slice/hosted-compute-agent.service`） | userns exit 1、cgroup の `mkdir` が `EACCES`、`select_exit=3`、MARKER なし | 同じ |
| 準備用 cgroup の作成と準備子の移動 | scope・service とも成功 | 同じ |
| direct-kill（scope 3回＋service 3回） | 6/6 成立、1.114〜1.122 ms | 6/6 成立、1.127〜1.142 ms |
| watchdog-kill（scope 3回＋service 3回） | 6/6 成立、1.519〜1.650 ms | 6/6 成立、1.465〜2.617 ms |
| SIGKILL から watchdog の `cgroup.kill` 書込みまで | 0.404〜0.535 ms | 0.346〜0.391 ms |

時間はいずれも `CLOCK_MONOTONIC`。各回で、t0 の直前に準備子と離脱した孫（準備子と別の session）が `cgroup.procs` にあり生存していることを確かめた。終了は `populated 0` と、両 PID の消滅またはゾンビ化で判定した。全回で残存 PID は無く、`rmdir` が成功した。watchdog-kill では、watchdog が記録した書込み時刻が t0 と空になった時刻の間にあった。watchdog が準備用 cgroup の外にいることと、watchdog 自身が終了したことも確かめた。

## 前提条件

- runner の非 root caller の cgroup は `/system.slice/hosted-compute-agent.service` で、所有者は root だった。測定器は `cgroup.kill` の存在を確認した。
- userns 経路は、[PR #87 の診断](../../../bun-process-linux-feedback-loop.md)と同じ `unshare: write failed /proc/self/uid_map: Operation not permitted` で失敗した。`apparmor_restrict_unprivileged_userns` は両ジョブとも `1` だった。この値は記録しただけで、判定には使っていない。
- **linger は workflow が有効にする前から `yes` だった。** `user@1001.service` は `active`、user bus は存在した。`sudo loginctl enable-linger` の後も同じ状態で、この step は状態を変えていない。ログインホストの既定状態を再現する手順として残す。AppArmor・sysctl・sudoers は変えていない。
- 委譲された測定は、`systemd-run --user --scope -p Delegate=yes`（`app.slice/run-*.scope`）と `systemd-run --user --wait --pipe --collect -p Delegate=yes`（`app.slice/run-u0.service`）で行った。どちらの cgroup も所有者は UID 1001、`cgroup.subtree_control` は空だった。job の cgroup から user の subtree へ scope を移すことも成功した。
- テスト用の上書き（`PROBE_UNSHARE`、`PROBE_CGROUP_ROOT`）は全ジョブで未設定だった。

## この記録が示さないこと

これは方式の前提に対する可否確認で、[#33](https://github.com/treflebonbon/skills/issues/33) の必要範囲での成功ではない。44 ケースの互換性、実際の準備コマンド、TTY、離脱の他の形、負荷時の5秒保証は測っていない。同じ UID の子孫が、委譲された親 cgroup の `cgroup.procs` へ自身を書き戻して準備用 cgroup から抜けられるかも測っていない。どちらも正式実証で扱う。linger が既定で無効なホスト、または user manager の無いホストで委譲を得る手順も確認していない。

[run.json](run.json) は公開 run metadata 14項目と3ジョブの step 結果を保存した。[observations.json](observations.json) は [x64 job](https://github.com/treflebonbon/skills/actions/runs/44875717894/job/136759866213) と [arm64 job](https://github.com/treflebonbon/skills/actions/runs/44875717894/job/136759866459) から、前提条件10行と `[DEBUG-cgroup]` の24行を公開ログの順に保存した。各行には、記録した step（select／scope／service）を付けた。測定器は [`068eb51` の `development/probe-linux-cgroup.py`](https://github.com/treflebonbon/skills/blob/068eb511065586e7c5d6a9f336089c9e4082bff5/development/probe-linux-cgroup.py) で固定している。

# Linux cgroup v2 fallback の可否確認

[ADR 0005](adr/0005-linux-host-adaptive-preparation-containment.md) の2番目の方式（委譲された cgroup v2 と `cgroup.kill`）が、Ubuntu 既定ホストとして扱う GitHub runner の x64／arm64 で成立するかを、1回の dispatch で測る（#116）。44 ケースの正式実証ではなく、成功しても #33 の必要範囲での成功には数えない。

## 測定器

[`development/probe-linux-cgroup.py`](../development/probe-linux-cgroup.py) を非 root で動かす。公開ログには `[DEBUG-cgroup]` に続く JSON 行だけを出す。

- **方式の選択（`select`／`run` 共通）**: 準備 PID namespace と同じ argv の `unshare` を実際に実行し、成功すれば userns を選ぶ。失敗すれば、自身の cgroup の下に準備用 cgroup を作り、離脱した孫を含む準備を入れて `cgroup.kill` で空にできるかを実際に試す。どちらも成立しなければ拒否する。`apparmor_restrict_unprivileged_userns` の値は前提として記録するだけで、判定には使わない。
- **拒否（`select MARKER`）**: 拒否したときは準備の開始に当たる MARKER を作らず、終了コード3を返す。workflow は委譲の無い job の cgroup でこれを実行し、終了コード3と MARKER が無いことを要求する。
- **直接の終了（`run` の direct-kill、3回）**: 準備子を準備用 cgroup へ移してから、`setsid` と二重 fork で離脱した孫を作らせる。両 PID が `cgroup.procs` にあり生存していることを確かめた直後を t0 として `cgroup.kill` を書き、`cgroup.events` が `populated 0`、かつ両 PID が消滅またはゾンビになった時刻までを単調時計で測る。5 秒未満で、続く `rmdir` が成功すれば成立とする。
- **watchdog（`run` の watchdog-kill、3回）**: 別プロセスのランチャーが準備用 cgroup を作り、準備用 cgroup の外に watchdog を、中に準備を置く。watchdog はランチャーだけが書込み側を持つ pipe の EOF でランチャーの死亡を検知し、`cgroup.kill` を書く。ランチャーへの SIGKILL を t0 とし、直接の終了と同じ条件に加えて、watchdog が記録した書込み時刻が t0 と空になった時刻の間にあることを要求する。

終了コードは、0 が成立、1 が実測での不成立、2 が測定器の不具合、3 が `select` での拒否。

## 実行条件

`linux-process-proof.yml` を `mode=probe-cgroup` で dispatch する。source と workflow を同じ SHA に固定し、Nix の準備・44 ケース・集約は実行しない。artifact 名は `cgroup-probe-<run>-<attempt>-<arch>`。

1. job の cgroup、linger、`user@UID.service`、user bus の有無を記録する。
2. 委譲の無い job の cgroup で `select` を実行し、拒否を確認する。PR #87 の診断どおり userns が失敗することを前提にしている。userns が成立した場合はこの step が失敗し、runner での拒否経路は未観測として記録する。テスト用の上書きで失敗させることはしない。
3. ログインホストが既定で持つユーザーセッション状態として、`sudo loginctl enable-linger` だけを再現する。AppArmor・sysctl・sudoers は変えない。
4. `systemd-run --user --scope -p Delegate=yes` と、`systemd-run --user --wait --pipe --collect -p Delegate=yes`（transient service）の両方で `run` を実行する。job の cgroup から user の subtree へ移せない場合に備え、どちらか一方の失敗で他方の測定を止めない。

dispatch は source を固定した後、実行前に承認を得て1回だけ行う。

手元の privileged container で非 root（UID 1001）に cgroup を委譲したリハーサルでは、direct-kill・watchdog-kill とも3回成立した（WSL2 kernel `6.18.58.1-microsoft-standard-WSL2`）。runner の証跡ではない。

## 結果

[run 44875717894 / attempt 1](evidence/linux-cgroup-v2/44875717894-1/README.md) で、x64／arm64 とも前提が成立した。userns は UID-map write の EPERM で使えず、測定器は cgroup を選んだ。委譲された scope と service の両方で、direct-kill と watchdog-kill がそれぞれ3回とも成立し、最大でも 2.617 ms だった。委譲の無い job の cgroup では、準備を始めずに拒否した。runner では linger が最初から有効で、linger を再現する step は状態を変えていない。

これは #33 の必要範囲での成功ではない。正式実証へ進む根拠として扱う。

## 確認しないこと

同じ UID の子孫が、委譲された親 cgroup の `cgroup.procs` へ自身を書き戻して準備用 cgroup から抜けられるかは測らない。正式実証の前に扱いを決める。

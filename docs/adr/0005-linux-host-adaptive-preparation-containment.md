---
status: accepted
---

# Linux の準備子孫はホストに応じて PID namespace と cgroup v2 を切り替える

[ADR 0003](0003-os-specific-preparation-containment.md) は、Linux／WSL2 の方式を非 root の `unshare` による準備専用 PID namespace に決めていた。しかし Ubuntu の既定設定（`apparmor_restrict_unprivileged_userns=1`）では、非 root の user namespace の中で AppArmor が `CAP_SYS_ADMIN` を拒否する。そのため UID-map の write が EPERM になり、PID namespace を作れない。[PR #87](https://github.com/treflebonbon/skills/pull/87) の診断で、この拒否経路をカーネル内の戻り値まで実測した（[run 44679764568](../evidence/linux-namespace-uid-write-trace/44679764568-1/README.md)）。

2026-11-21 の設計対話で、Ubuntu の既定ホストを**必要範囲**に含め、権限は変更しないと決めた。一方で手元の WSL2 は userns を使えるが、systemd が無く cgroup の委譲を得られない。単一の仕組みでは両方のホストを満たせないため、次の順に方式を選ぶ。

1. userns と mapping が実際に成功すれば、準備専用の PID namespace を使う。実証済みで、init が終了すればカーネルが namespace 内を一括で終了させ、監視役が要らないため優先する。
2. 使えず、委譲された cgroup v2 があれば、準備を cgroup に入れ、`cgroup.kill` で終了させる。ランチャーの死亡は自動では検知されないため、watchdog が必要になる。
3. どちらも無ければ、準備を始めずに明示的に拒否する（fail closed）。

可否は sysctl の値で推定せず、実際に試して判定する。userns は作れても mapping が拒否されるホストがあるためである。

## 検討して退けた案

- **cgroup v2 への一本化**: systemd の無い WSL2 が必要範囲から外れる。
- **Ubuntu の既定ホストでは process group に縮退する**: 全子孫 5 秒保証を狭めることになり、ADR 0003 に反する。
- **人が AppArmor プロファイルや sysctl を変更して userns を許可する**: 権限を変更せずに成立させるという必要範囲の定義に反する。

## 帰結

cgroup 経路は未実証である。最初に GitHub runner の x64／arm64 で可否を確認し、その後に正式な実証へ進む。可否確認では、委譲された cgroup の作成、準備子の移動、離脱した孫を含む 5 秒以内の終了、ランチャーを SIGKILL したときの watchdog の動作を確かめる。runner は Ubuntu 既定ホストの試験場として扱い、ログインホストが既定で持つユーザーセッションの状態（linger など）だけを再現してよい。セキュリティ設定は変えない。macOS の方針は ADR 0003 のまま変わらない。#33 は必要範囲での根拠が揃うまで未完了で、#82 には方式の選択（userns／cgroup／拒否）の検査を加える。

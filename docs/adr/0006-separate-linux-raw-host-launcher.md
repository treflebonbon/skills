---
status: accepted
---

# Linux／WSL2 の raw ホスト向け launcher を先に製品化する

raw Codex の隔離起動は Linux／WSL2 が対象で、Ubuntu の既定設定の x64／arm64 と WSL2 x64 でホスト上の方式を実証した。補足仕様 #131 が定めた #48 の #82 への直接依存を、Linux／WSL2 の raw ホスト向け launcher の製品化チケット #146 への依存に置き換える。macOS 15 を含む #33・#82 の完了条件と #40 の依存は、#131 の分担を引き継ぐ。 [正式実証 #121](https://github.com/treflebonbon/skills/issues/121) [補足仕様 #131](https://github.com/treflebonbon/skills/issues/131) [製品化 #146](https://github.com/treflebonbon/skills/issues/146)

## ホスト launcher の製品化

利用者は plugin 同梱の独立した準備コマンドを明示的に実行する。導入済みの `cc` でビルドし、検査を終えた成果物を payload 外の private cache に排他的に公開する。通常起動は準備済みの成果物を検査し、不足や不一致では準備手順を示して停止する。方式の選択は PID namespace、委譲された cgroup v2、準備前の拒否の順に、実際の可否で判断する。 [ADR 0005](0005-linux-host-adaptive-preparation-containment.md)

#82 の製品化条件のうち Linux／WSL2 に適用される条件を引き継ぐ。独立した準備コマンドと実際のホスト起動入口をダミー target まで通し、cache の競合と差し替えの拒否、検査した実行体との同一性、同じ PID での `exec`、TTY・継承 FD・signal と終了状態の互換性を確認する。検査子を含む準備段階では、中断の受理または入口だけへの SIGKILL から、既存の保証範囲にある準備子孫が5秒以内に終了することと、target が起動しないことを必要範囲で実測する。 [製品化条件 #82](https://github.com/treflebonbon/skills/issues/82) [準備・検査と中断の契約](0002-native-exec-and-perl-flock.md)

## #48 の公開入口の切り替え

ホスト launcher の製品化が完了したら、#48 で `codex-worktree` と `devshell-env` を接続する。隔離内では #45 が切り替えた Nix launcher と実行資産を使い、ダミー app-server と一時 Git worktree で起動、Git・ファイル返却、競合、中断、cleanup、handoff を検証する。 [#48 の受入条件](https://github.com/treflebonbon/skills/issues/48) [raw Codex の隔離起動](../raw-codex-isolation.md)

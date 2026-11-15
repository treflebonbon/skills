---
status: accepted
---

# 準備子孫の終了方式と依存を OS ごとに決める

[ADR 0002](0002-native-exec-and-perl-flock.md) の全子孫5秒保証と、#33 の実証／#82 の製品化という分担を引き継ぐ。現行の process group 方式は離脱した子孫に不適合で、[OS 別の調査](../bun-preparation-containment-research.md)を踏まえて以下の方式・依存・配布方針を確定した。2026-11-15 に Q1〜Q3 の回答と全体の共有理解を確認した。これは各 OS での方式の実証成功・製品化完了を意味しない。

## 対話で決定した方針

2026-11-15 の Q1〜Q3 で、次を合意した。

- 必要な互換性・終了条件の実証がすべて成功した場合、Linux／WSL2 では util-linux の `unshare` を実行時依存として許容する。導入済み `unshare` を用いた準備専用 PID namespace の正式実証を先に行い、実行体の選択・検査、host の明示準備、raw の Nix closure への追加は #82 で製品化する。実証前の採用成功や、自動 install・権限変更の承認とは扱わない。C launcher 内への同等処理の再実装より、最小実証が成功した構成の検証を先行させる。
- macOS 15 を含む現行の必要範囲を維持する。子孫専用 Endpoint Security API を使うためだけに下限を macOS 27 へ引き上げない。必要範囲で方式が成立するまで #33 は未完了、#82 は依存待ちとする。
- macOS 15 向けに Apple entitlement 付きの特権 monitor を追加する案は、今回の採用候補から外す。root・Full Disk Access・provisioning profile を伴う署名・配布の負担を増やしても、イベント欠落後の全子孫の同定・安全な一括終了は未実証であるため、現在の明示的な `cc` 準備の方針を維持する。macOS の Bun 移行は方式未成立として保留し、Linux の正式実証を先行する。

## 実証と製品化への引継ぎ

全子孫の終了保証を group 内に狭める変更、対応 OS の切捨て、実証なしでの採用や後続の解禁は今回の合意に含めない。Linux の実証成功だけでは #33 を完了にせず、必要範囲での根拠が揃うまで #82 の依存条件を維持する。Linux の正式実証では初期化の race、実 PTY、旧 corpus と ARG_MAX、準備子の mapping と実 caller の互換性を確認する。#82 の製品化や macOS の本番切替を先行させない。

# 通常 Linux x64／arm64 の追加実証計画

状態: 計画確定・追加実証は未達。2026-11-16 に Q1〜Q10 の回答と、Claude Opus のレビュー反映後の計画全体の共有理解を確認した。専用 workflow と証跡収集を実装し、同日の [run 43869813149 / attempt 1](evidence/linux-process-proof/43869813149-1/README.md) は両構成とも前提検査で停止した。試験本体は未実行。

## 目的と引継ぎ

[#33](https://github.com/treflebonbon/skills/issues/33) のうち、[既存の WSL2 実証](bun-process-namespace-proof.md)では未確認だった通常 Linux x64／arm64 と補助 group の権限を検査する実行計画を定める。[ADR 0003](adr/0003-os-specific-preparation-containment.md)の承認済み方針と全準備子孫の5秒終了保証を引き継ぐ。

Linux の追加実証が成功しても、必要範囲での成立を確認するまで #33 は OPEN、[#82](https://github.com/treflebonbon/skills/issues/82) は #33 待ちを維持する。macOS の Bun 移行は保留のままとする。今回の成果物は実行計画であり、実証の成功記録や製品化の完了記録ではない。

## 確定した実行対象（Q1）

| OS           | architecture | GitHub-hosted runner |
| ------------ | ------------ | -------------------- |
| Ubuntu 24.04 | x64          | `ubuntu-24.04`       |
| Ubuntu 24.04 | arm64        | `ubuntu-24.04-arm`   |

最初の対象をこの2構成の VM とし、OS 版を揃える。architecture ごとに、その実行環境で fixture を build／実行する。VM の非root caller と準備子の namespace を記録し、既存 WSL2 実証の外側 user／PID namespace との違いを確認する。ローカルの保護 wrapper 内の観測は VM 上の正式実証へ転用しない。

物理 host、他 distro、WSL2 の結果とは区別して記録する。runner の提供状況は [GitHub 公式資料](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)で確認したが、今回の `unshare` 構成の実行成功は両構成とも未確認。

既存 CI の通常 suite は namespace 実証を明示的に有効化しておらず、42件を skip する。通常 CI の成功を、この計画の実証成功には数えない。

実装後の通常 suite は、補助 group の2件も加えた44件を skip する。

## 確定した検査範囲（Q2）

既存42件に加え、補助 group だけにより許可される file の読み書きと、非所属時の拒否を旧方式と候補で比較する。owner 権限で偶然通る条件を除く。既存の UID／GID／groups の比較は維持し、不一致が出た場合はその内容を実証結果に残す。

現在の所有者用 file は mode 0600 であり、補助 group によるアクセスを検査していない。実 caller の1件は Nix の Bash／stdenv の明示入力が必要で、入力がない場合の41 pass／1 skipは全件の成功に含めない。

補助 group の準備権限と比較条件は Q7、全件実行と反復の判定は Q8 に従う。

## 確定した証跡の単位（Q3）

architecture ごと・実行ごとの bundle を作る。判定要約と検査に必要な JSON は Git 管理し、生ログと補助ファイルは別 bundle に保持する。

要約と bundle は、対象 commit、workflow の revision、run ID／attempt、architecture、反復番号、kernel、runner の `ImageOS`／`ImageVersion`、tool の版、source／binary hash、対応するログで結び付ける。実行前後の namespace、UID／GID／groups と Nix caller の実行有無を含め、WSL2 の既存結果との実行条件の違いを判別できるようにする。

現在の観測 JSON の `verification: "see-test-results"` だけでは合否を確定できないため、ログの試験集計・終了状態・期待する全 case の一覧と照合する。要約に artifact の参照、bundle の digest、実際の保存期限を残す。必須の観測が欠けた記録を成功にしない。

期待する case の一覧は対象 SHA に固定した Git 管理の manifest とし、実行ログから生成しない。補助 group の追加 case も含め、case ごとの結果・pass／fail／skip／todo・終了状態・JSON の `realCallerRequested: true` と実 caller の観測を照合する。件数だけで全件の実行を認定しない。

## 確定した起動設計（Q4）

通常 CI から独立した `workflow_dispatch` 専用 workflow を用意し、x64／arm64 を一組として起動する。正式実証を通常 PR の必須チェックには追加せず、実証結果を別に記録する。対象 commit を固定し、両構成の実 checkout と照合する。

対象はこの repository の完全な commit SHA で指定する。workflow 自身の revision と検査対象の SHA を分けて記録する。片方の architecture が失敗しても、もう片方の結果と証跡を収集する。

既存 CI と同じ `permissions: contents: read` と checkout の `persist-credentials: false` を使う。取得した HEAD と、実際に検査する test／fixture／manifest の source hash を記録する。job は明示した Bash と pipefail、上限30分で実行し、個別試験の timeout は維持する。

手動 workflow は default branch に導入してから利用する必要があるため、導入用 PR と実証実行を分ける。今回の合意は起動設計についてであり、実際の dispatch は workflow と対象 SHA が確定してから扱う。[GitHub の手動実行手順](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)を参照。

## 確定した保存先と保持期間（Q5）

生ログ・補助ファイルの bundle は GitHub Actions artifact に90日保存し、要約・必要な JSON は Git に残す。実際の保存期限も記録し、期限後は原ログを再取得できない前提とする。

設定上限や upload 失敗で必要な保存ができなければ証跡不足として報告する。repository や組織の設定は自動変更しない。public repository の保持期間には最大90日と設定上限が適用される。[GitHub の保持期間設定](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)を参照。

## 確定した Nix と closure の準備（Q6）

CI の明示準備で Nix 2.34.6 の公式 binary tarball を取得し、固定した SHA-256 と照合してから導入する。必要な導入権限は使い捨て CI VM 内に限定する。両 architecture の tarball の存在と公式 checksum は確認済み。初回の正式実行では両構成の Nix 導入と daemon／closure の準備に成功したが、namespace の前提検査で停止し、実 caller の試験は未実行。

Ubuntu／systemd 向けの[公式導入手順](https://nix.dev/manual/nix/2.34/installation/installing-binary)に沿い、CI 実装の詳細として両 VM で multi-user／daemon 方式を固定する。daemon の準備と稼働は Q6 の VM 内に限り、実証本体の caller は非root のままとする。`sandbox = true`、専用 build users を使う構成とし、導入方式・daemon 接続先・実効 `sandbox`／`build-users-group` を許可した項目だけ記録する。sandbox を無効化して通す変更は行わない。

実 caller は `print-dev-env` を呼ぶが、store の状態によって環境用 derivation の再利用または build が起きる。毎回の local build や、daemon があれば namespace 制限の影響を受けないことは前提にしない。Nix の store／build の結果と、非root の準備子に対する namespace 検査の結果を分けて記録する。

| system        | tarball の SHA-256                                                 |
| ------------- | ------------------------------------------------------------------ |
| x86_64-linux  | `311b9f406f0239ef640a1e3fbea1df1bac9d3a7c316c4def30df3206dd964960` |
| aarch64-linux | `09edae3ed146b1a47de84eda6135ef12ee74783d409e7a207c912cb94e14aa35` |

配布先と checksum は [x64 tarball](https://releases.nixos.org/nix/nix-2.34.6/nix-2.34.6-x86_64-linux.tar.xz)／[checksum](https://releases.nixos.org/nix/nix-2.34.6/nix-2.34.6-x86_64-linux.tar.xz.sha256)、[arm64 tarball](https://releases.nixos.org/nix/nix-2.34.6/nix-2.34.6-aarch64-linux.tar.xz)／[checksum](https://releases.nixos.org/nix/nix-2.34.6/nix-2.34.6-aarch64-linux.tar.xz.sha256)。

Nixpkgs は既存の [revision file](../tests/fixtures/raw-codex/nixpkgs-revision)の `7fd4004d0511991fff3a0524856a9be09e28c5f0` を使用する。同じ pin から各 system の Bash／stdenv を個別に準備し、store roots と closure 一覧を記録する。x64 の store path を arm64 へ転用しない。実証段階は準備済み closure を参照し、取得できなければ環境不足として止め、別版へ自動変更しない。

実証用 Bun は既存の基準である 1.4.4 を使用する。`cc`／`unshare` を含む必要 tool の実体・版・hash を記録する。CI の準備と通常の製品 runtime を区別し、製品 runtime の自動導入・build・download は今回の範囲に含めない。

## 確定した補助 group 試験の準備権限（Q7）

使い捨て CI VM 内で、試験用の専用 group・他者所有 file の作成と実行資格情報の設定に限り sudo を使う。Nix の明示導入に必要な準備権限は Q6 の範囲とする。

baseline と候補の本体は同じ非root UID／primary GID で実行する。試験対象 group を補助 group として持つ場合と、同じ UID／primary GID でその group だけを外した場合を比較する。file の所有者・group・mode と実行時の資格情報を観測し、owner 権限や root 権限での誤成功を除く。

既存42件は、VM の非root 実行者の元の補助 group を保って実行する。追加試験はその group 集合を土台に、専用の試験 GID だけを加えた状態と外した状態を使う。既存42件を通すために補助 group を空にしない。

資格情報の切替は、準備用の root process から `setpriv` で UID／primary GID／補助 group を指定して非root process を起動する。起動直後の `/proc/self/status` の資格情報と、必要な PATH／HOME／tool roots・実証用変数を記録・照合する。baseline と候補には同じ明示的な環境を渡し、資格情報の切替による環境差を比較へ混入させない。1反復の全件には既存42件と追加試験の所属・非所属の両方を含める。

同じ file に対する所属時の読み書き許可と、非所属時の拒否理由を照合する。別の file や親 directory の探索権限など、異なる要因による拒否を成功に数えない。

kernel／sysctl／LSM の制限は変更しない。namespace が拒否された場合は未実証として報告する。補助 group の表示が未 map の番号へ変わる可能性は調査で示されているが、実際の番号・アクセス権限の一致は未確認であり、既存の比較条件を維持して検査する。

## 確定した反復と完了判定（Q8）

同じ対象 commit の x64／arm64 それぞれで全件を3回連続実行する。各回は別 process・一時領域を使い、実 Nix caller と補助 group 試験を含む全 case の実行、失敗0、skip0、必要な証跡の保存を要求する。

両 architecture の3回すべてが条件を満たし、Q9 の組の定義と Q10 の再評価規則にも適合する場合だけ「今回の Linux 追加実証が成功」とする。片方だけの成功、別 commit の組合せ、41 pass／1 skip、必要な JSON／ログ／artifact の欠落では成立しない。1回でも失敗した組は成功扱いせず、再実行時も過去の失敗履歴を残す。source を修正した場合は新しい対象 commit で両構成を再測定する。

この判定は今回指定した Ubuntu VM と検査した条件に対するもの。Linux 全体の採用成功、macOS の方式成立、#33 完了、#82 解禁へ読み替えない。

## 確定した一組の定義（Q9）

一組は、同じ workflow run ID・同じ attempt に含まれる x64／arm64 の両 job とする。各 job の同じ VM 内で Nix と fixture の準備を一度行い、process と一時領域を分けて全件を3回実行する。反復間で VM と Nix store を共有することを記録し、3台の独立した VM での成功とは扱わない。

部分再実行した job と、古い attempt の成功 job は組み合わせない。再評価時は、両 architecture を同じ新しい attempt、または新しい run で揃える。例えば x64 が attempt 1 で成功し、arm64 だけが attempt 2 で成功しても、一組の成功は成立しない。

## 確定した失敗後の再評価規則（Q10）

同じ対象 SHA に、実行中の期待不一致・timeout などの未解明失敗が残る間は、後から3回成功しても追加実証の成功認定を保留する。過去の失敗を後続の成功で取り消さず、根拠と原因の調査結果を履歴に結び付ける。

環境起因と根拠付きで確定した場合は、承認済み条件を緩めず、履歴を残して同じ SHA の新しい一組を評価できる。候補や harness の修正が必要なら、新しい SHA で両構成を再測定する。既存比較で検出した候補の互換性不一致を、合格させるために環境不足へ付け替えない。

前提検査での環境不足や証跡不足は、その組が未達であることを残して扱う。再実行も実行承認の規則に従い、自動的に失敗履歴を隠す再試行はしない。

## 実行順序と判定の扱い

1. 専用 workflow・補助 group 試験・証跡の収集を実装し、通常 CI とローカルの保護された検証で導入用 PR を確認する。
2. workflow の default branch への導入後、workflow・対象 SHA・実行範囲を具体化する。実際の dispatch と、許可済み参照コマンド以外の証跡取得が必要な場合は、既存の実行・調査規則に従って対象を示して承認を得る。
3. 両 VM で source／architecture を照合し、Q6 の依存と Q7 の fixture を準備する。実証本体は非root で実行する。
4. 前提検査を通過した構成で Q8 の全件・反復を実行する。中断・待機・build の失敗も記録する。
5. 成功・失敗のいずれも観測・ログを保存し、両構成の結果と artifact を照合する。
6. 要約と必要な JSON を Git 管理する変更としてレビューに渡す。実証の成否と未確認範囲を #33 の次の判断へ引き継ぐ。

前提検査では、取得可能な AppArmor／LSM の状態、caller の `/proc/self/attr/current`、`/proc/sys/kernel/apparmor_restrict_unprivileged_userns`、`/proc/sys/kernel/unprivileged_userns_clone`、`/proc/sys/user/max_user_namespaces` を読み取りで記録する。存在しない項目・取得できない項目も区別する。選択済み `unshare` の元の `argv`・継承環境を保ったprobeを非rootで実行し、probe自身のPID・開始／終了時刻・終了状態・stdout／stderrを保存する。実行中は同じPIDの `/proc/<pid>/stat` から開始時刻を取り、`/proc/<pid>/exe` とともに照合してから、profile、`Uid`／`Gid`／`Groups`、`CapInh`／`CapPrm`／`CapEff`／`CapBnd`／`CapAmb`、`NoNewPrivs`／`Seccomp` を取得する。短命、実行体不一致、権限拒否などの観測不足は状態として残し、caller値を代用しない。`/proc` の値は観測時点の非atomic sampleであり、`uid_map` の書込み失敗時点の状態を保証しない。これはjournalの監査イベントとも区別する。

probeが失敗した場合だけ、既存 `sudo` から固定した `journalctl` 実体へ読み取り専用のkernel journal照会を行う。時間窓はprobe前後各1秒、5秒timeout、256 KiB上限、101行の切詰め検出を使い、PID候補は `--grep=(^|[^[:alnum:]_])pid=<PID>([^[:alnum:]_]|$)` で絞り、出力fieldを `__REALTIME_TIMESTAMP`・`_PID`・`MESSAGE` に限る。採否は `MESSAGE` 内の引用外・一意なtop-level `pid` とjournal時刻で決め、`_PID` は対応付けに使わない。一致したaudit行だけを最大20件・各4096文字で保存する。`journalctl` のpath／SHA-256／非root `--version`／実行 `argv` と、`empty`・`no-matching-events`・`permission-denied`・`truncated`・`timeout`・`unavailable` などの状態も保存する。成功probeでは特権journal照会をせず `not-requested` とする。空のjournal結果、取得失敗、profile／capabilityの観測不足を原因確定に読み替えない。設定値や `EPERM` だけで拒否元を断定せず、直接の根拠がなければ原因は未確定とする。

失敗probeのjobは新しい診断証跡を含めてartifactに残すが、前提未達として実証の成功には数えない。44件のcase、cohort判定、既存記録の受理条件は緩めない。

| 観測・状態                                         | 扱い                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 必要 tool／closure／namespace 権限が前提検査で不足 | 環境不足・未実証。条件を勝手に緩めない                                                    |
| 実行中の期待不一致・異常終了・timeout              | 失敗として観測を保存し、候補・harness・環境の原因を調査する。原因未確定を採用成功にしない |
| skip・必須 case の欠落・記録不整合・保存不足       | 追加実証の成功条件未達。内容と不足理由を報告する                                          |
| 両構成が Q8〜Q10 の全条件を満たす                  | 今回の Linux 追加実証が成功。#33／#82 の依存条件は維持                                    |

使い捨て VM 以外の host、別 distro、別版での再試行は、この2構成の結果とは分けて記録する。合格させるための期待値変更・別方式への fallback・権限条件の変更は本計画に含めず、新しい判断として扱う。

## 実装の入口と結果の保存

手動実行用の [workflow](../.github/workflows/linux-process-proof.yml) は、workflow revision の `control` と、入力した完全 SHA の `subject` を別々に checkout する。`source_sha` に実装を含む commit を指定する。実行承認後、同じ run／attempt の両 job を使う。部分再実行の成功を組み合わせない。

[CI 専用準備](../development/setup-linux-process-proof.sh) が固定版 Nix、両 store roots と closure、専用 GID と他者所有の mode 0060 file を用意する。[収集 CLI](../development/run-linux-process-proof.ts) は前提検査後に別 Bun process／一時領域で3反復し、raw log、保存した fixture binary、source hash、実行環境を束ねる。前提不足・試験失敗・中断でも、取得できた生証跡を90日の artifact に残す。setup 自体の失敗は `setup.log` に残り、`job.json` がなければ集約は成功しない。

tool 記録の対象は、準備 script が直接起動する外部 command と、実証本体の toolchain とする。準備 tool の実体・版・hash は `setup.log`、本体の tool は `job.json` に残す。`groupadd` の版は実体 hash と `passwd` package の版で記録する。資格情報切替後の PATH／HOME は準備 process 内で観測し、baseline と候補へ渡した値と一致することを確認して保存する。Nix roots・実証用変数と反復ごとの一時領域も明示した項目だけを記録する。

集約 job は同じ run／attempt の bundle と、public repository の認証なし read API で取得した artifact metadata・workflow 履歴・過去 attempt を照合する。API 失敗、一覧の不完全性、履歴が取得上限の1000件に達する場合は認定を保留する。認証権限や repository 設定は追加しない。期待 case は [独立 manifest](../development/linux-process-proof-cases.json) の44件とし、件数だけの成功や skip を受理しない。

履歴の基準は現在の attempt の `run_started_at` に固定し、`historyCutoff` として保存する。基準時刻より後に作成された待機 run や、その後に開始した attempt は過去の失敗へ含めない。同じ run の前 attempt や、別 run の過去の失敗は保持する。資格情報は集約時にも primary GID、補助 group 集合、fixture の owner／GID／mode と file identity を必須項目として再検証する。

追加2件の group 試験では、baseline は外側の GID を比較し、候補内の表示は記録した `gid_map` と実際の `/proc/sys/kernel/overflowgid` に従って比較する。所属時の読み書き許可・非所属時の拒否、元の42件の UID／GID／groups の比較条件は維持する。

同じ SHA の過去の未解明失敗は後続成功を保留する。環境起因と確定した場合だけ、[履歴解決記録](../development/linux-process-proof-resolutions.json) に `sourceSha`／`runId`／`attempt` と `classification: "environment"`、原因の `reason`、根拠の `evidence` をレビュー済み変更として追加する。候補や harness の変更は別 SHA で測定する。

`linux-proof-verdict-<run>-<attempt>` artifact の `cohort.json`、`verdict.json`、`summary.md` が Git 管理へ移す候補になる。raw artifact の id／URL／digest／実際の `expiresAt` と結び付け、人が確認した変更として残す。workflow は Git 書込みや issue の状態変更を行わない。正式実行前のローカル fixture／保護環境の結果は、この追加実証の成功記録ではない。

2026-11-16 の [run 43869813149 / attempt 1 の結果](evidence/linux-process-proof/43869813149-1/README.md)は、両 architecture とも namespace の前提検査で停止し、試験本体は未実行だった。arm64 では image 検査の不一致も記録した。追加実証の成功には数えず、失敗履歴と証跡を保持する。

[後続の前提検査の診断](bun-process-linux-preflight-diagnosis.md)では architecture 別の image 判定を修正した。namespace probe の拒否原因は未確定であり、この修正だけで環境不足を解消したとは扱わない。次の正式実証には新しい source SHA と別の実行承認が必要になる。

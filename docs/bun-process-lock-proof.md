# process 置換と lock の寿命の実証

## 判定

[#33](https://github.com/treflebonbon/skills/issues/33) の実証用 fixture と比較記録。基準 source は `236b0f61d194c277f0bb4c79561939113ee6ea24`、Bun は1.4.4。Linux / WSL2 x86_64 で確認した。

**[ADR 0002](adr/0002-native-exec-and-perl-flock.md) で専用 C launcher と Perl flock の採用方針を承認したが、追加条件の実証が必要であり、#33 は完了扱いにしない。** Bun を経由する `process.execve` の経路は PID・TTY・終了状態を維持するが、継承可能な FD と signal mask に旧 Python と異なる挙動がある。`spawn` は PID と親子関係が変わる。fixture が成功しても、この不適合を解消した証拠にはならない。

追加候補として、Bun を準備用の子 process に限定し、同じ PID の専用 native launcher が `execve(2)` を直接呼ぶ fixture を加えた。Linux / WSL2 のローカルでは FD・mask・Python の signal disposition・TTY と拒否条件を比較した。新しい source の3環境 CI は下記の追加実証欄で区別する。製品の明示準備・実行体検査・Nix derivation は [#82](https://github.com/treflebonbon/skills/issues/82) に分離し、各 caller の公開入口はまだ切り替えていない。

lock は既存の `peer-request.sh` と同じ Perl の `flock(2)` を、Bun が開いた FD の open file description に適用する方式を検査した。3環境の合成入力で保持・競合・解放を確認したが、process 置換と対応 OS 全体の採用を決めたものではない。追加実証では、旧 Python の append/write-only・作成 mode と既存の書込み専用 file も検査する。

## 比較対象と観測方法

[Bun の実証用入口](../tests/fixtures/bun-process-lock.ts)を、[POSIX の観測用 C fixture](../tests/fixtures/bun-process-observer.c)から起動する。観測側が FD 9・`FD_CLOEXEC`・`SIGUSR1` の mask を設定し、置換前後の PID / PPID / PGID / SID、controlling TTY、foreground group、FD の device / inode、signal mask、argv を出力する。同じ C source から Node-API 6 の観測用 addon も build し、Bun 内で `process.execve` を呼ぶ直前の状態を読む。観測用 addon は状態を読み出すだけで、製品の execve / flock helper を提供・採用するものではない。

既存の `bin/codex-reviewer` に、本物の Codex の代わりに同じ C observer を渡して[旧版の corpus](../tests/fixtures/bun-process-lock-python.json)を採取した。既存の Python 関数、Git metadata の検出、argv・環境の組立てと `os.execvpe` を実際に通している。source SHA・各関連ファイルの SHA-256・Python 版・OS / kernel・コマンドを保存した。通常の Bun suite から Python を起動しない。raw namespace、Nix、実モデルの起動はこの比較に含まない。

FD は「番号が開いている」だけでなく、置換前後の device / inode を照合する。Bun の内部 FD に同じ番号が再利用された場合を、継承の成功に数えない。PID の比較には、target を直接 exec する POSIX 対照と、子を spawn する対照を置く。

## process の結果

| 境界                            | ローカルでの実測                                                                                                  | 判定                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| PID・親・process group・session | `process.execve` は置換前と一致し、`spawn` は別 PID / 親子関係になる                                              | 置換と spawn を区別できる      |
| argv・環境・終了                | 空引数、Unicode、shell 記号を literal に渡し、target の終了37を観測                                               | 確認済み                       |
| 継承可能 FD                     | 旧 reviewer と POSIX 対照は同じ FD 9 を維持。Bun 内の呼出し直前にも同じ FD はあるが、既に CLOEXEC。置換後にはない | Bun を含む経路が旧契約に不適合 |
| `FD_CLOEXEC`                    | CLOEXEC の FD は target に渡らない                                                                                | 確認済み                       |
| signal mask                     | 旧 reviewer / POSIX 対照と Bun 内の呼出し直前は block 済み `SIGUSR1` を維持。`process.execve` 後は解除            | 旧契約に不適合                 |
| 起動失敗                        | `ENOENT`・`EACCES`・`ENOEXEC` を捕捉して終了1。signal による異常終了ではない                                      | Bun 1.4.4 / この環境で確認済み |
| 対話 TTY                        | 実 PTY で stdin / stdout / stderr、controlling TTY と foreground group、Unicode 入力を観測                        | 確認済み                       |
| 中断・終了・timeout             | POSIX 対照と Bun の両方で、PTY の Ctrl-C は SIGINT / 130、SIGTERM と timeout は SIGTERM / 143                     | 確認済み                       |

[Bun の導入時の説明](https://bun.com/blog/release-notes/bun-v1.3.14)には stdio 以外の FD の close-on-exec と signal mask のリセットが記載されている。一方、同資料の失敗時 abort という説明は今回の1.4.4の実測とは一致しない。版をまたいで転用せず、例外の捕捉を fixture で検査する。

呼出し直前に FD 9 は元と同じ device / inode で開いているが、既に CLOEXEC だった。この実測だけで flag の変更を `process.execve` 呼出し自体に帰属させない。Bun の初期化と観測用 addon の load を含む経路を通った後の状態であり、将来の native 方式の判断にもこの区別を引き継ぐ。PTY の結果は process の終了に加えて terminal の出力終端を待って読む。

POSIX `execve` が mask と非 CLOEXEC の FD を保持する境界は、[Linux の execve(2)](https://man7.org/linux/man-pages/man2/execve.2.html)も参照。API が存在することや終了コードだけの一致を、旧契約との互換性の根拠にしない。`spawn` による signal 転送の代替実装は今回採用していない。

## lock の結果

親の Bun が lock file を開き、既存の Perl にその FD を明示的に渡す。Perl はその open file description に `LOCK_EX | LOCK_NB` を取得し、終了する。子が終了しても親の FD が保持を継続する。Linux の `flock` command や Python には依存しない。

- lock がないと別 process の取得は成功し、保持中は `busy` として拒否される。競合する holder の起動も拒否され、元の holder の保持は続く。
- 親の FD を close すると解放する。通常終了、SIGTERM、SIGKILL による終了でも解放する。
- lock FD を渡さない子は、生存中でも親の close 後に lock を延長しない。明示的に FD を継承させた対照だけは、親の close 後も保持する。対照は子の生存を検査し、子の終了後には再取得できることを確認する。
- lock FD を持つ親を `process.execve` で置換すると、target が生存中でも lock は解放される。host の admission lock を保持する process を置換せず、子の完了と結果返却まで親が保持する境界を維持する必要がある。

[flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html)の open file description の寿命を使う方式であり、PID file や lock directory による stale 判定には置き換えない。advisory lock のため、非協調 writer に対する排他とは呼ばない。Perl の取得 process が終了したことと、lock が解放されたことも区別する。

## 準備・対応環境・再実行

既存の Bun 1.4.4、Node.js、開発依存に加え、観測用 C fixture のため `cc`・POSIX header・導入済み Node.js の Node-API header、lock の実証に Perl / `Fcntl` を必要とする。追加の npm package、FFI、通常利用時の自動 install / build は導入しない。C observer と観測用 addon は一時 directory に build し、終了時に削除する。payload に生成物を置かない。source / binary の hash と compiler / Node.js の版・header path・準備時間はテスト末尾の JSON に記録する。

追加候補を含む setup hook は105秒を上限とする。3回の compiler 各30秒と2回の版検出各5秒の合計100秒を外側でも確保するためで、各 subprocess の期限と通常テストの期限は維持する。以下の過去の CI 記録は、launcher 追加前の source に対するもの。

| 環境                                                                     | 状態                                     |
| ------------------------------------------------------------------------ | ---------------------------------------- |
| Linux / WSL2 x86_64、kernel 6.18.58.1-microsoft-standard-WSL2、Bun 1.4.4 | ローカルで確認済み                       |
| Linux x86_64 (`ubuntu-latest`)                                           | 修正後 CI で93 pass / 0 fail / skip なし |
| Linux aarch64                                                            | 修正後 CI で93 pass / 0 fail / skip なし |
| macOS aarch64                                                            | 修正後 CI で93 pass / 0 fail / skip なし |
| raw namespace / Nix closure                                              | 未実証。後続の隔離実証と区別する         |

```sh
npm ci --prefix development
npm run typecheck
lib/bun/run test tests/bun/process-lock.test.ts
npm test
```

ローカル検証は `~/runtime/skill-harness.md` の保護された実行境界から開始する。CI は既存の3環境の `npm run test:bun` に自動で含まれる。共通 task runner・tsconfig・workflow は変更しない。末尾の `boundary: "process-lock"` の JSON は実測値と採用未決を記録し、成功・失敗・skip はテスト結果で判断する。

## CI の実測履歴

初回の [run 43260194670](https://github.com/treflebonbon/skills/actions/runs/43260194670) は head `b3c7975015410f99a4f8741a8c3e53587bf3ae44` / checkout `78d57762308955397d5655d3b788a4ca88c15123` を検査した。Linux x86_64 と macOS aarch64 は各93 pass / 0 fail / skip なしだった。Node.js は順に24.22.2 / 22.23.4、compiler は Ubuntu GCC15.2.0 / Apple clang17.0.0。C source の SHA-256 は両方 `999b6c812cb784ac7a3db170cecc512b6935889454377ae86c233e55b98f5281`。

Linux の呼出し直前の FD 9 は CLOEXEC あり、macOS ではなしだった。両方で同じ FD の identity と block 済み SIGUSR1 を呼出し直前に観測し、置換後の FD 消失と mask の解除を確認した。local Linux の flag の変化を macOS へ転用しない。

Linux aarch64 は最初のコンパイル中、setup hook の既定5秒で子 process が停止した。75 pass / 1 fail で、今回の18件は未実行だった。初回の ARM の JSON に build / processExecve がないことも成功として扱わない。

コンパイルを6秒遅らせるローカル対照でも約5秒で同じ hook timeout を再現し、hook の上限を75秒にすると18 pass / 0 fail になった。各 child の期限は変更せず、全テストの期限を一括で緩めない。準備時間・終了 status / signal の記録も追加した。修正後の3環境の結果は、該当 head の job log と [PR #59](https://github.com/treflebonbon/skills/pull/59) で確認する。

修正後の [run 43263328778](https://github.com/treflebonbon/skills/actions/runs/43263328778) は head `1034c003eb1ebc42c1aeb1492fd6a33a9a49a8b3` / checkout `e51bc4301b83d4f388f278aacc34abc9c21927ca` を検査し、コード CI の5 job と3環境の全93件が成功した。各環境で今回の process / lock 18件も全件実行し、skip はない。Bun は3環境とも1.4.4。

| runner             | OS / kernel / host architecture  | Node.js  | compiler                                       | 準備 ms | Bun suite                 |
| ------------------ | -------------------------------- | -------- | ---------------------------------------------- | ------- | ------------------------- |
| `ubuntu-latest`    | linux 7.0.0-1019-azure / x86_64  | v24.22.2 | cc (Ubuntu 15.2.0-16ubuntu1) 15.2.0            | 438     | 93 pass / 0 fail / 0 skip |
| `ubuntu-24.04-arm` | linux 7.0.0-1017-azure / aarch64 | v22.23.4 | cc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0     | 350     | 93 pass / 0 fail / 0 skip |
| `macos-15`         | darwin 24.6.0 / arm64            | v22.23.4 | Apple clang version 17.0.0 (clang-1700.0.13.5) | 436     | 93 pass / 0 fail / 0 skip |

呼出し直前の FD 9 は Linux の両環境で CLOEXEC あり、macOS ではなしだった。3環境で同じ元の FD の identity と block 済み SIGUSR1 を観測し、置換後には FD 消失・mask 解除となった。C source の SHA-256 は3環境共通で `999b6c812cb784ac7a3db170cecc512b6935889454377ae86c233e55b98f5281`。準備時間はこの run の実測であり、compiler が常に同じ時間で終わるという保証ではない。

## 採用方針と後続への条件

2026-11-14 に ADR 0002 の方針を承認し、#33 を追加実証の `ready-for-agent` に変更した。#33 は open を維持する。製品化 #82 は #33 を前提とし、#40・#41・#45 に #82 の native blocked-by を登録した。#45 の #34・#35 の前提も維持している。

lock は Perl flock と親 FD 保持を基本とし、保持期間・待機か即時拒否かは各 caller の旧契約を維持する。host と inner の依存を分け、実際に隔離内で使う根拠なしに Perl を inner closure に追加しない。native 採用方針はこの launcher とその明示準備・ビルド・配布に限り、他の native helper／FFI は一括承認しない。

今回の変更は実証 fixture と記録に限定する。repo 外の caller／flake の更新は行っていない。各入口を切り替える ticket が外部の対象と更新手順を報告する。製品の検査・準備の完了、caller の移植、raw の統合受入はそれぞれ別の条件であり、fixture の成功だけで後続を解禁しない。

## 専用 native launcher の追加実証

[Bash の fixture 入口](../tests/fixtures/bun-exec-entry.sh)は、準備子を作る前に同じ PID の[専用 launcher](../tests/fixtures/bun-exec-launcher.c)へ置換する。launcher が [Bun の準備処理](../tests/fixtures/bun-exec-prepare.ts)と guardian を子として起動する。準備結果を pipe から読み、準備子の終了0を確認し、準備 group を終了・回収した後だけ target を `execve(2)` する。Bun は親の FD・mask に触れない。元の環境へ明示的な unset／set だけを適用し、Bun 起動用の sanitization や cache 制御変数を target へ持ち込まない。追加の pipe FD は target 起動前に閉じる。

```mermaid
flowchart LR
  O[POSIX observer / FD・mask・disposition を設定] --> S[Bash の fixture 入口]
  S -->|同じ PID で exec| L[専用 native launcher]
  L -->|準備子| B[Bun / argv・env の準備]
  B -->|frame と終了0| L
  L -->|生存中だけ pipe を保持| G[guardian / 準備 group の leader]
  G -->|親消失時に準備 group を終了| B
  L -->|同じ PID・元の group で execve| T[C observer / target]
```

guardian は親の継承 FD と stdio を閉じ、準備専用 group の leader として group ID の再利用を防ぐ。親の pipe が EOF になると自分を含む準備 group を SIGKILL で終了する。中断の受理時も同じ group を終了し、TERM に応答しない子を無期限に wait しない。通常の準備には一律の期限を設けない。親は準備中だけ SIGCHLD の既定 disposition を使って子を回収し、target 起動前に元へ戻す。

### 比較元と拒否条件

[追加の Python corpus](../tests/fixtures/bun-exec-python.json)は head `f8598e7` の実 `bin/codex-reviewer` から採取した。入力は通常・block 済み SIGUSR1 と ignore 済み SIGINT・CLOEXEC・FD 3/9/63 の継承。基準 Python の3ファイルと観測 C の source hash、Python / OS の版を保存する。拒否 case は `with-env` と同じ `os.execvpe` primitive を Python stdlib から直接実行したものであり、`with-env` の Git / dotenv の準備全体を実行した証拠ではない。通常の Bun suite は保存済み JSON を読み、Python を起動しない。

Bash 単独の `exec` は、`execfail` があっても shebang のない実行可能テキストを shell として実行する対照を置いた。専用 launcher は text・空 file・不正 binary を `ENOEXEC` として拒否し、ENOENT・EACCES・directory の拒否も Python corpus と比較する。PATH 探索は新しい env の PATH・空要素・未指定時の `/bin:/usr/bin`・slash の有無・最初の非 ENOENT/ENOTDIR エラーの保持を検査し、`execvp` の shell fallback を使わない。shebang のある script の判定は kernel に委ねる。

Python は起動時に SIGPIPE / SIGXFSZ（定義される環境では SIGXFZ も）を ignore にする。観測側は SIGPIPE / SIGXFSZ を default に戻して seed し、launcher は旧 Python と同じ ignore 状態を設定する。親からの signal mask と SIGINT の ignore は維持する。単に「signal を変更しない」だけでは旧 Python と一致するという仮定を置かない。

### 検査する境界

- PID / PPID / PGID / SID、FD の identity と CLOEXEC、3/9/63 の継承と範囲3〜127の余分な FD、blocked mask、3種の signal disposition、空引数・Unicode・literal shell 記号、GIT_* 除去と marker を確認する。
- 既存の PTY 対照に launcher を加え、TTY / foreground、入力、Ctrl-C・SIGTERM・timeout の終了を比較する。
- 部分 frame・余分な field・準備の非0終了は、完全な frame が出力済みでも target を起動しない。pipe buffer より大きい準備結果も比較する。準備中の親の SIGTERM では子を終了させ、回収してから同じ signal で終了する。
- ready 前・準備中・frame 出力済みの各 phase で、親 PID だけへの SIGTERM／SIGKILL を対照する。ready 前は started だけを出す準備子を使い、子孫の生存を確認した後で送信する。harness による group 強制終了で成功を代用しない。出力の読み取りを遅らせた2 MiB超の frame でも、`prep-complete-fail` が全 byte を送ってから終了17になることを正常終了の対照と比較する。
- `lib/bun/` と `tests/fixtures/` の bytes・mode・file inventory を実行前後で比較する。生成 binary はテストの一時領域だけに build する。これは今回の fixture の不変性検査であり、製品配布物の導入・受入の証拠ではない。
- lock の追加 case は旧 Python と同じ O_WRONLY / O_APPEND / O_CREAT、0666 & ~umask を使う。Perl は書込み専用 FD を受け取り、競合・close 後の再取得を検査する。

### 実証と採用を区別する条件

追加候補のローカル実測は Linux / WSL2 x86_64・Bun 1.4.4。3環境の CI は、この変更を含む head の各 job log と JSON の `nativeLauncher` を確認する。対象 head / checkout・OS / kernel / architecture・版・件数と source hash は [PR #59 の追加実証結果](https://github.com/treflebonbon/skills/pull/59)に記録する。過去の93件成功を追加候補の成功へ転用しない。

この fixture は argv / env の transport と exec 境界を比較する。reviewer の Git context / policy、`with-env` の準備全体、`codex-inner` の chdir と開始記録、namespace 設定を移植・受入したものではない。caller ごとの追加段階の環境・signal への影響は各移行 ticket で確認する。通常利用時の native binary の明示準備・検査・Nix derivation は #82、raw の実選択・closure の同一性と統合受入は #45 などが担当する。namespace の範囲は広げない。

エラー出力は入口の prefix・errno 名／番号・対象・説明と終了1を比較する。未知の errno も OS 名・番号・説明を表示する。Python 例外の byte 一致を求めない判断は exec 失敗時の診断に限る。prepare frame は16 MiBまでであり、OS の argv 上限との対照は下記の記録と区別する。

### 承認済み条件への追実証（2026-11-14）

変更前の source `623d60c12d13672e8412b88e507f26c565f78c73c91c92133576b96ddddcf382` では、launcher だけへの SIGKILL 後も準備子が5秒近く生存し、追加試験が失敗した。これを契機に上記 guardian を fixture に追加した。別の失敗対照では ELOOP が OTHER に集約され、SIGCHLD ignore を継承すると準備子の wait に失敗した。stdin と stdout を両方閉じた入口では、新 pipe の FD と準備用 stdout が衝突して失敗したため、内部 pipe は FD3 以上に確保する。各修正の前に失敗を記録した。

- launcher だけへの SIGKILL、中断の SIGTERM、frame の出力前／出力済みを組み合わせる。準備子とその子・孫に TERM の block／ignore を設定し、同じ子孫が TERM だけでは終了しない対照を先に確認する。送信時点の単調時計から5秒以内の終了と、target 未起動、無関係な process の生存を観測する。harness の強制 cleanup は assertion の後だけに行う。終了した zombie と生存中の process を区別し、回収は別の事実として扱う。
- 5.2秒待つ正常な準備は最後まで成功する。target の mask／ignore・元の process group・TTY・FD は旧 corpus と比較する。SIGCHLD ignore については、独立した POSIX 対照でも target に維持されることを確認する。
- OS の `ARG_MAX` と、準備を介さない POSIX execve 対照で1024 byte引数の最大個数を測る。Bun の準備内で同じ argv を生成し、上限を通すことと、1個超過で E2BIG・対象・説明を出すことを確認する。これは argv の transport／frame 境界の試験であり、製品 caller の最大入力全体を受け入れた証拠ではない。
- 環境は既存の NODE／BUN／JSC の変数に加え、DYLD の marker、非 identifier の key、Unicode、macOS の encoding marker を、同じ Bash を通る独立対照と比較する。macOS 固有の処理は macOS で実行するまで未確認とする。

この追実証は Linux／WSL2 x64・Bun 1.4.4 で実行した。実行コマンドは `lib/bun/run test tests/bun/process-lock.test.ts`。最終結果は下記に記録する。新 source の Linux arm64／macOS arm64 CI はまだ実行しておらず、過去の別 source の CI を転用しない。別 session／別 group を作る準備子孫への対処、製品 cache を exec 前に検査する段階と各 caller の準備全体も、この fixture の group 内の試験で証明した扱いにしない。必要範囲の未確認が残るため #33 を閉じず、製品化や raw 受入も完了扱いにしない。

### ローカル実行結果（2026-11-15）

| 項目                                              | 結果                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| OS／kernel／architecture                          | Linux／6.18.58.1-microsoft-standard-WSL2／x64                                                       |
| Bun／Node.js／compiler                            | 1.4.4／v24.22.1／gcc (GCC) 15.3.0                                                                   |
| launcher source SHA-256                           | `c2e1181850a13cd5372efbcaf1434fde2cb02319f14f0a12f6c34b1ba9fca067`                                  |
| 観測 fixture source SHA-256                       | `335c845039e713e051927be85d469ba21a5715617ff4e846d12b8491191f9693`                                  |
| `lib/bun/run test tests/bun/process-lock.test.ts` | 59 pass／0 fail／0 skip、525 assertions                                                             |
| `npm run typecheck`                               | 成功                                                                                                |
| ARG_MAX と1024 byte引数の上限                     | 2,097,152 byte、1,979個成功／1,980個は E2BIG（当該環境での実測）                                    |
| 全体の `npm test`                                 | 成功。Bun 542 pass／22 skip／0 fail、Python 48件成功、Node 41件成功、Bats 515 pass／11 skip／0 fail |

全体検査の開始時 HEAD は `0583f4f`。その後のレビュー修正は process fixture とその試験・記録に限り、変更後の最終 source に対して型検査と上記59件を再実行した。これらの fixture を参照する実行コードは `tests/bun/process-lock.test.ts` だけである。試験の開始待ち・親の終了待ちにも期限を設け、回帰で待機が止まった場合は失敗として `finally` の cleanup へ進める。

この結果は Linux／WSL2 x64 のローカル検証であり、新 source の Linux arm64／macOS arm64 CI の代わりにはしない。別 session／別 group に離脱する子孫、製品の exec 前検査、実 caller 全体、raw の統合受入は引き続き未確認。#33 は open を維持する。

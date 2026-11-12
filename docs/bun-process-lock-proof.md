# process 置換と lock の寿命の実証

## 判定

[#33](https://github.com/treflebonbon/skills/issues/33) の実証用 fixture と比較記録。基準 source は `236b0f61d194c277f0bb4c79561939113ee6ea24`、Bun は1.4.4。Linux / WSL2 x86_64 で確認した。

**process 置換の旧契約を満たす方式は未確定であり、#33 は完了扱いにしない。** Bun を経由する `process.execve` の経路は PID・TTY・終了状態を維持するが、継承可能な FD と signal mask に旧 Python と異なる挙動がある。`spawn` は PID と親子関係が変わる。fixture が成功しても、この不適合を解消した証拠にはならない。

lock は既存の `peer-request.sh` と同じ Perl の `flock(2)` を、Bun が開いた FD の open file description に適用する方式を検査した。Linux の合成入力で保持・競合・解放を確認したが、process 置換と対応 OS 全体の採用を決めたものではない。新規 native helper・FFI・Node-API 拡張は採用していない。

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

既存の Bun 1.4.4、Node.js、開発依存に加え、観測用 C fixture のため `cc`・POSIX header・導入済み Node.js の Node-API header、lock の実証に Perl / `Fcntl` を必要とする。追加の npm package、FFI、通常利用時の自動 install / build は導入しない。C observer と観測用 addon は一時 directory に build し、終了時に削除する。payload に生成物を置かない。source / binary の hash と compiler / Node.js の版・header path はテスト末尾の JSON に記録する。

| 環境                                                                     | 状態                                          |
| ------------------------------------------------------------------------ | --------------------------------------------- |
| Linux / WSL2 x86_64、kernel 6.18.58.1-microsoft-standard-WSL2、Bun 1.4.4 | ローカルで確認済み                            |
| Linux aarch64                                                            | fixture は共通 suite の対象だが、実行は未確認 |
| macOS aarch64                                                            | fixture は共通 suite の対象だが、実行は未確認 |
| raw namespace / Nix closure                                              | 未実証。後続の隔離実証と区別する              |

```sh
npm ci --prefix development
npm run typecheck
lib/bun/run test tests/bun/process-lock.test.ts
npm test
```

ローカル検証は `~/runtime/skill-harness.md` の保護された実行境界から開始する。CI は既存の3環境の `npm run test:bun` に自動で含まれる。共通 task runner・tsconfig・workflow は変更しない。末尾の `boundary: "process-lock"` の JSON は実測値と採用未決を記録し、成功・失敗・skip はテスト結果で判断する。

## 残る判断と後続への条件

#33 は open のまま `ready-for-human` とし、後続の blocking links を維持する。採用可能な方式が必要範囲で1つも確定していないため、Linux の部分成功や suite の成功で依存を解除しない。

推奨は公開互換性を維持し、必要な継承 FD を Bun 起動前に識別して保持する方式と、mask を維持する native 方式の追加実証を判断すること。Bun 内で単に `execve(2)` を呼ぶことだけで解消すると仮定しない。新しい helper を加える場合は、ビルド・配布・runtime の準備、内部 FD の漏洩防止、失敗時の状態、3環境での実証を含めて判断し、成功前には採用しない。

lock の Perl 方式を後続で選ぶ場合も、隔離用 Nix closure の明示的な tool 選択と、親の保持範囲を同じ ticket で扱う。現在は実証 fixture と記録だけであり、公開入口を変更していない。repo 外の呼び出し元の更新はない。入口を切り替える ticket が、その時点の外部の対象と更新手順を報告する。

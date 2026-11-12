# Bun の安全なファイル操作の実証

対象は [#32](https://github.com/treflebonbon/skills/issues/32)。本記録は候補の評価であり、公開入口の切り替えや移植の完了を示さない。必要な OS / architecture で採用可能な方式と制約が確定するまで #32 を完了にせず、後続を解禁しない。

## 候補と現時点の判定

directory FD を保持し、各 component を `O_DIRECTORY | O_NOFOLLOW` で開く。Linux では `/proc/self/fd/<directory-fd>/<component>` を使う。macOS の `/dev/fd/<directory-fd>/<component>` は別の候補として実測する。process 全体の cwd を変更したり、絶対 path を開いてから inode を比較する方式には置き換えない。

| 環境                                 | Bun   | 判定                          | 必要な証拠・制約                                                                                                  |
| ------------------------------------ | ----- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Linux x86_64 / WSL2 kernel 6.18.58.1 | 1.4.4 | 採用可・条件付き（confirmed） | 43テスト成功、旧版との17ケース比較、strace 7.2。信頼できる `/proc/self/fd` と保持中の directory FD が必要         |
| Linux aarch64 / Ubuntu 24.04.5       | 1.4.4 | 採用可・条件付き（confirmed） | 標準 CI で本実証43件を含む66テスト成功。保持 FD と `/proc/self/fd` が必要。syscall trace は x86_64 でのみ取得     |
| macOS aarch64 / macOS 15.8.2         | 1.4.4 | 現候補は不適合（confirmed）   | 追試で元 FD・元 path・FD alias の identity を確認したが、子 path は `ENOENT`。必要42契約テストは未実行として skip |

通常の fixture は実モデル・実 browser・資格情報・Nix を使わない。Linux の syscall 調査だけに `strace` を使った。新規 native helper・FFI の採用は判断していない。

この表は環境ごとの採用判定を示す。Linux では保持 FD の方式を下記の制約内で採用できるが、macOS に採用可能な方式がなく、#32 全体は未完了。fixture の JSON にある `adoption: "not-decided"` は実測だけで全環境の採用を自動決定しないことを表し、Linux の条件付き採用可を取り消す意味ではない。

機能判定が `incompatible` の場合、基本的な対照読込みが成功し、保持 FD と元 root の device / inode が一致し、FD namespace 自体が存在することを確認したうえで、macOS の FD path が `ENOTDIR` / `ENOENT` で拒否されたことを記録する。FD alias 単独の open と identity の結果も記録する。必要な42契約テストは `describe.skipIf` で skip として表示し、JSON 記録を `fullContract: "not-run"` / `adoption: "not-decided"` にする。機能判定テストや job の成功だけを #32 の採用成功と数えない。その他の不明なエラーや対照の失敗は不適合と決めつけず、テストを失敗させる。

初回の [CI run 43155204096](https://github.com/treflebonbon/skills/actions/runs/43155204096) は PR head `60b073aee56204bac7b617bb7b93947a7c46b690`、checkout source `8a750a35f8303316b4b9215345eeff1f6099cdd7` を検査した。[Linux arm64](https://github.com/treflebonbon/skills/actions/runs/43155204096/job/130973435760) と [Linux x86_64](https://github.com/treflebonbon/skills/actions/runs/43155204096/job/130973435863) は本実証43件を含む66テストで成功した。[macOS](https://github.com/treflebonbon/skills/actions/runs/43155204096/job/130973435988) は最初の component の open が `ENOENT` となった。機能判定 fixture が `ENOTDIR` だけを想定していたため初回 job は失敗したが、公開 CLI の既存23テストは通過した。errno を無条件に読み替えず、上記の対照を追加して不適合を記録する。

対照を追加した [追試 run 43156948234](https://github.com/treflebonbon/skills/actions/runs/43156948234) は PR head `1e8cd98aca588532b2b421d22d8833ea1327ce2c`、checkout source `e0c2d83abd49858f83f8486fdf020f8aac1fb1f9` を検査し、全6 job が成功した。[macOS の実測](https://github.com/treflebonbon/skills/actions/runs/43156948234/job/130978967461)は Darwin 24.6.0 / arm64 / Bun 1.4.4 で、FD alias 単独の open は `fdAliasIdentity: true` を返し、保持した root FD と元 path の対照も成功した。一方、既存の子 directory の open は `lookupErrno: "ENOENT"` となり、`fdPathLookup: "incompatible"` / `fullContract: "not-run"` を記録した。24 pass は既存23件と機能判定1件で、必要な42契約テストは skip。macOS の採用成功を表す結果ではない。[Linux x86_64](https://github.com/treflebonbon/skills/actions/runs/43156948234/job/130978967486) と [Linux arm64](https://github.com/treflebonbon/skills/actions/runs/43156948234/job/130978967541) はそれぞれ66 pass / 0 fail / 0 skip。

## 旧版と比較した境界

比較元は `f66ae47bb61f98ee27c3629573733b01140f8850` の `run-evidence.py` と `secret-isolation-worktree.py`。source の SHA-256、Python 版、OS、17ケースの受理・拒否・元 bytes は [比較用 corpus](../tests/fixtures/bun-file-safety-python.json)に保存した。実際の旧関数を使い、合成入力と OS 操作で採取したデータであり、通常の Bun テストから Python を起動しない。

- 公開証跡の読込みと raw 入力を区別する。公開証跡では読める hard link を、raw 入力では link 数1の条件で拒否する。raw の読込み前後の size・mtime・ctime の変化も拒否する。
- 検査後の祖先 symlink 差し替えを拒否する。開いた parent の名前を別 process が移動して symlink へ置き換えても、保持 FD から元の directory を参照する。対照実験では最終 component だけの `O_NOFOLLOW` が外部の合成ファイルを読んでしまうことも確認する。
- 正規の相対 path を要求し、`..`・空 component・絶対 path・NUL を FD の操作前に拒否する。`.git` の除外は raw 入力だけに適用し、公開証跡で従来読めた合成ファイルを一律に拒否しない。trusted anchor より上にある system alias（macOS の `/tmp` のようなもの）を許容する旧版の境界は維持する。
- FIFO は `O_NONBLOCK` で開き、通常ファイルの検査で拒否する。directory と leaf / ancestor の symlink も拒否する。旧版の拒否を空の読込み成功に変えない。
- state directory の owner / private mode は `fstat` の実値から検査する。owner 不一致は期待 UID を変えた対照実験であり、別 UID の writer を実行した検証ではない。
- 排他的作成では通常ファイル・dangling symlink・FIFO を上書きしない。書込み、`fchmod`、`fsync`、mkdir、rename、link、unlink も保持 FD 内で実行する。mode 0600 / 0644 / 0755 と、checkpoint の hard link 公開時の競合を確認する。
- rollback は device / inode を BigInt で比較し、別 writer が置き換えた宛先を残す。閉じた parent の再利用を拒否する。

## syscall の実測

実測対象は commit `1acb10467ed22b883275daea4666dccf5dcf0e52` の fixture。Bun 1.4.4、Linux 6.18.58.1-microsoft-standard-WSL2 / x86_64、strace 7.2 で43テストが成功した。trace では次を確認した。

```text
openat(AT_FDCWD, "/proc/self/fd/<parent>/nested", O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_DIRECTORY)
openat(AT_FDCWD, "/proc/self/fd/<parent>/file", O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC)
statx(<file-fd>, "", AT_STATX_SYNC_AS_STAT|AT_EMPTY_PATH, STATX_ALL, ...)
openat(AT_FDCWD, "/proc/self/fd/<parent>/created", O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600)
fchmod(<file-fd>, 0600|0644|0755)
fsync(<file-fd>)
mkdir("/proc/self/fd/<parent>/created", 0700)
rename("/proc/self/fd/<parent>/temporary", "/proc/self/fd/<parent>/file")
link("/proc/self/fd/<parent>/temporary", "/proc/self/fd/<parent>/snapshot")
unlink("/proc/self/fd/<parent>/file")
```

上記は実測の要点で、PID・FD・fixture の絶対 path と追加 flag を短縮した表記。`openat` の第一引数は `AT_FDCWD` だが、path は保持 FD を参照する絶対 path なので process の cwd を解決基準に使わない。祖先が symlink に置換された場合の `ENOTDIR` と、排他的作成・link 公開の `EEXIST` も確認した。

Bun 主 process の `chdir` / `fchdir` はなかった。共用 Bash 起動が自身の場所を求める子 subshell の `chdir` は別 process にあり、ファイル操作の代替に process 全体の cwd 変更を使った証拠ではない。

元 trace は作業用 `/tmp/codex/implement-32.WZwqi8/bun-file-safety-committed.strace` に保持する。SHA-256 は `d084da4b51ba038712873d02f726ec931d5af86b3403c208f05d4d71de786383`。恒久的な公開記録はこの抜粋・実行環境・対象 commit と、再実行できる fixture とする。

## 再実行

```sh
npm run typecheck
lib/bun/run test tests/bun/file-safety.test.ts
```

通常 CI の既存 `npm run test:bun` にも含まれる。末尾の `boundary: "file-safety"` の JSON に OS / kernel・architecture・Bun・checkout source・FD path の可否・契約の未実行を記録する。テストの失敗数・skip 数と併せて読み、JSON の機能判定だけで採用しない。

Linux で syscall を調べる場合は、別途 `strace` を用意し、同じ fixture を次のように実行する。

```sh
file_safety_record="$(mktemp -d /tmp/codex/file-safety.XXXXXX)"
strace -f -yy -s 180 \
  -e trace=open,openat,openat2,mkdir,mkdirat,link,linkat,rename,renameat,renameat2,unlink,unlinkat,fstat,newfstatat,statx,fchmod,fsync,chdir,fchdir,close \
  -o "$file_safety_record/syscalls.log" \
  lib/bun/run test tests/bun/file-safety.test.ts
```

## 採用前に残る制約と判断

- `/proc/self/fd` の存在と意味を必要とする Linux 固有の候補であり、raw namespace / Nix 内でも使えるかは別の先行実証で確認する。`readlink` / `realpath` で得た実 path を再度開く fallback は追加しない。
- inode の比較と unlink、既存内容の検査と rename はそれぞれ別 syscall。これらを単一の原子的な比較・更新と呼ばない。ここでの検証は旧版の拒否条件と、検査前に置換された宛先の保持であり、任意の非協調 writer に対する完全な CAS の証明ではない。
- 公開証跡の機密名・許可 root・provenance / hash と、raw の Git / policy 検査は、それぞれの移植 ticket が既存契約を引き継ぐ。相対 path の primitive だけを、公開絶対 path の validator の代替として使わない。
- 必要な OS で候補が不適合、または証拠が足りない場合は、影響する入口を明記し、#32 を open のまま `ready-for-human` として方式を判断する。native helper / FFI を自動採用したり、拒否条件を緩めたりしない。

現候補の macOS 不適合は [#38 の公開証跡](https://github.com/treflebonbon/skills/issues/38)の読込み・checkpoint / restore に影響する。[#44 の raw 入力](https://github.com/treflebonbon/skills/issues/44)は Linux の条件付き候補を持つが、#32 の native blocking link を勝手に外して先行しない。必要な追加判断は、macOS でも FD を基準に操作できる別方式と、そのビルド・配布・追加 runtime 要件を受け入れるかどうか。新規 native helper / FFI の実装・採用は、その判断後の範囲とする。

追加実証の推奨案は、同じ process 内で `openat`・`mkdirat`・`renameat`・`linkat`・`unlinkat` を呼ぶ最小の Node-API helper。TypeScript / Bun の実装を維持し、欠けている FD 操作だけを対象にする。compiler / header と OS・architecture ごとのビルド・配布が増えるため、まず fixture で FD の受渡し・寿命、既存の拒否条件、必要なツールと生成物の配置を確認する。これは未承認の提案であり、実装・採用や本番の切り替えは行っていない。Bun は [Node-API module の読込み](https://bun.com/docs/runtime/node-api)をサポートし、[公式 FFI 文書](https://bun.com/docs/runtime/ffi)も安定した native 連携として Node-API を案内している。`bun:ffi` は実験的で本番利用非推奨のため、同じ前提で採用しない。

公開 CLI・保存形式・Python の入口は変更していないため、この実証に伴う repo 外の呼び出し元の更新はない。今後入口を変更する ticket では、外部の対象と更新手順をその変更とともに報告する。

参照: [Bun の fs.openSync](https://bun.com/reference/node/fs/openSync)、[fs.constants](https://bun.com/reference/node/fs/constants)、[Linux open / openat](https://man7.org/linux/man-pages/man2/open.2.html)。公開されている `openSync(path, flags, mode)` に directory FD の引数はなく、実物でも `fs.openatSync` / `Bun.openat` は確認できなかった。Bun 内部の native 実装に `openat` が存在することと、TypeScript 向けの API があることは区別する。

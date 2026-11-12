# Bun の安全なファイル操作の実証

対象は [#32](https://github.com/treflebonbon/skills/issues/32)。公開証跡と raw 入力の directory FD に基づく操作を、Bun 1.4.4 と最小の Node-API helper で実証する。公開 CLI・保存形式・Python の入口は、この ticket では切り替えない。

## 採用方式と現在の判定

採用候補は、同じ process 内で `openat`・`mkdirat`・`renameat`・`linkat`・`unlinkat`・`fstatat` を呼ぶ6操作の Node-API helper。6操作の追加実証と compiler / header の要件はユーザー承認済み。各 component を保持 directory FD から操作し、Bun の `fstat`・read・write・`fchmod`・`fsync`・close と組み合わせる。process 全体の cwd 変更や、実 path を解決し直す fallback は使わない。

| 環境                                 | Bun   | 6操作の判定                                 | 根拠                                    |
| ------------------------------------ | ----- | ------------------------------------------- | --------------------------------------- |
| Linux x86_64 / WSL2 kernel 6.18.58.1 | 1.4.4 | ローカル実証成功・採用判断は3環境の結果待ち | 関連52件と型検査が成功                  |
| Linux arm64                          | 1.4.4 | 未確認（6操作の CI 待ち）                   | 5操作の旧 run と区別する                |
| macOS arm64                          | 1.4.4 | 未確認（6操作の CI 待ち）                   | rollback も skip せず同じ契約を実行する |

必要な3環境の全契約と制約が確定するまで #32 を完了扱いにしない。後続の #38・#44 の blocking link は維持する。fixture 末尾の `fullContract: "see-test-results"` は契約の判定をテスト結果で確認するという意味で、単独の成功宣言ではない。`adoption: "not-decided"` も実測だけで採用を自動決定しないことを表す。

## FD と metadata の境界

[C helper](../tests/fixtures/bun-file-safety-native.c) は Node-API の C header と POSIX libc のみを使う。Bun から渡された数値 FD を同じ process 内で扱い、開いた FD は `O_CLOEXEC` を付けて caller に所有権を渡す。caller が渡した parent を helper が閉じることはない。

`fstatat` は `AT_SYMLINK_NOFOLLOW` を固定し、symlink 自体の device / inode を返す。対象を open して代用しないため、mode 0000 のファイルや FIFO の検査でも読取り権限やデータの読込みを必要としない。ID は `napi_create_bigint_uint64` で BigInt に渡し、Number への丸めを挟まない。必要な Node-API の版は6に固定する。構造体の layout はその OS の C header に任せ、TypeScript 側で offset を仮定しない。参照: [POSIX fstatat](https://pubs.opengroup.org/onlinepubs/9799919799/functions/fstatat.html)、[Node-API の BigInt](https://nodejs.org/docs/latest-v24.x/api/n-api.html#napi_create_bigint_uint64)。

component は Buffer の bytes を C へ渡す。有効な Unicode 文字列は TypeScript で UTF-8 化し、不正な surrogate は別名への暗黙変換を避けるため拒否する。C 境界でも Buffer 型・長さ・NUL・`/`・`.`・`..` と、FD / flags / mode の整数を検査する。Linux では `0xff` を含む実ファイル名、macOS では Unicode の Buffer 名を検査する。旧 raw の Git path は `os.fsdecode` を通るため、Git 出力の bytes 解析や保存済みデータの surrogateescape の扱いは #44 の入口側で引き継ぐ。

## 旧版との比較と拒否条件

比較元は `f66ae47bb61f98ee27c3629573733b01140f8850` の `run-evidence.py` と `secret-isolation-worktree.py`。実際の旧関数から合成入力と OS 操作で採取した source hash・Python 版・OS・17ケースの受理／拒否／返却 bytes を [比較用 corpus](../tests/fixtures/bun-file-safety-python.json) に保存した。通常の Bun テストから Python を起動しない。

- 公開証跡では hard link を読めるが、raw 入力は link 数1を要求し、読込み前後の size・mtime・ctime の変化を拒否する。`.git` の除外は raw 入力だけに適用する。
- 正規の相対 path を要求し、絶対 path・空 component・`.`・`..`・NUL を操作前に拒否する。trusted anchor より上の system alias は旧版と同様に許容する。
- 最終 component だけの `O_NOFOLLOW` では祖先 symlink を辿る対照を置く。各祖先の no-follow 検査で差し替えを拒否し、開いた parent が移動・symlink へ置換されても保持 FD の元 directory を操作する。
- leaf symlink・directory・FIFO を通常ファイルとして誤受理しない。FIFO の open は `O_NONBLOCK` と通常ファイルの検査を組み合わせる。
- owner / private mode を FD から検査する。owner 不一致は期待 UID を変えた対照であり、別 UID の writer を実行した検証ではない。作成・write・`fchmod`・`fsync` と mode 0600 / 0644 / 0755 を確認する。
- 排他的作成は既存の通常ファイル・dangling symlink・FIFO を上書きしない。checkpoint は完成済みファイルの hard link を no-clobber で公開し、競合先を保持する。
- rollback は BigInt の device / inode を比較する。別 writer の置換を残し、元 inode を指す symlink、FIFO、directory へ差し替わっても削除しない。読取り権限を落とした同じ inode は削除できる。閉じた parent の再利用と syscall の `EBADF` も拒否する。

inode の検査と unlink、内容の検査と rename はそれぞれ別 syscall。原子的な CAS や任意の非協調 writer に対する完全な保護とは呼ばない。旧版と同じ拒否条件と、検査前に置換された宛先の保持を検証する。

## ビルド・配布・runtime の条件

[実証用 loader](../tests/fixtures/bun-file-safety-native.ts) は、導入済み Node.js の実行 path に対応する `include/node/node_api.h` と `cc` を要求する。自動 download・node-gyp・追加 npm package は使わず、不足やビルド失敗はテスト失敗にする。Linux は `-shared -fPIC`、macOS は `-bundle -undefined dynamic_lookup` を使い、その環境の `.node` を source build する。

build は explicit な準備処理とする。通常利用時の自動 build / install は前提にしない。生成物は payload 外の作業領域に置き、payload を書き換えない。実証では `tmpdir()` 配下の mode 0700 の directory で build し、load 後は成功・失敗とも所有する directory を削除する。保護されたローカル検証は `/tmp/codex/verification-env.*/tmp/`、CI は runner の一時領域を使う。

compiler と Node.js header は build 時に必要。runtime は Bun 1.4.4 と対応する Node-API module を使う。OS / architecture ごとに source build した結果だけを根拠とし、別の libc・OS・architecture への binary の流用は採用範囲に含めない。compiler / Node.js の版・header path・compile 引数・C source と生成物の SHA-256 は job の JSON に保存する。実際の install command・生成物の永続配置・保護と読取りは、入口を切り替える #38・#44 がこの契約を満たす形で実装する。

Bun の [Node-API module の読込み](https://bun.com/docs/runtime/node-api)を使う。[公式 FFI 文書](https://bun.com/docs/runtime/ffi)が実験的・本番利用非推奨とする `bun:ffi` は採用しない。実モデル・実 browser・資格情報は fixture に使わない。raw namespace / Nix 内の実行は後続の隔離実証で確認する。

## 再実行

```sh
npm run typecheck
lib/bun/run test tests/bun/file-safety.test.ts tests/bun/file-safety-native.test.ts
npm test
```

通常 CI の `npm run test:bun` にも含まれる。末尾の `boundary: "file-safety"` の JSON と、テストの失敗数・skip 数を併せて確認する。FD path 候補の診断結果も履歴用に残すが、Node-API の採用に `/proc/self/fd` や `/dev/fd` を使わない。

Linux で syscall を調べる場合は、strace を別途用意し、同じ fixture を実行する。

```sh
file_safety_record="$(mktemp -d /tmp/codex/file-safety.XXXXXX)"
strace -f -yy -s 180 \
  -e trace=open,openat,openat2,mkdir,mkdirat,link,linkat,rename,renameat,renameat2,unlink,unlinkat,fstat,newfstatat,statx,fchmod,fsync,chdir,fchdir,close \
  -o "$file_safety_record/syscalls.log" \
  lib/bun/run test tests/bun/file-safety.test.ts tests/bun/file-safety-native.test.ts
```

6操作の trace と対象 commit は、実測後に追記する。

## 初期候補の実測履歴

FD path 方式は Linux の `/proc/self/fd/<fd>/<component>` で条件付き採用可だったが、macOS の `/dev/fd/<fd>/<component>` は不適合だった。[対照付き run 43156948234](https://github.com/treflebonbon/skills/actions/runs/43156948234) は head `1e8cd98aca588532b2b421d22d8833ea1327ce2c` / checkout `e0c2d83abd49858f83f8486fdf020f8aac1fb1f9` を検査した。Mac の FD alias 単独の open と元 root の identity は一致したが、子 lookup は `ENOENT` となり、24 pass / 42 skip だった。Linux x86_64 と arm64 は各66 pass。初回 run 43155204096 の errno 想定の誤りを、元 FD・元 path・固定 file・FD namespace の対照で区別して再検査した記録であり、Mac の採用成功には数えない。

5操作の Node-API を加えた [run 43162060376](https://github.com/treflebonbon/skills/actions/runs/43162060376) は head `7c0dcc7813c49c2f454cf3091d5ec4704197786a` / checkout `12be806904a57386d4cb66b58d1c04187b2e88af` を検査し、Linux 各69 pass、Mac 68 pass / 1 skip だった。Buffer 対応後の [run 43163201692](https://github.com/treflebonbon/skills/actions/runs/43163201692) は head `99f2234023d00a813119e1f9d5dd2e1200b6fd72` / checkout `e50409cece40c794f20662ba3274fbb1666db0dd` で、Linux 各70 pass、Mac 69 pass / 1 skip。いずれも rollback は旧方式との混在、Mac は未実行だった。6操作の評価には転用しない。

過去の Linux x86_64 / Bun 1.4.4 / strace 7.2 の trace は次のとおり。FD path 方式では絶対 FD path を `openat(AT_FDCWD, ...)` へ渡し、5操作方式では保持 FD を *at の引数へ直接渡した。Bun 主 process の cwd 変更はなく、Bash の path 計算用 subshell の `chdir` とは区別した。

| 対象 commit                                | 作業用の元 trace                                                  | SHA-256                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `1acb10467ed22b883275daea4666dccf5dcf0e52` | `/tmp/codex/implement-32.WZwqi8/bun-file-safety-committed.strace` | `d084da4b51ba038712873d02f726ec931d5af86b3403c208f05d4d71de786383` |
| `7c0dcc7813c49c2f454cf3091d5ec4704197786a` | `/tmp/codex/implement-32.WZwqi8/native-committed.strace`          | `94ed034de1c3f71db388ec0f74a64aa974959594455f9eca8817e7742619a8b6` |

公開証跡の機密名・許可 root・provenance / hash と、raw の Git / policy 検査はそれぞれの移植 ticket が引き継ぐ。相対 path primitive を公開絶対 path validator の代替にはしない。今回の fixture は公開入口を変えないため、repo 外の呼び出し元の更新はない。入口を変更する ticket では、外部の対象と更新手順をその変更とともに報告する。

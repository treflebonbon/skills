# report と質問シートの loopback 配信の Bun 移行

対象は [#37](https://github.com/treflebonbon/skills/issues/37)。両 peer と `ui-grill-with-docs` の配信手順を、Python 標準 HTTP server から package の `bin/serve-local` に切り替える。HTML checker と candidate/evidence は変更しない。

## 入口と配信範囲

```sh
"$plugin_root/bin/serve-local" /absolute/session-private-document-root 0
```

`plugin_root` はロードされた `SKILL.md` から解決する。[共用 CLI](shared-cli.md)と同じ Bash の privileged mode と `lib/bun/run` を使い、Bun 1.4.4 以上を要求する。追加 install・native build・FFI・Python を使わず、payload に cache や生成物を書かない。

port は `0`〜`65535`。`0` は OS が空きを選ぶ。listen 成功後に `{ "root": "解決した絶対 path", "url": "http://127.0.0.1:選択したport/" }` を1行出す。URL の address は実際の listen address から取得する。host を広げる option は持たない。起動失敗・不正な引数・通常ファイルの root・使用中 port は非0で終了し、既存 process を止めない。

専用 root には、その session が所有する report / sheet と必要な asset だけを置く。共有の `/tmp/codex` 全体、plugin、repository 全体を指定しない。root を選ぶ責任は呼出し手順にあり、CLI が任意の directory の所有目的を判定するものではない。

- GET / HEAD で通常ファイルの元 bytes を返す。URL decode は1回とし、query はファイル名から除く。
- directory は末尾 `/` へ query を保って301 redirect し、`index.html` を返す。index のない directory は404とし、一覧を生成しない。
- 解決した path が root 外なら、親参照・encode された参照・symlink も404。dangling symlink・不正 URL・NUL・FIFO などの非通常ファイルも404。open は `O_NOFOLLOW | O_NONBLOCK` を使い、開いた FD が通常ファイルか検査する。
- GET / HEAD 以外は501。拒否応答は日本語の固定本文を返す。

root は session が管理する配信用 directory として使う。非協調 writer との競合下での directory FD 操作を評価する [#32 の証跡](bun-file-safety-proof.md)は、この server の検証結果へ転用しない。

## 移行前の比較データ

[旧 HTTP corpus](../tests/fixtures/loopback-python.json) は、変更前の source revision `da3cae898d8875da67f832e0c6b0ef4fbfb0d28e`、Python 3.14.7 の実際の `python3 -u -m http.server 0 --bind 127.0.0.1 --directory <root>` から21ケースを採取した。手順4ファイルと標準 `http.server` の SHA-256、入力 bytes、method・raw path・status・Content-Type・Location・応答 bytes・終了 signal を保存している。新実装で期待値を採取し直さない。

通常ファイル、HTML、binary、Unicode と空白のファイル名、HEAD、query、directory redirect と index、見つからないファイル、通常・encode・二重 encode の親参照、別 session、symlink、同じ URL の次 round、非対応 method を含む。

18ケースは旧版と status を照合し、成功したファイルの bytes、MIME の種類、redirect の Location を比較する。日付・server banner・charset 表記と旧版のエラー HTML 全文は HTTP 配信の互換性判定に使わない。拒否本文は新 CLI の固定診断で検査する。

残る3ケースは旧版の200をそのまま踏襲しない。root 外への file / directory symlink は受入条件に従って404にし、index のない directory の一覧も公開しない。旧版の元結果は JSON に保持し、この差はテストと本記録で明示する。

旧実装は標準 library へのコマンドだけで、repo 所有の専用 Python 実装・専用 Python テストは存在しなかった。3 skill の実行手順から Python server の呼出しを取り除く。過去の browser 評価で Python を使ったという実測記録と、静的な旧比較 JSON は保持する。他の用途の Python HTTP server はそれぞれの担当 ticket で扱う。

## process と検証

runtime 管理の長時間 terminal/session で foreground のまま起動する。起動 JSON の root と URL を照合し、HTTP 応答を確認してから browser を開く。session handle を保持し、peer の描画検査後、または質問の聞き取り終了後にその handle で終了する。短命 shell の background job にしない。

質問シートは専用 root の `index.html` だけを次 round の内容へ更新し、同じ URL を reload する。executor 側 HTTP の成功と、人が使う browser での session / round の表示確認は別の証拠とする。

[Bun の対象テスト](../tests/bun/serve-local.test.ts)は実 CLI を子 process として起動し、raw path の HTTP 応答と終了後の到達不能を確認する。使用中 port の拒否後にも、先に起動した対照 server が同じ応答を返すことを検査する。不正 URL / FIFO の拒否後に通常ファイルを返す対照も置く。

wrapper・runner・config・TypeScript だけの読み取り専用 permission の payload copy を作り、Bun・`dirname`・`readlink` だけの PATH から symlink 経由で起動する。Python と `node_modules` がなく、cwd / HOME / XDG / 環境に preload を注入しても実行せず、payload の bytes・mode・inventory が変わらないことを確認する。

```sh
lib/bun/run test tests/bun/serve-local.test.ts
npm run typecheck
npm test
```

2026-11-13、Linux / WSL2 x86_64、Bun 1.4.4 で対象7テストと型検査を確認した（confirmed）。 実装 commit `67be708` の全 `npm test` は終了0で、Bun 358成功 / 22 skip、Python 107成功 / 4 skip、Node 41成功、Bats 520成功 / 11 skip、失敗0件だった。skip は既存の opt-in 検査で、対象7件には skip はない。実 browser の session / round 表示、実モデル session、通常 Linux・aarch64・macOS の実機受入は未確認（unconfirmed）。通常の CI は同じ Bun suite を3環境で実行するが、定義だけを実測の証拠とは扱わない。

## repo 外の更新手順

配布先では新しい payload の導入と skill 再読込後、report / sheet 用の `python3 -m http.server ...` を `"$plugin_root/bin/serve-local" <専用root> <port>` へ変更する。Bash と Bun 1.4.4 以上、起動 JSON の照合、所有する session handle の保持と終了が必要になる。port を `0` にした場合は、出力 URL を browser に渡す。固定 port での起動に失敗したとき、そこにいる別 server を利用・停止しない。

repo 外の固定 plugin・agent 設定・flake・呼出し元の更新、導入と本番配備は本変更では実行していない。

### 確認した repo 外の呼出し元

2026-11-13 の確認環境では、`~/.config/nix-devshell/skills-plugin.json` の固定 revision は `fd2a50c558288b3661e5066b94b1196453ef9269` だった。次の3手順に旧 `python3 -m http.server` の呼出しを確認した（confirmed）。固定 source と Codex の導入済み cache にある各 `SKILL.md` の SHA-256 も一致した。

| 所在                                                                                                                                         | 更新対象と手順                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.cache/treflebonbon-skills/marketplaces/<rev>/skills/herdr-peer-refactor/SKILL.md` と同じ配置の `orca-peer-refactor/SKILL.md`             | いずれも旧23行目の report 配信コマンドが対象。この変更を含む payload へ再配備し、専用 root を新 CLI へ渡す手順を再読込する。cache を直接編集しない。                                                                     |
| `~/.cache/treflebonbon-skills/marketplaces/<rev>/skills/ui-grill-with-docs/SKILL.md`                                                         | 旧46行目の質問シート配信コマンドが対象。同じ payload の新手順で専用 root と port `0` を渡し、起動 JSON の URL を browser に使う。                                                                                        |
| `~/.codex/plugins/cache/treflebonbon/treflebonbon-skills/0.2.10/skills/{herdr-peer-refactor,orca-peer-refactor,ui-grill-with-docs}/SKILL.md` | 上記3手順の導入済みコピーが残る。通常の plugin 更新と再読込で切り替え、`SKILL.md` と新しい `bin/serve-local` が同じ配布元の root にあることを照合する。                                                                  |
| `treflebonbon/dotfiles` の `private_dot_config/nix-devshell/skills-plugin.json` と配備先 `~/.config/nix-devshell/skills-plugin.json`         | 固定版を更新する管理元と配備先。#37 を含む受入済み release の revision / hash へ通常の更新手順で変更し、`sync-skills-plugin --verify-only` で配備元を確認する。採用する release の選択・pin 更新・再配備は別工程とする。 |

調査した dotfiles の `docs/` と `runtime/` には、この HTTP server を直接起動する追加の呼出しは見つからなかった。別環境の独立した script や利用者の alias まで網羅したという意味ではない。確認環境の Bun 1.4.4 は新入口の条件を満たしており、この確認を他の配布先の runtime / flake の証拠には使わない。

HTTP 配信の実動確認では、検証用 runtime の長時間 session を保持して起動し、出力 root / URL を照合した。同じ URL で round r1 と r2 の bytes を確認し、その session への Ctrl-C 後に同じ port が接続を拒否することを確認した。これは browser 表示の検査とは別の証拠である。

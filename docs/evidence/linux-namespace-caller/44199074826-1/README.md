# Bun / Node callerの比較記録

[run 44199074826 / attempt 1](https://github.com/treflebonbon/skills/actions/runs/44199074826) は、source / workflowを `9c56366cfbb712b2a26c00efc0a1d9b5a65815b0` に固定し、承認された `mode=probe-caller` を1回実行した。

結果は両architectureとも `bun-not-required`。対象EPERMを再現した場合の予定どおりの終了コード1であり、正式実証の成功ではない。

## 実測結果

各VM内で、同じ測定コードと `spawnSync` APIから次を各3回実行した。

| architecture | runtime         | 最小argv  | 成功対照 |
| ------------ | --------------- | --------- | -------- |
| x64          | Bun 1.4.4       | 3/3 EPERM | 3/3 成功 |
| x64          | Node.js 22.23.4 | 3/3 EPERM | 3/3 成功 |
| arm64        | Bun 1.4.4       | 3/3 EPERM | 3/3 成功 |
| arm64        | Node.js 22.23.4 | 3/3 EPERM | 3/3 成功 |

最小argvは `--map-current-user -- /usr/bin/true`、対照は `-- /usr/bin/true`。失敗12回はすべてexit 1・空stdoutと次のstderr全文を返し、対照12回はexit 0・空stdout/stderrだった。signal・spawn error・ログ省略は全24回でなかった。

```text
unshare: write failed /proc/self/uid_map: Operation not permitted
```

最小probeの実行時間はx64でBun約0.80〜0.93ms・Node約1.33〜1.45ms、arm64でBun約1.15〜1.26ms・Node約1.95〜2.11ms。setupやruntime起動・hash計算を含む時間ではない。

## 照合した条件

- 両VMはUbuntu 24.04。x64はimage `20261111.127.1` / kernel `7.0.0-1014-aws`、arm64はimage `20261111.182.1` / kernel `7.0.0-1017-azure`。
- 各VM内の両runtimeはUID / EUID / GIDが1001で、同じNode親を持った。親PIDはx64が2484、arm64が2573。Node側にBunを祖先として残さない経路で実行した。
- 各VM内で、group・user/PID/mount namespace識別子・uid/gid map・callerのLSM context・capability / NoNewPrivs / Seccomp・選択した5環境変数は両runtime間と測定前後で一致した。各VMのnamespace識別子を別VMとの同一性の証明には使わない。
- `/usr/bin/unshare` は両構成ともutil-linux 2.39.3。実行体hashはBun/Node間で一致した。x64は `a23c8863860669003dc4660039fe642f5795c8c2195898ebc5d01afa1ac3d11c`、arm64は `e0c145c3d4c06686544b1362ed64da819539166a5e1e6fd96093aea4d2539b6a`。
- controller hashは両構成とも `a8ffc58fa701d13a8cdb0ca6fa263e098ca4b9eb77782dc7ed6267cca43d511c` で、対象commitのblobと照合した。
- 専用Nix/group準備・正式44ケース・集約はスキップされた。rootでprobeを実行せず、sysctl / profileを変更せず、特権journalも参照していない。

## 根拠と限界

[選択した公開JSON行](observations.json)にはargv・PID・時刻・終了状態・stdout/stderr・runtime・callerの観測を保存した。[run metadata](run.json)には対象SHA・attempt・stepの終了状態を保存した。取得元は新しい[x64の公開ログ](https://github.com/treflebonbon/skills/actions/runs/44199074826/job/134448139124)と[arm64の公開ログ](https://github.com/treflebonbon/skills/actions/runs/44199074826/job/134448139503)。artifactの取得・読取や、以前拒否された一時ファイルへのアクセスは行っていない。

この条件でのUID mappingのEPERMにはBunが必須ではないことを確認した。Node.jsを含む全callerの影響がないこと、継承環境全体の最小化、OS / LSMの原因確定を示す結果ではない。記録したcapabilityとLSMはcallerの観測であり、失敗したunshare自身の状態を観測したとは扱わない。

Phase 2全体は未完了で、#33は未完了、#82は#33待ちを維持する。macOS 15の方式や全子孫5秒保証の条件も維持する。

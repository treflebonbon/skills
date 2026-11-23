# WSL2 の正式実証（namespace 経路）: 2026-11-21 / `c6947cd`

[ホストに応じて方式を選ぶ正式実証の計画](../../../linux-host-adaptive-proof-plan.md)のうち、手元の WSL2 x64 で PID namespace 経路を実証した記録（#121）。結果は**成功**。対象 SHA を固定し、全件を3回連続で実行して、3回とも skip 0・失敗 0 だった。runner の結果とは別に記録し、互いに読み替えない。

| 項目       | 記録                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| source SHA | `c6947cda6fc5dada4e021cfc87034133393da8cb`（未 commit の tracked 変更が無い clone で実行） |
| ホスト     | WSL2 x64、kernel `6.18.58.1-microsoft-standard-WSL2`                                       |
| 実行       | `bun development/run-linux-process-proof.ts local SOURCE OUTPUT`（非 root、UID 1000）      |
| 選ばれた方式 | `namespace`（前提検査の選択と、3回の試験が使った方式がすべて一致）                       |
| 計画 / 実績 | 47件×3回 / 3回とも 47 pass・0 fail・0 skip・exit 0                                        |
| 判定       | `verifyLocal` が `{"verified":true,"reasons":[]}`（[verdict.json](verdict.json)）         |

## 確認したこと

- 3回とも、実行したケースの集合が manifest v2 の「共通30件＋namespace 専用17件」と一致し、全件が `pass` だった。ケースごとの結果は [job.json](job.json) の `trials[].cases` にある。
- 補助 group の2件（所属時の読み書き、非所属時の拒否）も3回とも成功した。
- 実 Nix・shellHook を現行の caller から実行するケースは、対照（`baseline`）と候補（`candidate`）がどちらも終了状態 37 で、`real-caller:{"hook": "hook-ok"}` を出力した。
- 実行の前後で、対象 checkout の `lib`・`tests`・manifest の hash は変わっていない（`sources` と `sourcesAfter` が一致）。
- `bun test` が報告した1回あたりの実行時間は 21.23〜21.68 秒だった。

## 前提条件

- 道具: Bun `1.4.4`、`unshare`／`setpriv`（util-linux `2.39.3`）、`systemd-run`（systemd `255.4-1ubuntu8.18`）、Nix `2.34.6`（multi-user、sandbox 有効）、C compiler `gcc (GCC) 15.3.0`（Nix の cc）。版と hash は `job.json` の `preflight.tools` にある。
- 実 Nix caller の closure は `development/linux-process-proof.nix` を、`tests/fixtures/raw-codex/nixpkgs-revision` の revision で手元で build した。`bash` は `<nix-store-wsl2-x64>/bash-interactive-5.3p15`、`stdenv` は `<nix-store-wsl2-x64>/stdenv-linux`。
- 補助 group の fixture は、人が外部ターミナルで `sudo` を使って用意し、実行後に削除した。試験用 group（GID 30001）と、root 所有・その group・mode `0060` の file である。試験は `sudo -n` と `setpriv` で資格情報を切り替えた。sysctl・AppArmor・sudoers は変えていない。
- user manager は `active`、linger は `yes` だった。この WSL2 では namespace が選ばれるため、cgroup 経路は使っていない。
- runner で導入する Nix の版・remote・build user 設定は、手元では要求していない（`build-users-group` は空）。

## 記録の範囲

- 固定 Nix store path のハッシュを含む接頭部はプレースホルダーで表す。同名の package root が複数あった場合は連番で区別する。
- `job.json` は、controller が出力した job から、各試験の観測 JSON の `records` を実 caller の1件だけに絞ったものである。省いた件数は `trials[].observation.recordsOmitted` にある。ケースの結果・集計・終了状態・build の source/binary hash・前提検査は省いていない。保存した `job.json` からも次の手順で同じ判定を再現できる。
- raw log・build した実行体・一時領域は保存していない。log の SHA-256 は `trials[].logHash` にある。

## 保存した記録から再判定する

リポジトリのルートで、`job.json` を controller と同じ形式で包み、記録した source SHA の manifest を使う。

```bash
bun -e '
  import { verifyLocal } from "./development/linux-process-proof.ts";
  const job = await Bun.file("docs/evidence/wsl2-host-adaptive/2026-11-21-c6947cd/job.json").json();
  const manifest = Bun.spawnSync(["git", "show", `${job.sourceSha}:development/linux-process-proof-cases.json`]);
  if (manifest.exitCode !== 0) throw new Error(manifest.stderr.toString());
  const verdict = verifyLocal(
    { schema: "linux-process-proof-local/v1", host: "wsl2", sourceSha: job.sourceSha, job },
    JSON.parse(manifest.stdout.toString()),
  );
  console.log(JSON.stringify(verdict));
  if (!verdict.verified) process.exitCode = 1;
'
```

## 示さないこと

- GitHub runner での cgroup 経路と拒否の実証。arm64。runner の判定は別に行う。
- 通常の Ubuntu ホストで namespace 経路が選ばれること。この WSL2 の既定では userns が使えるが、runner の既定では使えない。
- macOS。この実証が成功しても、macOS が残る限り [#33](https://github.com/treflebonbon/skills/issues/33) は未完了で、[#82](https://github.com/treflebonbon/skills/issues/82) は依存待ちのままである。
- PR #84 の42件は古い source での結果で、この記録には数えない。

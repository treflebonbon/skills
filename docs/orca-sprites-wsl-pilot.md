# Windows 版 Orca の Sprites 試験レシピ

初回検証ではこのリポジトリの専用ローカルコピーを Orca に登録し、その主チェックアウトで `Fly.io Sprites pilot via WSL` を選びます。Orca 1.4.265 と、認証済みの `Ubuntu-24.04` WSL ディストリビューションを使用します。

Orca 1.4.265 では、設定の「実験的機能 → クラウド VM」を有効にしないと、作成画面の実行先に「ワークスペースごとの環境」とレシピが出ません。作成前に `orca vm recipe doctor sprites-wsl-pilot --repo-path <専用コピーの UNC パス>` で `recipe.exists` が pass になることを確認します。作成画面ではプロジェクトに専用コピー、実行先に「ワークスペースごとの環境」の `Fly.io Sprites pilot via WSL`、作成元に `orca-sprites-pilot.json` の `ref` に対応する `origin/<ブランチ名>` を選びます。Orca 1.4.265 はこの選択を Sprite 側へ渡さず、Sprite 側の Orca は `origin/HEAD` からワークスペースを作ります。Orca は `origin/HEAD` がリモート追跡ブランチを指すと作成前に取得し直すため、作成スクリプトは `origin/HEAD` を承認済み SHA に固定したローカルブランチ `orca-approved-base` に向けます。Windows ではこの選択とワークスペースの右クリックメニューに前面操作が必要です。

作成後の環境チェックは、Sprite に Git の書き込み認証情報を渡さないため push の試行で FAIL になります。「このまま開く」で接続を続けます。

実機の対象が承認されたら、専用コピーの Git 管理ディレクトリに `orca-sprites-pilot.json` を用意します。値は Fly.io の組織名、GitHub で公開済みのブランチの完全な ref、照合する40桁の SHA です。

```json
{
  "org": "<承認済みの Fly.io 組織名>",
  "ref": "refs/heads/main",
  "sha": "<承認済みの40桁のコミット SHA>"
}
```

作成後に Orca の端末で `git rev-parse HEAD` を照合します。同じ Sprite を停止・再開し、再接続後も照合します。最後に削除し、対象名が Fly.io に残っていないことを確認します。作成開始から20分を目安に未完了なら、その時点で削除確認に移ります。

作成時に試行の対象名を `orca-sprites-pilot-state.json` に記録します。削除時は対象名と所有ラベルを照合します。作成結果や削除を確認できなかった場合はこの記録から同じ Sprite を追跡します。

ローカル検証では `python3 -B -m unittest discover -s tests -p test_orca_sprites_pilot.py` を実行します。試験では `ORCA_SPRITES_PILOT_CLI` に偽の CLI を指定します。偽の CLI は `tests/fixtures/sprite-info-<版>.txt` に記録した実機の `sprite info` 出力を返します。devShell の `sprite` の版が変わると版照合の試験が失敗するので、実機の出力を取り直してファイル名と `SPRITE_VERSION` を更新します。`vm recipe doctor` は、Windows 側で `WSLENV` を設定する4コマンドに対してリポジトリ相対コマンドの静的警告を出します。

## Orca の版を変えるとき

`origin/HEAD` の扱いは Orca 1.4.265 の次の処理に依存します。版を変えるときは、新しい版のタグで同じファイルを読み直します。

- 既定の起点の選び方（`origin/HEAD`、`origin/main`、`origin/master` の順）: [`src/shared/git/refs/git-default-base-ref.ts`](https://github.com/stablyai/orca/blob/v1.4.265/src/shared/git/refs/git-default-base-ref.ts)
- リモート追跡ブランチの起点を作成前に取得し直す処理: [`src/main/runtime/repositories/runtime-remote-tracking-base-fetch.ts`](https://github.com/stablyai/orca/blob/v1.4.265/src/main/runtime/repositories/runtime-remote-tracking-base-fetch.ts)

GitHub を読めない場合は、インストール済みの Orca の `resources/orcad-template/orcad-server.js` を `could not resolve a default base ref` で検索します。

## 削除を確認できなかった場合

記録が残る間、次の作成は拒否されます。失敗したワークスペースを Orca で「閉じる」を押しても削除処理は実行されないため、WSL で次の順に片付けます。

1. 記録の `name` と `org` を使い、`sprite -o <org> info <name>` の `Labels` が `name` と一致することを確認します。一致しない Sprite には触れません。
2. `sprite -o <org> destroy --force <name>` で削除します。
3. `sprite -o <org> list` に `name` が出ないことを確認します。
4. 記録を Git 管理ディレクトリの外へ退避します。退避後に次の作成へ進めます。

`list` に `name` がなく `created` が `false` の場合、作成が途中で終わった可能性があります。数分後に再度 `list` で不在を確認してから退避します。

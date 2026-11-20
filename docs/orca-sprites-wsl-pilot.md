# Windows 版 Orca の Sprites 試験レシピ

初回検証ではこのリポジトリの専用ローカルコピーを Orca に登録し、その主チェックアウトで `Fly.io Sprites pilot via WSL` を選びます。Orca 1.4.265 と、認証済みの `Ubuntu-24.04` WSL ディストリビューションを使用します。

実機の対象が承認されたら、専用コピーの Git 管理ディレクトリに `orca-sprites-pilot.json` を用意します。値は Fly.io の組織名、GitHub で公開済みのブランチの完全な ref、照合する40桁の SHA です。Orca の開始点にも承認済みの SHA に対応する公開ブランチを選びます。

```json
{
  "org": "<承認済みの Fly.io 組織名>",
  "ref": "refs/heads/main",
  "sha": "<承認済みの40桁のコミット SHA>"
}
```

作成後に Orca の端末で `git rev-parse HEAD` を照合します。同じ Sprite を停止・再開し、再接続後も照合します。最後に削除し、対象名が Fly.io に残っていないことを確認します。作成開始から20分を目安に未完了なら、その時点で削除確認に移ります。

作成時に試行の対象名を `orca-sprites-pilot-state.json` に記録します。削除時は対象名と所有ラベルを照合します。作成結果や削除を確認できなかった場合はこの記録から同じ Sprite を追跡します。

ローカル検証では `python3 -B -m unittest discover -s tests -p test_orca_sprites_pilot.py` を実行します。試験では `ORCA_SPRITES_PILOT_CLI` に偽の CLI を指定します。`vm recipe doctor` は、Windows 側で `WSLENV` を設定する4コマンドに対してリポジトリ相対コマンドの静的警告を出します。

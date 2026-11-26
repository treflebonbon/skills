# raw Codex 用 launcher の実証と Nix 配布

[#132](https://github.com/treflebonbon/skills/issues/132) の成果物は Linux／WSL2 向けの C launcher と実行体の検査です。正式実証 #121 と同じ C source を使います。launcher は Bun を準備子として起動し、準備が正常に完了すると入口と同じ PID で target へ `exec` します。呼び出し元は lock を取得して既存の保持期間に従い、必要な FD を入口へ継承させます。 [方式の選択と保証範囲](adr/0005-linux-host-adaptive-preparation-containment.md) · [#121 のホスト実証](linux-host-adaptive-proof-plan.md#結果)

## raw 内での最小実証

合成 worktree を公開する既存の `run_isolated` の runtime 経路を通し、raw の bubblewrap、namespace、capability、Nix closure の read-only mount を使いました。合成コマンドは既存の process と mount の境界で実行し、gateway を起動せず認証なしで検証しました。監視役は隔離内に残り、入口が launcher に置換されたことを照合してから、その PID にだけ pidfd 経由で SIGKILL を送りました。準備子は有効な target frame を送り、`setsid` で離脱した子を起動して待機します。監視役は離脱した子の pidfd の終了通知を単調時計で測り、target の起動記録がないことを確認しました。その後、同じ隔離内の正常系で target の PID、argv、環境変数、TTY と lock の FD identity、signal の ignore と mask、終了37を照合しました。実 caller が持つ制御 TTY は #45 で確認します。

| 環境                                             | 実証結果                                                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WSL2 x86_64、`6.18.58.1-microsoft-standard-WSL2` | PID namespace が成立。全 capability が0。SIGKILL 送信直前から離脱した準備子孫の pidfd で終了を観測するまで約1.77 ms。target は未起動。正常系は入口と同じ PID で終了37。 |
| 現行 raw が動く通常 Linux x86_64                 | #132 の launcher 実証は未実行。                                                                                                                                         |
| 現行 raw が動く通常 Linux ネイティブ arm64       | #132 の launcher 実証は未実行。                                                                                                                                         |

WSL2 の実行には Nix 2.34.6、bubblewrap 0.12.0、Bun 1.4.4 を使用しました。Nix 成果物の版は `1`、2つの C source の SHA-256 を連結してハッシュした値は `d83c5dac31da837c8794ba2d839ff379544b275ceeecdc3284458d123e7799ad`、実行体の SHA-256 は `57edfea2100142009d47a39f605ca7d18d1470aac12df9227faf97862ca6be89` です。ビルドに使った Nixpkgs は `/nix/store/wz6pw7bm0qmj0j6n8i2craddlhj662l5-source`、成果物は `/nix/store/fzlr96fgq217f1w2j9mqjrwbvvh2wfgc-raw-codex-launcher-1` です。

方式の選択は実行時に PID namespace の probe、委譲された cgroup v2、準備前の拒否の順です。WSL2 の raw 隔離内には `/sys/fs/cgroup` と host の user manager の socket がありませんでした。cgroup v2 と拒否の既存証跡は #121 のホスト上の結果です。必要範囲での実証が揃うまで製品化の受入を保留します。 [raw の前提](raw-codex-isolation.md#必要な環境) · [#34 の追加実証条件](bun-namespace-proof.md#追加実証の受入条件)

## 利用側 flake と #45 への引継ぎ

1. 利用側 flake でこの repo を完全なコミット SHA の `flake = false` の入力として固定します。同じ flake の Linux 用 `pkgs` で `pkgs.callPackage "${inputs.skills}/nix/raw-codex-launcher.nix" { }` を評価し、例として `packages.${system}.rawLauncher` から公開します。
2. 通常起動に先立って、明示的に `nix build <flake>#rawLauncher --no-link --print-out-paths` を実行します。信頼済み設定に、その出力の正規の Nix store path と、同じ pin から得た derivation の `sourceSha256` を記録します。binary の SHA-256 と版 `1` はビルドが生成する manifest に記録されています。
3. raw の host 側で `select_raw_launcher(package, source_sha256)` を呼び、返った `RawLauncher` を `run_isolated(..., launcher=launcher)` に渡します。選択時に source、版、実行体の digest、Nix store の所有者と directory 0555／実行体 0555／manifest 0444 を照合します。ホストの store からコピーした後は、選択した出力が mount 対象の closure に含まれ、コピー側の実行体が private store の所有者・mode・digest と一致することを検査します。
4. #45 の生成入口は、検査した `launcher.executable` の絶対 path を明示して `exec` します。引数は runner、Bun の準備 script、準備 script へ渡す残りの引数です。準備子と launcher の間では既存の NUL 区切り `exec-proof-v1` frame を使います。通常起動に伴う自動 build・download・install はありません。

既存の raw から実 caller を使う #45 の受入では、argv、TTY、signal、cleanup、closure と実行体の対応を確認します。利用側 flake の変更は #45 の引継ぎ情報です。 [#45](https://github.com/treflebonbon/skills/issues/45)

## 再実行

Nix store から選択された既存の raw tools と Bun を用意し、対象 worktree で保護された検証入口から次を実行します。環境と成果物の版・digest は結果とともに記録します。opt-in 実行で適合方式を得られない場合、fixture は失敗します。

```sh
RAW_LAUNCHER_PROOF=/nix/store/<hash>-raw-codex-launcher-1 \
  python3 -B -m unittest discover -s tests -p test_raw_launcher.py -v
```

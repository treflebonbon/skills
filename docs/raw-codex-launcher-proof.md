# raw Codex 用 launcher の実証と Nix 配布

[#132](https://github.com/treflebonbon/skills/issues/132) の成果物は Linux／WSL2 向けの C launcher と実行体の検査です。正式実証 #121 と同じ C source を使います。launcher は Bun を準備子として起動し、準備が正常に完了すると入口と同じ PID で target へ `exec` します。呼び出し元は lock を取得して既存の保持期間に従い、必要な FD を入口へ継承させます。 [方式の選択と保証範囲](adr/0005-linux-host-adaptive-preparation-containment.md) · [#121 のホスト実証](linux-host-adaptive-proof-plan.md#結果)

## raw 内での最小実証

合成 worktree を公開する既存の `run_isolated` の runtime 経路を通し、raw の bubblewrap、namespace、capability、Nix closure の read-only mount を使いました。合成コマンドは既存の process と mount の境界で実行し、gateway を起動せず認証なしで検証しました。監視役は隔離内に残り、入口が launcher に置換されたことを照合してから、その PID にだけ pidfd 経由で SIGKILL を送りました。準備子は有効な target frame を送り、`setsid` で離脱した子を起動して待機します。監視役は離脱した子の pidfd の終了通知を単調時計で測り、target の起動記録がないことを確認しました。その後、同じ隔離内の正常系で target の PID、argv、環境変数、TTY と lock の FD identity、signal の ignore と mask、終了37を照合しました。実 caller が持つ制御 TTY は #45 で確認します。

| 環境                                                 | 実証結果                                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WSL2 x86_64、`6.18.58.1-microsoft-standard-WSL2`     | PID namespace が成立。全 capability が0。SIGKILL 送信直前から離脱した準備子孫の pidfd で終了を観測するまで約1.77 ms。target は未起動。正常系は入口と同じ PID で終了37。            |
| 通常 Linux x86_64、NixOS 26.11pre-git、Linux 6.18.34 | PID namespace が成立。全 capability が0。SIGKILL 送信直前から離脱した準備子孫の pidfd で終了を観測するまで約12.45 ms。target は未起動。正常系は入口と同じ PID で終了37。           |
| 通常 Linux arm64、NixOS 26.05、Linux 6.18.57         | PID namespace が成立。全 capability が0。SIGKILL 送信直前から SIGTERM を無視する離脱子孫の pidfd で終了を観測するまで約1.75 ms。target は未起動。正常系は入口と同じ PID で終了37。 |

通常 Linux x86_64 の NixOS は QEMU 11.0.0 の TCG で実行しました。ゲストの既定の kernel セキュリティ設定で UID 1000 を使用し、外部ネットワークを遮断しました。通常 Linux の合成 fixture では、`codex` tool slot に選択済みの Nix Bun を指定しました。表の各環境で launcher の opt-in テスト3件が通過し、失敗・スキップは0件でした。

WSL2 の実行には Nix 2.34.6、bubblewrap 0.12.0、Bun 1.4.4 を使用しました。Nix 成果物の版は `1`、2つの C source の SHA-256 を連結してハッシュした値は `d83c5dac31da837c8794ba2d839ff379544b275ceeecdc3284458d123e7799ad`、実行体の SHA-256 は `57edfea2100142009d47a39f605ca7d18d1470aac12df9227faf97862ca6be89` です。実測時の store 名は、Nixpkgs が `wz6pw7bm0qmj0j6n8i2craddlhj662l5-source`、launcher が `fzlr96fgq217f1w2j9mqjrwbvvh2wfgc-raw-codex-launcher-1` でした。

### ネイティブ arm64 のビルドと実証

2026-11-26 に AWS EC2 Graviton2 `t4g.small`、NixOS AMI `amazon-26.05.12707.718f670e8453` で、非 root ユーザーから実行しました。Nix 2.35.6、bubblewrap 0.13.1、Bun 1.4.4 を使用しました。

初回のビルドは glibc 2.44 が設定した `_POSIX_C_SOURCE` を共通 C source が再定義し、`-Werror` で停止しました。修正版 `c46fab04e570dfc77f41df67ccf8672cf0c9b79f` は既存の定義を維持します。この版を Nixpkgs `e21fec321d73511849707a7585e4ea155ee4bf40` でネイティブにビルドし、同じ EC2 で表の結果を得ました。Bun の package 定義は Nixpkgs `0d765791b09356dd5b356559c1b67c1600ca3c5b` です。

成果物の版は `1`、source の SHA-256 値は `f2c5d1700d416a7ed986df6f7cf48622ac1ad537a586d22e513a19db7aa3b724`、arm64 実行体の SHA-256 は `c735d6651cf6d6b1924ee0b83833fe9f8d476cc368eb214691bd8c0bf54c0074` です。store 名は `d8bxlf9a0dr713k4n4hz591bm0arwdi3-raw-codex-launcher-1` でした。修正版を従来の WSL2 の Nixpkgs pin で再ビルドした x86_64 実行体は、表の WSL2 実証で使用した実行体と byte 単位で一致しました。

修正版を arm64 と同じ Nixpkgs pin でビルドした WSL2 x86_64 でも、opt-in テスト3件が通りました。PID namespace が成立し、SIGTERM を無視する離脱子孫の終了を SIGKILL 送信直前から約1.56 ms で観測しました。target は未起動で、正常系は入口と同じ PID で終了37でした。

方式の選択は実行時に PID namespace の probe、委譲された cgroup v2、準備前の拒否の順です。WSL2 の raw 隔離内には `/sys/fs/cgroup` と host の user manager の socket がありませんでした。cgroup v2 と拒否の既存証跡は #121 のホスト上の結果です。 [raw の前提](raw-codex-isolation.md#必要な環境) · [#34 の追加実証条件](bun-namespace-proof.md#追加実証の受入条件)

## 利用側 flake と #45 への引継ぎ

1. 利用側 flake でこの repo を完全なコミット SHA の `flake = false` の入力として固定します。同じ flake の Linux 用 `pkgs` で `pkgs.callPackage "${inputs.skills}/nix/raw-codex-launcher.nix" { }` を評価し、例として `packages.${system}.rawLauncher` から公開します。
2. 通常起動に先立って、明示的に `nix build <flake>#rawLauncher --no-link --print-out-paths` を実行します。信頼済み設定に、その出力の正規の Nix store path と、同じ pin から得た derivation の `sourceSha256` を記録します。binary の SHA-256 と版 `1` はビルドが生成する manifest に記録されています。
3. raw の host 側で `select_raw_launcher(package, source_sha256)` を呼び、返った `RawLauncher` を `run_isolated(..., launcher=launcher)` に渡します。選択時に source、版、実行体の digest、Nix store の所有者と directory 0555／実行体 0555／manifest 0444 を照合します。ホストの store からコピーした後は、選択した出力が mount 対象の closure に含まれ、コピー側の実行体が private store の所有者・mode・digest と一致することを検査します。
4. #45 の生成入口は、検査した `launcher.executable` の絶対 path を明示して `exec` します。引数は runner、Bun の準備 script、準備 script へ渡す残りの引数です。準備子と launcher の間では既存の NUL 区切り `exec-proof-v1` frame を使います。通常起動に伴う自動 build・download・install はありません。

既存の raw から実 caller を使う #45 の受入では、argv、TTY、signal、cleanup、closure と実行体の対応を確認します。利用側 flake の変更は #45 の引継ぎ情報です。 [#45](https://github.com/treflebonbon/skills/issues/45)

## 再実行

上記の手順で launcher を事前ビルドし、既存の raw tools と Bun 1.4.4 以上を Nix store から選択します。対象 worktree の保護された検証入口から次を実行し、Nixpkgs の pin と出力を保存します。`launcher` にはビルドで得た store path を指定します。 [raw tools の一覧](raw-codex-isolation.md#必要な環境)

```sh
set -eu
git rev-parse HEAD
uname -srm
nix --version
bwrap --version
bun --version
cat "${launcher:?launcher の store path を指定してください}/share/raw-codex-launcher/manifest.json"
RAW_LAUNCHER_PROOF="$launcher" python3 -B -m unittest discover -s tests -p test_raw_launcher.py -v
```

測定では `SIGTERM` を無視する離脱子が起動したことを確認してから、launcher だけに `SIGKILL` を送ります。opt-in 実行で適合方式を得られない場合、fixture は失敗します。通常 Linux arm64 の受入は、既存の raw 隔離が動作する arm64 CPU 上の実機または VM で、この opt-in テスト3件をすべて実行して判定します。 [必要範囲と実行環境](bun-namespace-proof.md#追加実証の受入条件)

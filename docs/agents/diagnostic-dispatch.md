# 診断用 dispatch

GitHub runner で一度だけ測る診断（可否確認・再現・最小化）の型。正式実証（`linux-process-proof.yml` の `proof`）とは別に記録する。例: [cgroup v2 の可否確認](../linux-cgroup-v2-feasibility.md)、[namespace の再現ループ](../bun-process-linux-feedback-loop.md)。

1. **topic branch で測定器と mode を作る。** 測定器は `development/` に置き、既存 workflow に診断 mode を足す。mode では正式実証の手順と集約 job を外し、artifact 名・run 名を正式実証と分ける（集約は run 名 `Linux process proof: <SHA>` だけを履歴に数える）。手元で再現できない経路は、container などでのリハーサルで先に確かめる。
2. **1 回の dispatch で全結果を残す。** 各 step を `if: always()` で続け、測定器は失敗も JSON 行で公開ログに出す（artifact の読取は自動判定で拒否されたことがあるため、証跡の正本は公開ログにする）。
3. **source を固定し、承認を得てから dispatch する。** 完全な SHA とコマンド（`gh workflow run … --ref <branch> -f source_sha=<SHA> -f mode=<mode>`）を示す。承認は 1 回の実行にだけ有効。
4. **証跡を記録する。** `docs/evidence/<topic>/<run>-<attempt>/` に、README、`run.json`（公開 run metadata）、`observations.json`（公開ログの該当行）を置く。README は、確認したこと・前提条件・示さないことを分けて書く。
5. **測定器を main から外す。** 測定器・そのテスト・診断 mode を削除し、文書からは run が固定した commit の blob を参照する。

runner から GitHub API を読む step には、その job だけに `actions: read` を与え、job token で読む。GitHub-hosted runner の IP は認証なしの上限（1時間60回）を他の利用者と共有しており、正式実証の集約は2回この上限で未達になった（[run 45012162020](../evidence/linux-process-proof/45012162020-1/README.md)）。

`.github/workflows/` への書込みは自動判定で拒否される。workflow は scratchpad に全文を書いて actionlint にかけ、人に `! cp <scratchpad の全文> .github/workflows/<file>` を渡す。戻すときも同じで、`! git checkout <main の SHA> -- .github/workflows/<file>` を渡す。

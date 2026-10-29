# Orca の native 協働

別途導入した [`orca-cli` と `orchestration` skill](dependencies.md) を読み、現在の runtime guide と receipt を正本にする。公開 CLI reference は [CLI reference](https://www.onorca.dev/docs/cli/reference) と [Orchestration](https://www.onorca.dev/docs/cli/orchestration)。

実行ファイルは `orca-cli` の選択規則で一度だけ決める。`ORCA_CLI_COMMAND` が設定済みならその値、次に `ORCA_DEV_REPO_ROOT` を公開する dev session なら `orca-dev`、Linux の Orca 管理外 terminal なら WSL bridge を含む `orca-ide`、それ以外は `orca` を使う。Linux 管理外で bare `orca` を実行しない。

以下の `ORCA` は選んだ実行ファイルへの置換用で、literal コマンドや shell 変数ではない。最初に版が一致する guide を読み、以降も同じ実行ファイルを使う。起動不能なら正確なエラーを報告し、別実行ファイルへ自動で切り替えない。

Python の例は環境変数 `SKILL_DIR` にロード済み `SKILL.md` の親 directory、`ORCA_CLI` に選択済み実行ファイルを設定する。`SKILL_DIR` から package root を求め、package 内 helper の絶対 path を組み立てる。

```text
ORCA skills get orca-cli --json
ORCA skills get orchestration --json
```

共有 receipt と reply は、SKILL.md で作成した `/tmp/codex` 配下の run directory に置く。以降の `$run_dir` はその確認済み絶対パスを指す。保存・中断からの復旧は [証跡の保存と復旧](evidence.md) に従う。

## native 評価前の preflight

評価前に、本番と同じ native 起動経路で root → peer の深度と起動 effective 値（agent / model / effort）を smoke 確認する。`nested_worker_depth_exceeded` はシナリオの失敗採点ではなく環境不適合として別に記録する。設定変更や新しい Run の作成で深度をリセットしたことにしない。

Run / Dispatch の receipt は、独立した runtime の期待値と照合する。`scripts/orca-preflight.py` の `coordinator` / `worker-show` は保存済み native receipt を読み、`worker-readiness record` は worker 自身の Git metadata を別の JSON に記録し、`verify` はその JSON と親が独立取得した Git metadata を照合する。いずれも CLI wrapper、Run の bind、権限付与、再送は行わない。

```text
python3 <skill-dir>/scripts/orca-preflight.py coordinator <run-receipt.json> --run <expected-run-id> --handle <coordinator-handle>
python3 <skill-dir>/scripts/orca-preflight.py worker-show <worker-show-receipt.json> --dispatch <expected-dispatch-id> --task <expected-task-id> --assignee <expected-terminal-handle>
```

coordinator receipt は `ok: true` と `result.run.id` / `result.run.coordinator_handle` の一致を要する。worker-show receipt は `ok: true` と `result.dispatch.id` / `taskId` / `assigneeHandle` の一致、および `status: dispatched` を要する。settled、error、malformed、欠落、不一致は拒否する。期待値は preamble または runtime の bound Run / worker-start 結果から取り、検査対象の receipt から作らない。

## Worktree readiness

ローカル変更につながる診断・実装を Git task worktree で監督するとき、peer 協働に限らず適用する。folder workspace と primary checkout での説明・状態確認・読み取り調査は対象外。この CLI は worker と verifier が同じ実行 host 上の Git task worktree を参照できる場合に使う。remote placement では親の local path から worker 側を推測せず、実行 host 側の独立観測がない限り照合成功として扱わない。native worktree と Agent Picker の built-in agent 起動、Orca が所有する permission mode はそのまま使う。次の順序を守り、worker の診断・編集は照合成功後に始める。

1. 親は Task の初回 `--spec` を準備確認だけにし、「native Task / Dispatch / handle と現在の checkout を記録して報告し、親の照合まで待つ」ことだけを指示する。親は native の割当結果から Task / Dispatch / worker handle / worktree の絶対 path を確定し、割当時の branch と開始 HEAD も独立に記録する。既存の `worker-show` receipt 検証は引き続き実行し、worker readiness JSON の代用にしない。
2. worker は割当直後、ソースを読む前に共有作業領域へ新しい記録先を作り、現在の自分の process cwd から観測を保存する。Task / Dispatch / handle と絶対 JSON path を親へ報告し、実タスクの説明を受け取るまで待つ。

```bash
mkdir -p /tmp/codex
readiness_dir=$(mktemp -d /tmp/codex/orca-readiness.XXXXXX)
python3 <skill-dir>/scripts/orca-preflight.py worker-readiness record "$readiness_dir/worker-readiness.json" \
  --task <task-id> --dispatch <dispatch-id> --assignee <worker-handle>
```

この JSON は native receipt ではなく、`orca-worker-readiness-observation/v1` の checkout 観測である。record は既存ファイルを上書きせず、Git metadata 読取では ambient `GIT_*` を除く。worker は絶対 path と native Task / Dispatch / handle を親へ送り、照合結果を待つ。

3. 親は native 割当から固定した path・branch・開始 HEAD と ID を渡して、別の自分の process から検査する。観測ファイルの値から期待値を作らない。

```bash
python3 <skill-dir>/scripts/orca-preflight.py worker-readiness verify <worker-readiness.json> \
  --worktree <native-assigned-absolute-path> --branch <assigned-branch> --head <assigned-start-head> \
  --task <task-id> --dispatch <dispatch-id> --assignee <worker-handle>
```

verify は指定 path から physical root・branch・HEAD・absolute Git dir・common dir を独立に取得し、cwd を root として worker 観測の六項目および native ID と比較する。割当時の branch / HEAD と現在の指定 worktree も一致しなければならず、primary checkout、別 worktree、欠落・不正・不一致は拒否する。観測 JSON は読取り専用で、malformed JSON と shell 風文字列も実行しない。照合成功後だけ親は `dispatch:<dispatch-id>` 宛てに実タスク本文を送る。

`task_body_file` には確定済み本文を保存したファイルの path を指定する。ファイルから読んだ本文を引用付きの変数として渡す。

```bash
task_body=$(cat -- "$task_body_file") &&
ORCA orchestration send --to "dispatch:<dispatch-id>" --subject "実タスク開始" --body "$task_body" --type dispatch --json
```

失敗・観測不能時は診断・編集へ進まず、記録を保って親へ報告する。これは native launch や permission boundary を置き換える wrapper ではない。

## 役割別の正規経路

以下の `run-create`／`worker-start` の例は初回起動用。再開時は既存 receipt を照合し、native の現在状態を確認してから続ける。起動コマンドを再実行せず、読取り例を使う。receipt の存在だけを完了と扱わず、不正・未完了なら保持して復旧手順へ戻る。

出力は上書き禁止の `.part` へ保存し、コマンドの成功と JSON 構文の確認後にだけ `ln` で確定名を作る。既存の確定名も置換しない。各保存が失敗したら後続へ進まない。`.json` がなく `.part` だけ残った場合は未確定の試行として保持し、native の状態と実行記録を照合して復旧する。起動コマンドの再実行や、未確認の `.part` の昇格・削除は行わない。確定後も下記 preflight で identity を照合する。

### 普通の dispatched worker

自分の live preamble の handle で、自分の inbox を読む。通常の dispatched worker は `--run` を付けず、status を含む全 delivery を確認する。

```text
ORCA orchestration check --terminal <worker-handle> --wait --timeout-ms 45000 --json
ORCA orchestration check --terminal <worker-handle> --ack <delivery-id-from-result-json> --wait --timeout-ms 45000 --json
```

### coordinator

coordinator は自分の terminal handle で Run を作成・bindし、返った Run ID を全 task / worker 操作に使う。

```text
: "${run_dir:?共有 run directory の絶対パスを指定してください}" &&
(set -C
  test ! -e "$run_dir/run-create.json" &&
  ORCA orchestration run-create --objective "<元候補の改善>" --from <coordinator-handle> --json > "$run_dir/run-create.json.part" &&
  python3 -m json.tool "$run_dir/run-create.json.part" > /dev/null &&
  ln "$run_dir/run-create.json.part" "$run_dir/run-create.json") &&
ORCA orchestration check --terminal <coordinator-handle> --run <run-id> --wait --timeout-ms 45000 --json &&
ORCA orchestration task-create --spec "準備確認のみ: native Task / Dispatch / handle と現在の checkout を記録して報告し、親の照合まで待つ" --task-title "<title>" --run <run-id> --from <coordinator-handle> --json &&
receipt_dir=$(mktemp -d "$run_dir/worker.XXXXXX") &&
(set -C
  test ! -e "$receipt_dir/worker-start.json" &&
  ORCA orchestration worker-start --task <task-id> --worktree id:<returned-worktree-id> --agent claude --run <run-id> --from <coordinator-handle> --json > "$receipt_dir/worker-start.json.part" &&
  python3 -m json.tool "$receipt_dir/worker-start.json.part" > /dev/null &&
  ln "$receipt_dir/worker-start.json.part" "$receipt_dir/worker-start.json") &&
(set -C
  test ! -e "$receipt_dir/worker-show.json" &&
  ORCA orchestration worker-show --dispatch <dispatch-id> --json > "$receipt_dir/worker-show.json.part" &&
  python3 -m json.tool "$receipt_dir/worker-show.json.part" > /dev/null &&
  ln "$receipt_dir/worker-show.json.part" "$receipt_dir/worker-show.json") &&
python3 <skill-dir>/scripts/orca-preflight.py coordinator "$run_dir/run-create.json" --run <bound-run-id> --handle <runtime-handle> &&
python3 <skill-dir>/scripts/orca-preflight.py worker-show "$receipt_dir/worker-show.json" --dispatch <started-dispatch-id> --task <started-task-id> --assignee <started-terminal-handle>
```

worker ごとに `mktemp` の返した receipt directory を保持し、再実行時は既存 receipt を読み直す。新しい worker には新しい directory を作る。checkpoint には全 worker の各 receipt ファイルを明示して渡す。

保存した `run-create` receipt と、独立して分かっている Run ID / coordinator handle を coordinator preflight に渡す。`worker-show` receipt も start が返した Task / Dispatch / terminal と照合してから進む。reviewer は別 terminal の read-only peer とし、worker を別 runtime の subagent に置換しない。

peer には共有の絶対 reply-file を渡し、1 行目を `DONE <REQ> <sha>` にさせる。採用前に、この行と応答内の Task / Dispatch ID を `worker-start` receipt と照合する。`worker-start` に read-only の強制指定はないため、所有範囲は spec に明記し、完了後に native と fixture の `git status` と入力 hash が未変更であることを確認してから採用する。

### nested coordinator

実 worker がさらに peer を監督するときは、自分が owner となる child Run を作成・bindする。上位 coordinator から自分の Dispatch 宛てに届く follow-up と child worker の message は、child Run に bind した自分の terminal inbox で処理する。上位 Task / Dispatch / REQ / SHA は保持し、上位へ返す完了は live preamble の handle と Task / Dispatch ID を使う。

ローカル変更を行う child worker も [Worktree readiness](#worktree-readiness) に従う。Task の初回 spec は準備確認だけにし、child worker の観測を同じ実行 host で独立 verify した後、成功時だけ child Dispatch 宛てに実タスク本文を送る。

```text
: "${run_dir:?共有 run directory の絶対パスを指定してください}" &&
child_run_dir=$(mktemp -d "$run_dir/child-run.XXXXXX") &&
(set -C
  test ! -e "$child_run_dir/run-create.json" &&
  ORCA orchestration run-create --objective "<child work>" --from <nested-coordinator-handle> --json > "$child_run_dir/run-create.json.part" &&
  python3 -m json.tool "$child_run_dir/run-create.json.part" > /dev/null &&
  ln "$child_run_dir/run-create.json.part" "$child_run_dir/run-create.json") &&
ORCA orchestration check --terminal <nested-coordinator-handle> --run <child-run-id> --wait --timeout-ms 45000 --json &&
ORCA orchestration task-create --spec "準備確認のみ: native Task / Dispatch / handle と現在の checkout を記録して報告し、親の照合まで待つ" --task-title "<title>" --run <child-run-id> --from <nested-coordinator-handle> --json &&
child_receipt_dir=$(mktemp -d "$child_run_dir/worker.XXXXXX") &&
(set -C
  test ! -e "$child_receipt_dir/worker-start.json" &&
  ORCA orchestration worker-start --task <child-task-id> --worktree id:<child-worktree-id> --agent codex --run <child-run-id> --from <nested-coordinator-handle> --json > "$child_receipt_dir/worker-start.json.part" &&
  python3 -m json.tool "$child_receipt_dir/worker-start.json.part" > /dev/null &&
  ln "$child_receipt_dir/worker-start.json.part" "$child_receipt_dir/worker-start.json")
```

peer の ID / Run で上位の ID を置き換えたり、上位 coordinator の mailbox を直接読んだりしない。

子の照合成功後に実タスクを送る宛先は child Dispatch とする。

```bash
task_body=$(cat -- "$task_body_file") &&
ORCA orchestration send --to "dispatch:<child-dispatch-id>" --subject "実タスク開始" --body "$task_body" --type dispatch --json
```

上位 coordinator から nested Dispatch への follow-up は、安定した Dispatch 宛てに送り `--run` を省略する。child coordinator の `check` / `reply` / ack は child Run を指定し、上位 coordinator の `check` / `reply` / ack は上位 Run を指定する。

```bash
task_body=$(cat -- "$task_body_file") &&
ORCA orchestration send --to "dispatch:<nested-dispatch-id>" --from "<coordinator-handle>" --subject "follow-up" --body "$task_body" --type status --json
```

## ID を receipt から渡す

ID を手入力・再構成せず、JSON receipt を `json.load` し、その値を `subprocess.run` の argv list に渡す。以下は選択済み CLI を `orca` に設定する例。実行時の第1引数に上記 `$run_dir`、第2引数に対象 worker の `$receipt_dir` を渡す。coordinator の expected Run ID は bound inbox の peek 結果、handle は runtime が出した `ORCA_TERMINAL_HANDLE` と照合する。worker-show の expected 値は worker-start receipt から取り出す。

```bash
python3 - "${run_dir:?共有 run directory の絶対パスを指定してください}" "${receipt_dir:?対象 worker の receipt directory を指定してください}" <<'PY'
import json
import os
import subprocess
import sys
from pathlib import Path

run_dir = Path(sys.argv[1])
receipt_dir = Path(sys.argv[2])

orca = os.environ["ORCA_CLI"]
checker = str(Path(os.environ["SKILL_DIR"]).resolve() / "scripts/orca-preflight.py")
with open(run_dir / "run-create.json", encoding="utf-8") as stream:
    created = json.load(stream)
run = created["result"]["run"]
handle = os.environ["ORCA_TERMINAL_HANDLE"]
bound = subprocess.run(
    [orca, "orchestration", "check", "--terminal", handle, "--peek", "--json"],
    capture_output=True,
    text=True,
    check=True,
)
run_id = json.loads(bound.stdout)["result"]["runId"]
subprocess.run(
    [sys.executable, checker, "coordinator", str(run_dir / "run-create.json"), "--run", run_id, "--handle", handle],
    check=True,
)
subprocess.run(
    [orca, "orchestration", "check", "--terminal", handle, "--run", run_id, "--wait", "--timeout-ms", "45000", "--json"],
    check=True,
)

with open(receipt_dir / "worker-start.json", encoding="utf-8") as stream:
    started = json.load(stream)["result"]
assignee = next(
    effect["id"] for effect in started["effects"]
    if effect.get("kind") == "terminal" and effect.get("role") == "agent"
)
shown_path = receipt_dir / "worker-show.json"
candidate_path = shown_path
if not shown_path.exists():
    candidate_path = receipt_dir / "worker-show.json.part"
    if candidate_path.exists():
        sys.exit("未確定の receipt があります。native の状態と実行記録を照合してください")
    shown = subprocess.run(
        [orca, "orchestration", "worker-show", "--dispatch", started["dispatchId"], "--json"],
        capture_output=True,
        text=True,
        check=True,
    )
    with open(candidate_path, "x", encoding="utf-8") as stream:
        stream.write(shown.stdout)
subprocess.run(
    [sys.executable, checker, "worker-show", str(candidate_path), "--dispatch", started["dispatchId"], "--task", started["taskId"], "--assignee", assignee],
    check=True,
)
if candidate_path != shown_path:
    os.link(candidate_path, shown_path)
PY
```

ordinary / nested worker の `check` は filter なしで whole FIFO を読むため、`status` follow-up でも起きる。全 message を処理してから、JSON の `result.deliveryId` を同じ handle の `--ack` argv に渡す。`consumer_fenced` は例外を成功扱いせず、その場で停止する。

## literal message body

複数行または shell 記号を含む本文は UTF-8 ファイルに置き、package root の `bin/orca-send` に本文と native send 引数を渡す。`--cli` にはこの session で選択した Orca 実行ファイルを指定し、live receipt の宛先・handle・Run ID に置き換える。helper は `shell` を使わず `--body` などの二重指定を拒否する。package root はロード済み `SKILL.md` の位置から解決する。

選択済み CLI の `orchestration send` は `--body` のみを受け付けるため、本文はプロセスの argv に入り、同一ホストのプロセスから見える可能性がある。本文は公開情報に限り、UTF-8で8 KiB以内にする。上限を超える場合は公開証跡ファイルのパスと短い要約を送る。native 引数や環境を含む OS の起動上限も適用され、上限内でも起動に失敗した場合は非0終了する。

<!-- literal-safe-example:start -->

```python
import os
import subprocess
from pathlib import Path

body_file = os.environ["ORCA_BODY_FILE"]  # UTF-8本文ファイルの絶対パス
skill_dir = Path(os.environ["SKILL_DIR"]).resolve()
plugin_root = skill_dir.parents[1]
sender = str(plugin_root / "bin" / "orca-send")
orca = os.environ["ORCA_CLI"]
subprocess.run(
    [
        sender,
        "--cli", orca,
        "--body-file", body_file,
        "--",
        "--to", "run:<run-id>",
        "--run", "<run-id>",
        "--from", "<sender-handle>",
        "--subject", "レビュー依頼",
        "--type", "status",
        "--json",
    ],
    check=True,
)
```

<!-- literal-safe-example:end -->

## 検証記録

検証記録は全採点と native receipt が確定し、一つにまとまった evidence packet を受け取った後にだけ書く。全 raw log は保管し、本文には選んだ項目と参照先だけを表示する。usage が取得できない場合は `null` とし、0 や推定値で埋めない。`tool_uses` または `duration_ms` が欠けた round は strict convergence の判定に含めず、既存の `empirical-prompt-tuning` 規則どおり `qualitative plateau; quantitative convergence unverified` と記録して metadata を提供する runtime で再評価するか、`resource cutoff` として終了する。native boundary smoke は native 境界の成立確認、committed SHA の Standards / Spec review はコード差分の確認として別々に記録し、相互の証拠にしない。

## inbox / settlement

Delivery の全 message を処理してから ack する。完了は現在の Task ID / Dispatch ID、依頼 ID／SHA と検証結果を照合して採用する。terminal の idle や送信成功だけでは完了にしない。`consumer_fenced` を受けたら停止し、再試行も `worker_done` も送らず、receipt とエラーを保持する。

共有・remote の状態をローカルから推測せず、接続喪失を process 終了と扱わない。settlement は runtime guide に従い、完了済み reviewer は worker-read で記録を保存してから worker-release する。保留・状態不明の process を停止・release せず保持する。`run` / `run-stop` は廃止されたため使わず、共有状態の `reset` はこのフローで実行しない。

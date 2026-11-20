#!/usr/bin/env python3
"""専用tracefsインスタンスで直接UID-map子の戻り値を観測する。"""

import errno
import json
import os
import re
import sys
from pathlib import Path

TRACEFS = Path("/sys/kernel/tracing")
KERNEL = "7.0.0-1017-azure"
TRACE_LIMIT = 256 * 1024
ROLES = ("map", "control")
EVENTS = {
    "write_enter": ("p", "proc_uid_map_write", ""),
    "write_exit": ("r", "proc_uid_map_write", "ret=$retval:s64"),
    "file_enter": ("p", "file_ns_capable", "cap=$arg3:s32"),
    "file_exit": ("r", "file_ns_capable", "ret=$retval:u8"),
    "apparmor_enter": ("p", "apparmor_capable", "cap=$arg3:s32"),
    "apparmor_exit": ("r", "apparmor_capable", "ret=$retval:s32"),
}
TRACE_LINE = re.compile(
    r"^\s*.+-(\d+)\s+\[\d+\]\s+\S+\s+(\d+\.\d+):\s+(?:\w+:)?(\w+):\s+(.*)$"
)
TRACE_FIELD = re.compile(r"(?:^|\s)(cap|ret)=(-?\d+|0x[0-9a-fA-F]+)(?=\s|$)")


class TraceError(ValueError):
    """公開可能な診断中断理由。"""


def group_name(run, attempt, role):
    """このrun・反復・役割だけが使うイベント名を返す。"""
    if not re.fullmatch(r"[1-9][0-9]{0,15}", run) or not re.fullmatch(r"[1-9][0-9]{0,3}", attempt) or role not in ROLES:
        raise TraceError("トレースのrun・attempt・役割が不正です")
    return f"uidmap_{run}_{attempt}_{role}"


def kprobe_command(command):
    """appendで対象のイベントだけを登録・解除する。"""
    with (TRACEFS / "kprobe_events").open("a", encoding="ascii") as stream:
        stream.write(command + "\n")


def remove_trace(group):
    """今回のインスタンスと名前付きイベントを後片付けする。"""
    instance = TRACEFS / "instances" / group
    failed = False
    if instance.is_dir():
        try:
            (instance / "tracing_on").write_text("0\n", encoding="ascii")
            group_enable = instance / "events" / group / "enable"
            if group_enable.is_file():
                group_enable.write_text("0\n", encoding="ascii")
            instance.rmdir()
        except OSError:
            failed = True
    for event in EVENTS:
        if (TRACEFS / "events" / group / event).is_dir():
            try:
                kprobe_command(f"-:{group}/{event}")
            except OSError:
                failed = True
    if failed:
        raise TraceError("専用トレースの解除に失敗しました")


def preflight(run, attempt):
    """観測可能性と、使用する名前がまだ存在しないことを読取で確認する。"""
    groups = [group_name(run, attempt, role) for role in ROLES]
    identity = os.uname()
    if identity.machine != "aarch64" or identity.release != KERNEL:
        raise TraceError("既知のarm64 Azureカーネルと一致しません")
    if ((Path("/sys/module/apparmor/parameters/enabled").read_text().strip() != "Y")
            or Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").read_text().strip() != "1"):
        raise TraceError("AppArmorの再現条件が一致しません")
    if not os.path.ismount(TRACEFS) or not (TRACEFS / "kprobe_events").is_file() or not (TRACEFS / "instances").is_dir():
        raise TraceError("既設のtracefsとKprobe eventsが必要です")
    required = {definition[1] for definition in EVENTS.values()}
    with (TRACEFS / "available_filter_functions").open(encoding="ascii") as stream:
        present = {line.split()[0] for line in stream if line.strip()}
    if not required <= present:
        raise TraceError("必要なカーネル関数の観測可能性を確認できません")
    if any((TRACEFS / folder / group).exists() for group in groups for folder in ("instances", "events")):
        raise TraceError("今回のトレース名は既に使われています")


def require_probe_child(owner, pid, uid):
    """実行を待機している非rootの所有子だけを有効化する。"""
    with Path(f"/proc/{pid}/status").open(encoding="utf-8") as stream:
        fields = dict(line.split(":", 1) for line in stream if line.startswith(("Uid:", "PPid:")))
    if fields.get("PPid", "").strip() != str(owner) or fields.get("Uid", "").split() != [str(uid)] * 4:
        raise TraceError("待機中の非root所有子を照合できません")


def arm_trace(group, owner, pid, uid):
    """PIDフィルタを有効にしてから対象子の開始を許可する。"""
    require_probe_child(owner, pid, uid)
    instance = TRACEFS / "instances" / group
    if instance.exists() or (TRACEFS / "events" / group).exists():
        raise TraceError("今回のトレース名は既に使われています")
    instance.mkdir()
    try:
        (instance / "tracing_on").write_text("0\n", encoding="ascii")
        (instance / "buffer_size_kb").write_text("16\n", encoding="ascii")
        (instance / "trace_clock").write_text("mono\n", encoding="ascii")
        for event, (kind, symbol, fields) in EVENTS.items():
            kprobe_command(f"{kind}:{group}/{event} {symbol} {fields}".rstrip())
            event_dir = instance / "events" / group / event
            (event_dir / "filter").write_text(f"common_pid == {pid}\n", encoding="ascii")
            (event_dir / "enable").write_text("1\n", encoding="ascii")
        (instance / "tracing_on").write_text("1\n", encoding="ascii")
    except OSError:
        remove_trace(group)
        raise


def parse_trace(raw, pid, role):
    """対象PID・対象writeの定型イベントだけを返す。"""
    counters = re.search(r"entries-in-buffer/entries-written:\s*(\d+)\s*/\s*(\d+)", raw)
    if not counters or counters[1] != counters[2]:
        raise TraceError("トレースバッファの欠落を除外できません")
    entries = []
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = TRACE_LINE.fullmatch(line)
        if not match or int(match[1]) != pid or match[3] not in EVENTS:
            raise TraceError("PIDまたはトレース形式が一致しません")
        _, timestamp, event, payload = match.groups()
        entry = {"event": event, "time": timestamp}
        _, _, fetch = EVENTS[event]
        if fetch:
            field = TRACE_FIELD.findall(payload)
            if len(field) != 1 or field[0][0] != fetch.split("=", 1)[0]:
                raise TraceError("能力番号または戻り値を照合できません")
            key, number = field[0]
            entry[key] = int(number, 16 if number.startswith("0x") else 10)
        entries.append(entry)
    if len(entries) != int(counters[1]):
        raise TraceError("トレース件数が一致しません")
    starts = [i for i, event in enumerate(entries) if event["event"] == "write_enter"]
    ends = [i for i, event in enumerate(entries) if event["event"] == "write_exit"]
    if role == "control" and not starts and not ends:
        return {"status": "no-uid-map-write", "events": []}
    if role == "map" and len(starts) == len(ends) == 1 and starts[0] < ends[0]:
        matched = entries[starts[0]:ends[0] + 1]
        stack = []
        for entry in matched[1:-1]:
            hook, stage = entry["event"].rsplit("_", 1)
            if stage == "enter":
                stack.append(hook)
            elif not stack or stack.pop() != hook:
                raise TraceError("能力検査の開始と戻り値を対応付けられません")
        if stack:
            raise TraceError("能力検査の開始と戻り値を対応付けられません")
        return {"status": "observed", "events": matched}
    raise TraceError("対象writeの開始と終了を一対一に対応付けられません")


def finish_trace(group, pid, role):
    """観測を止めて有限の結果を読み、インスタンスを解除する。"""
    instance = TRACEFS / "instances" / group
    try:
        (instance / "tracing_on").write_text("0\n", encoding="ascii")
        with (instance / "trace").open("rb") as stream:
            raw = stream.read(TRACE_LIMIT + 1)
        if len(raw) > TRACE_LIMIT:
            raise TraceError("トレースが読取上限を超えました")
        return parse_trace(raw.decode("ascii", errors="replace"), pid, role)
    finally:
        remove_trace(group)


def main(args):
    """明示された観測段階だけを管理権限で実行する。"""
    record = {"schema": "linux-namespace-uid-write-trace/v1", "status": "unavailable"}
    try:
        uid = int(os.environ.get("SUDO_UID", "0"))
        if os.geteuid() != 0 or uid <= 0 or sys.platform != "linux":
            raise TraceError("観測には非root callerからのsudoが必要です")
        if len(args) not in (3, 6):
            raise TraceError("トレースの引数が不正です")
        phase, run, attempt, *target = args
        record.update(phase=phase if phase in ("check", "arm", "finish", "cleanup") else "unknown")
        if phase == "check" and not target:
            preflight(run, attempt)
            record.update(status="ready", kernel=KERNEL, runId=run, attempt=int(attempt))
        elif phase == "cleanup" and not target:
            groups = [group_name(run, attempt, role) for role in ROLES]
            failed = False
            for group in groups:
                try:
                    remove_trace(group)
                except TraceError:
                    failed = True
            if failed:
                raise TraceError("専用トレースの解除に失敗しました")
            record["status"] = "cleaned"
        elif phase in ("arm", "finish") and len(target) == 3:
            role, owner, pid = target
            group = group_name(run, attempt, role)
            if not all(re.fullmatch(r"[1-9][0-9]{0,6}", p) and 1 < int(p) <= 4194304 for p in (owner, pid)):
                raise TraceError("対象PIDが不正です")
            record.update(role=role, ownerPid=int(owner), pid=int(pid))
            if phase == "arm":
                arm_trace(group, int(owner), int(pid), uid)
                record["status"] = "armed"
            else:
                record.update(finish_trace(group, int(pid), role))
        else:
            raise TraceError("トレースの段階と引数が一致しません")
    except TraceError as exc:
        record["reason"] = str(exc)
    except (OSError, ValueError) as exc:
        record["reason"] = errno.errorcode.get(getattr(exc, "errno", None), type(exc).__name__)
    print("[DEBUG-ns-uid-write-trace] " + json.dumps(record, ensure_ascii=False), flush=True)
    return 2 if record["status"] == "unavailable" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""Collect syntax evidence for explicitly selected TypeScript files."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

KINDS = (
    'call_expression', 'return_statement', 'if_statement', 'ternary_expression',
    'yield_expression', 'throw_statement', 'arrow_function',
    'function_declaration', 'function_expression',
)
LANGUAGES = {'.ts': 'TypeScript', '.tsx': 'Tsx'}


def collect(repo_root, files):
    result = {'schema_version': 1, 'status': 'failed', 'reason': None,
              'capabilities': 'syntax-only', 'files': [], 'nodes': []}
    executable = shutil.which('ast-grep')
    if executable is None:
        return {**result, 'status': 'unavailable', 'reason': 'ast-grep is not on PATH'}
    try:
        root = repo_root.resolve(strict=True)
        sources = []
        for name in dict.fromkeys(files):
            source = (root / name).resolve(strict=True)
            relative = source.relative_to(root).as_posix()
            if not source.is_file() or source.suffix not in LANGUAGES:
                raise ValueError(f'Expected a .ts or .tsx file: {name}')
            contents = source.read_bytes()
            sources.append((relative, LANGUAGES[source.suffix], contents))
            result['files'].append({'path': relative, 'sha256': hashlib.sha256(contents).hexdigest()})
        nodes = []
        deadline = time.monotonic() + 30
        # Isolate scans from the target repository's ast-grep configuration.
        with tempfile.TemporaryDirectory(prefix='rop-syntax-') as directory:
            for relative, language, contents in sources:
                rules = '\n---\n'.join(json.dumps({'id': kind, 'language': language,
                                                  'rule': {'kind': kind}})
                                        for kind in (*KINDS, 'ERROR'))
                # Recovered missing tokens have empty text but retain their token kind.
                # Match via the program so unnamed tokens and uncollected syntax count too.
                rules += '\n---\n' + json.dumps({
                    'id': 'missing-token', 'language': language,
                    'rule': {'kind': 'program', 'has': {'regex': '^$', 'stopBy': 'end'}},
                })
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('ast-grep extraction exceeded 30 seconds')
                proc = subprocess.run([executable, 'scan', '--stdin', '--inline-rules', rules,
                                       '--json=compact'], input=contents.decode('utf-8'),
                                      text=True, encoding='utf-8', capture_output=True,
                                      cwd=directory, timeout=remaining)
                if proc.returncode not in (0, 1):
                    raise ValueError(f'ast-grep exited {proc.returncode}: {proc.stderr[:500]}')
                matches = json.loads(proc.stdout)
                if not isinstance(matches, list):
                    raise ValueError('ast-grep returned a non-array result')
                for match in matches:
                    kind = match['ruleId']
                    if kind in ('ERROR', 'missing-token'):
                        raise ValueError(f'ast-grep reported a syntax error ({kind}) in {relative}')
                    if kind not in KINDS:
                        raise ValueError(f'Unexpected syntax kind: {kind}')
                    lo = match['range']['byteOffset']['start']
                    hi = match['range']['byteOffset']['end']
                    if not (type(lo) is int and type(hi) is int and 0 <= lo < hi <= len(contents)):
                        raise ValueError('ast-grep returned an invalid source range')
                    text = contents[lo:hi].decode('utf-8')
                    if text != match['text']:
                        raise ValueError('ast-grep text does not match the supplied source')
                    nodes.append({'path': relative, 'kind': kind,
                                  'start': contents[:lo].count(b'\n') + 1,
                                  'end': contents[:hi - 1].count(b'\n') + 1,
                                  'byte_start': lo, 'byte_end': hi,
                                  'text': text[:180], 'text_truncated': len(text) > 180})
        nodes.sort(key=lambda n: (n['path'], n['byte_start'], -n['byte_end'], n['kind']))
        stack = []
        for i, node in enumerate(nodes):
            node['id'] = i
            while stack and (stack[-1]['path'] != node['path']
                             or stack[-1]['byte_end'] < node['byte_end']
                             or stack[-1]['byte_end'] <= node['byte_start']):
                stack.pop()
            if stack and (stack[-1]['byte_start'], stack[-1]['byte_end']) == (node['byte_start'], node['byte_end']):
                # Equal spans share a parent; retain the first as descendants' parent.
                node['parent'] = stack[-1]['parent']
            else:
                node['parent'] = stack[-1]['id'] if stack else None
                stack.append(node)
        return {**result, 'status': 'ok', 'nodes': nodes}
    except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired) as error:
        return {**result, 'reason': f'{type(error).__name__}: {error}'[:600]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('files', nargs='+', help='Explicit .ts/.tsx paths relative to the repository root')
    args = parser.parse_args()
    result = collect(args.repo_root, args.files)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    # Evidence failures are recorded for the caller to continue source reading.
    print(f"{result['status']}: {args.output}")


if __name__ == '__main__':
    main()

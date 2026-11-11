"""Contract tests for syntax evidence and source-only fallback."""
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

script = Path(sys.argv.pop(1)).resolve()
bun = shutil.which('bun')
if bun is None:
    sys.exit('Bun is required for the TypeScript evidence tests')


class SyntaxEvidence(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.root / 'main.ts').write_text('const value = work();\n')

    def scan(self, files=('main.ts',), path=None):
        output = self.root / 'report/evidence.json'
        env = os.environ.copy()
        if path is not None:
            env['PATH'] = str(path)
        proc = subprocess.run(
            [bun, 'run', '--config=/dev/null', '--no-env-file', str(script),
             '--repo-root', str(self.root), '--output', str(output), *files],
            cwd=self.root, env=env, capture_output=True, text=True, timeout=45,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(output.read_text())
        self.assertEqual(proc.stdout, f"{result['status']}: {output}\n")
        return result

    def stub_ast_grep(self, status, stdout, stderr=''):
        stub = self.bin / 'ast-grep'
        stub.write_text(
            '#!/bin/sh\n'
            'while IFS= read -r line; do :; done\n'
            f'printf %s {shlex.quote(stdout)}\n'
            f'printf %s {shlex.quote(stderr)} >&2\n'
            f'exit {status}\n'
        )
        stub.chmod(0o755)

    def test_missing_tool_is_explicit(self):
        result = self.scan(path=self.bin)
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('PATH', result['reason'])
        self.assertEqual(result['nodes'], [])

    @unittest.skipUnless(os.environ.get('TYPESCRIPT_EVIDENCE_OLD_BUN'),
                         'set TYPESCRIPT_EVIDENCE_OLD_BUN to an unsupported Bun binary')
    def test_unsupported_bun_is_explicit_before_scanning(self):
        self.stub_ast_grep(0, '[]')
        output = self.root / 'unsupported.json'
        proc = subprocess.run(
            [os.environ['TYPESCRIPT_EVIDENCE_OLD_BUN'], 'run', '--config=/dev/null',
             '--no-env-file', str(script), '--repo-root', str(self.root),
             '--output', str(output), 'main.ts'],
            cwd=self.root, env={**os.environ, 'PATH': str(self.bin)},
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(output.read_text())
        self.assertEqual(result['status'], 'unavailable')
        self.assertIn('Bun 1.4.4 or newer is required', result['reason'])
        self.assertEqual(result['files'], [])
        self.assertEqual(result['nodes'], [])

    def test_no_matches_is_success_not_failure(self):
        self.stub_ast_grep(0, '[]')
        result = self.scan(path=self.bin)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['nodes'], [])
        self.assertIsNone(result['reason'])
        self.assertEqual(len(result['files'][0]['sha256']), 64)

    def test_nearest_parent_handles_equal_spans_siblings_and_files(self):
        source = 'x' * 100
        spans = [(0, 100), (0, 80), (0, 80), (5, 20), (20, 40), (25, 40), (80, 100)]
        matches = [{'ruleId': 'call_expression', 'text': source[lo:hi],
                    'range': {'byteOffset': {'start': lo, 'end': hi}}} for lo, hi in spans]
        for name in ['main.ts', 'second.ts']:
            (self.root / name).write_text(source)
        self.stub_ast_grep(0, json.dumps(matches))
        result = self.scan(['second.ts', 'main.ts'], path=self.bin)
        self.assertEqual(result['status'], 'ok', result['reason'])
        self.assertEqual([n['parent'] for n in result['nodes']],
                         [None, 0, 0, 1, 1, 4, 0, None, 7, 7, 8, 8, 11, 7])

    def test_command_and_json_failures_are_recorded(self):
        for status, stdout, stderr, reason in [
            (2, '', 'bad rules', 'bad rules'),
            (0, 'invalid JSON', '', 'SyntaxError'),
            (0, '{}', '', 'non-array result'),
        ]:
            with self.subTest(stdout=stdout, status=status):
                self.stub_ast_grep(status, stdout, stderr)
                result = self.scan(path=self.bin)
                self.assertEqual(result['status'], 'failed')
                self.assertIn(reason, result['reason'])
                self.assertEqual(result['nodes'], [])

    def test_timeout_is_recorded_as_a_failed_scan(self):
        sleep = shutil.which('sleep')
        self.assertIsNotNone(sleep)
        stub = self.bin / 'ast-grep'
        stub.write_text(f'#!/bin/sh\nexec {shlex.quote(sleep)} 40\n')
        stub.chmod(0o755)

        result = self.scan(path=self.bin)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('exceeded 30 seconds', result['reason'])
        self.assertEqual(result['nodes'], [])

    def test_mismatched_source_and_parser_error_are_rejected(self):
        for match, reason in [
            ({'ruleId': 'ERROR'}, 'syntax error (ERROR)'),
            ({'ruleId': 'call_expression', 'text': 'other()',
              'range': {'byteOffset': {'start': 14, 'end': 20}}}, 'text does not match'),
            ({'ruleId': 'call_expression', 'text': 'work()',
              'range': {'byteOffset': {'start': -1, 'end': 100}}}, 'invalid source range'),
        ]:
            with self.subTest(match=match):
                self.stub_ast_grep(0, json.dumps([match]))
                result = self.scan(path=self.bin)
                self.assertEqual(result['status'], 'failed')
                self.assertIn(reason, result['reason'])
                self.assertEqual(result['nodes'], [])

    def test_directories_outside_root_and_other_languages_are_not_scanned(self):
        (self.root / 'other.rs').write_text('fn main() {}')
        self.stub_ast_grep(0, '[]')
        self.assertEqual(self.scan(path=self.bin)['status'], 'ok')
        nested = self.root / 'nested'
        (nested / 'directory').mkdir(parents=True)
        (nested / 'entry.ts').write_text('work();\n')
        (self.root / 'directory-link').symlink_to(nested / 'directory')
        for shadow in (False, True):
            with self.subTest(root_entry_exists=shadow):
                if shadow:
                    (self.root / 'entry.ts').write_text('wrong();\n')
                result = self.scan(['directory-link/../entry.ts'], path=self.bin)
                self.assertEqual(result['status'], 'ok')
                self.assertEqual(result['files'][0]['path'], 'nested/entry.ts')

        for name, reason in [('.', 'Expected a .ts or .tsx file'),
                             ('other.rs', 'Expected a .ts or .tsx file'), ('missing.ts', 'ENOENT')]:
            with self.subTest(name=name):
                result = self.scan([name], path=self.bin)
                self.assertEqual(result['status'], 'failed')
                self.assertIn(reason, result['reason'])

        with tempfile.TemporaryDirectory() as outside:
            source = Path(outside) / 'outside.ts'
            source.write_text('const outside = work();\n')
            (self.root / 'linked.ts').symlink_to(source)
            result = self.scan(['linked.ts'], path=self.bin)
            self.assertEqual(result['status'], 'failed')
            self.assertIn('outside the repository root', result['reason'])
            self.assertEqual(result['files'], [])

    @unittest.skipUnless(shutil.which('ast-grep'), 'native ast-grep is not installed')
    def test_native_ts_tsx_unicode_and_source_containment(self):
        (self.root / 'main.ts').write_text('''class Label { catchTag() { return "plain"; } }
export const run = () => { const 日本語 = new Label().catchTag(); return Fx.catchTag(load(日本語), "Missing", () => backup()); };
''' + f'longCall("{"🦊" * 200}");\n', encoding='utf-8')
        (self.root / 'view.tsx').write_text('export const View = () => <p>{run()}</p>;\n')
        (self.root / 'unselected.ts').write_text('unexpected();')
        (self.root / 'sgconfig.yml').write_text('invalid: [')
        result = self.scan(['main.ts', 'view.tsx'])
        self.assertEqual(result['status'], 'ok', result['reason'])
        self.assertEqual(result['capabilities'], 'syntax-only')
        self.assertEqual({n['path'] for n in result['nodes']}, {'main.ts', 'view.tsx'})
        self.assertTrue(any(n['text'] == 'run()' for n in result['nodes']))
        self.assertTrue(any(n['text'] == 'new Label().catchTag()' for n in result['nodes']))
        long_call = next(n for n in result['nodes'] if n['text'].startswith('longCall('))
        self.assertTrue(long_call['text_truncated'])
        for node in result['nodes']:
            raw = (self.root / node['path']).read_bytes()
            self.assertEqual(raw[node['byte_start']:node['byte_end']].decode()[:180], node['text'])
            self.assertLessEqual(node['end'], len(raw.splitlines()))
            self.assertNotIn('type', node)
            if node['parent'] is not None:
                parent = result['nodes'][node['parent']]
                self.assertEqual(parent['path'], node['path'])
                self.assertLessEqual(parent['byte_start'], node['byte_start'])
                self.assertGreaterEqual(parent['byte_end'], node['byte_end'])

    @unittest.skipUnless(shutil.which('ast-grep'), 'native ast-grep is not installed')
    def test_native_parse_failure_discards_partial_batch(self):
        (self.root / 'broken.tsx').write_text('const x = <p>{broken(</p>')
        result = self.scan(['main.ts', 'broken.tsx'])
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['nodes'], [])

    @unittest.skipUnless(shutil.which('ast-grep'), 'native ast-grep is not installed')
    def test_native_missing_tokens_discard_partial_batch(self):
        for extension in ['ts', 'tsx']:
            for contents in ['const a = (1;', 'function f() { return 1;', 'foo(']:
                with self.subTest(extension=extension, contents=contents):
                    name = f'broken.{extension}'
                    (self.root / name).write_text(contents)
                    result = self.scan(['main.ts', name])
                    self.assertEqual(result['status'], 'failed', result)
                    self.assertIn(name, result['reason'])
                    self.assertEqual(result['nodes'], [])

    @unittest.skipUnless(shutil.which('ast-grep'), 'native ast-grep is not installed')
    def test_native_valid_empty_syntax_is_not_a_missing_token(self):
        for contents in ['', '// comment\n', 'const a = ""; const b = ``; const c = [];',
                         'function f() {}', 'const View = () => <><p />{null}</>;']:
            with self.subTest(contents=contents):
                (self.root / 'valid.tsx').write_text(contents)
                result = self.scan(['valid.tsx'])
                self.assertEqual(result['status'], 'ok', result['reason'])

    @unittest.skipUnless(shutil.which('ast-grep'), 'native ast-grep is not installed')
    def test_effect_checkout_fixture_reports_recovery_and_error_mapping_evidence(self):
        fixture = script.parent.parent / 'tests' / 'fixtures' / 'effect-checkout.ts.fixture'
        (self.root / 'checkout.ts').write_text(fixture.read_text())
        result = self.scan(['checkout.ts'])
        self.assertEqual(result['status'], 'ok', result['reason'])
        calls = {n['text'] for n in result['nodes'] if n['kind'] == 'call_expression'}
        self.assertTrue(any('catchTag("OutOfStock"' in text for text in calls))
        self.assertTrue(any(text.startswith('Effect.mapError(') for text in calls))
        self.assertTrue(any(text == 'reserve(id)' for text in calls))
        self.assertTrue(any(text == 'charge(reserved)' for text in calls))

    def test_target_bun_config_cannot_preload_target_code(self):
        (self.root / 'bunfig.toml').write_text('preload = ["./preload.ts"]\n')
        (self.root / 'preload.ts').write_text('throw new Error("unexpected preload");\n')
        self.stub_ast_grep(0, '[]')
        self.assertEqual(self.scan(path=self.bin)['status'], 'ok')


if __name__ == '__main__':
    unittest.main()

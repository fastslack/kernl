#!/usr/bin/env python3
"""Exercise rebuild's Compose selection without touching Docker."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class RebuildComposeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copy(Path(__file__).resolve().parents[1] / 'rebuild.sh', self.root)
        for name in ('docker-compose.yml', 'host overlay.yml', 'explicit.yml'):
            (self.root / name).touch()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        docker = self.bin / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CALLS'], 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'inspect':
    if 'LABEL' not in os.environ:
        sys.exit(1)
    print(os.environ['LABEL'])
''')
        docker.chmod(0o755)
        curl = self.bin / 'curl'
        curl.write_text('#!/bin/sh\nprintf 200\n')
        curl.chmod(0o755)
        self.env = {k: v for k, v in os.environ.items()
                    if k not in ('COMPOSE_FILE', 'COMPOSE_PATH_SEPARATOR', 'LABEL')}
        self.env.update(PATH=str(self.bin) + os.pathsep + self.env['PATH'],
                        CALLS=str(self.root / 'calls'))

    def run_rebuild(self, **env):
        result = subprocess.run(['bash', str(self.root / 'rebuild.sh'), 'kernel', '--logs'],
                                env=self.env | env, capture_output=True, text=True)
        calls = [json.loads(line) for line in (self.root / 'calls').read_text().splitlines()]
        return result, calls

    def assert_compose_commands(self, calls, files):
        prefix = ['compose']
        for file in files:
            prefix += ['-f', file]
        for suffix in (['build', 'kernel'], ['up', '-d', 'kernel'], ['logs', '-f', 'kernel']):
            self.assertIn(prefix + suffix, calls)

    def test_existing_stack_preserves_host_overlay(self):
        files = [str(self.root / 'docker-compose.yml'), str(self.root / 'host overlay.yml')]
        result, calls = self.run_rebuild(LABEL=','.join(files))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_compose_commands(calls, files)

    def test_fresh_stack_uses_base(self):
        result, calls = self.run_rebuild()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_compose_commands(calls, ['docker-compose.yml'])

    def test_explicit_configuration_wins(self):
        result, calls = self.run_rebuild(COMPOSE_FILE='docker-compose.yml:explicit.yml', LABEL='missing.yml')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[0] == 'inspect' for call in calls))
        self.assert_compose_commands(calls, ['docker-compose.yml', 'explicit.yml'])

    def test_missing_overlay_stops_before_build(self):
        result, calls = self.run_rebuild(LABEL='docker-compose.yml,missing.yml')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('missing.yml', result.stderr)
        self.assertFalse(any('build' in call or 'up' in call for call in calls))

    def test_existing_stack_without_label_requires_explicit_config(self):
        result, calls = self.run_rebuild(LABEL='<no value>')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('COMPOSE_FILE', result.stderr)
        self.assertFalse(any('build' in call or 'up' in call for call in calls))

    def test_explicit_custom_separator(self):
        result, calls = self.run_rebuild(COMPOSE_FILE='docker-compose.yml|host overlay.yml',
                                         COMPOSE_PATH_SEPARATOR='|')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_compose_commands(calls, ['docker-compose.yml', 'host overlay.yml'])

    def test_label_is_literal_not_shell_code(self):
        file = self.root / '$(touch SENTINEL).yml'
        file.touch()
        result, calls = self.run_rebuild(LABEL=str(file))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_compose_commands(calls, [str(file)])
        self.assertFalse((self.root / 'SENTINEL').exists())


if __name__ == '__main__':
    unittest.main()

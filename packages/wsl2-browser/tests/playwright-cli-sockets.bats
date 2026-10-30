#!/usr/bin/env bats

@test "Playwright long socket paths preserve isolation, private permissions and cross-process IPC" {
  run node --input-type=commonjs - "$BATS_TEST_DIRNAME/../libexec/playwright-cli-sockets.cjs" "$BATS_TEST_TMPDIR" <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { shortSocketPath } = require(process.argv[2]);
const parent = process.argv[3];
delete process.env.PWTEST_SOCKETS_DIR;
(async () => {
  const directory = parent + '/長い一時パス'.repeat(20);
  const address = shortSocketPath(directory, 'session');
  assert.ok(Buffer.byteLength(address) <= 103);
  assert.equal(shortSocketPath(directory, 'session'), address);
  assert.notEqual(shortSocketPath(directory + '/other', 'session'), address);
  assert.notEqual(shortSocketPath(directory, 'another-session'), address);
  const stat = fs.lstatSync(require('node:path').dirname(address));
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(stat.uid, process.getuid());
  assert.ok(stat.isDirectory());
  const server = net.createServer(socket => socket.end('socket-ok'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
  try {
    await new Promise((resolve, reject) => {
      const client = spawn(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const socket = require('node:net').connect(process.argv[1]);
        socket.setTimeout(3000, () => process.exit(2));
        let data = '';
        socket.on('data', chunk => data += chunk);
        socket.on('end', () => assert.equal(data, 'socket-ok'));
      `, address], { stdio: 'inherit' });
      client.once('error', reject);
      client.once('exit', code => code === 0 ? resolve() : reject(new Error(`client exit ${code}`)));
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(fs.existsSync(address), false);
  process.env.PWTEST_SOCKETS_DIR = directory;
  assert.throws(() => shortSocketPath(directory, 'session'), /PWTEST_SOCKETS_DIR is too long/);
})().catch(error => { console.error(error); process.exitCode = 1; });
JS
  [ "$status" -eq 0 ] || printf '%s\n' "$output" >&3
  [ "$status" -eq 0 ]
}

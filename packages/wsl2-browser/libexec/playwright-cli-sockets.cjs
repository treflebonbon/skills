const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

module.exports.shortSocketPath = (directory, name) => {
  if (process.env.PWTEST_SOCKETS_DIR) {
    throw new Error(
      "PWTEST_SOCKETS_DIR is too long; choose a shorter socket directory."
    );
  }
  // Keep socket addresses bounded without moving profiles, logs or other TMPDIR data.
  const root = `/tmp/pwcli-${process.getuid()}`;
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  const stat = fs.lstatSync(root);
  // eslint-disable-next-line no-bitwise -- Extract POSIX permissions from the file mode.
  const permissions = stat.mode & 0o777;
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    permissions !== 0o700
  ) {
    throw new Error(`Unsafe Playwright socket directory: ${root}`);
  }
  const key = crypto
    .createHash("sha256")
    .update(directory)
    .update("\0")
    .update(name)
    .digest("hex");
  return path.join(root, `${key.slice(0, 32)}.sock`);
};

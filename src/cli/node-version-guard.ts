/**
 * Node version guard. Runs at import time ... this module MUST be imported
 * before any module that pulls in a native addon (notably `better-sqlite3`
 * via the Supervisor), because ESM evaluates imported modules before the
 * importing module's body. On Node < 22 the native addon fails to load with a
 * raw `ERR_DLOPEN_FAILED` the moment it's required, which is an ugly, opaque
 * dead-end for a user who installed via `npm i -g` (the `install.sh` path
 * preflights the version, but the bare npm path doesn't). Catch it here with a
 * clear, actionable message and a clean exit instead.
 */
const MIN_MAJOR = 22
const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
if (Number.isFinite(major) && major < MIN_MAJOR) {
  process.stderr.write(
    `\n2200 requires Node.js ${String(MIN_MAJOR)} or newer, but this is Node ${process.versions.node}.\n` +
      `Its native modules (better-sqlite3) cannot load on an older Node.\n` +
      `Upgrade Node ... e.g. \`nvm install ${String(MIN_MAJOR)}\` or download from https://nodejs.org ... then re-run 2200.\n\n`,
  )
  process.exit(1)
}

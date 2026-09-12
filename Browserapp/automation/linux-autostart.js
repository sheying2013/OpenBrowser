'use strict';

/**
 * XDG autostart entries for Linux desktops.
 *
 * The desktop login-item API is not implemented on Linux, so "start when I
 * log in" has to be expressed the way the desktop environment reads it: a
 * Desktop Entry under `$XDG_CONFIG_HOME/autostart` (default `~/.config`).
 *
 * Two details make this more than writing a file:
 *
 *   - `Exec` must name something that still exists in the next session. A
 *     self-mounting bundle unpacks to a throwaway directory, so the launcher
 *     has to be the bundle path from `$APPIMAGE`, not `process.execPath`.
 *     A packaged install is usually reached through `/usr/bin`, so the real
 *     path behind the symlink is resolved first.
 *   - `Exec` is not a shell command line. It has its own quoting rules:
 *     arguments are wrapped in double quotes and only `"`, backtick, `$` and
 *     `\` are escaped inside them. Passing a shell-escaped string here is a
 *     common way to produce an entry that never launches.
 *
 * Every path is injectable so the module can be exercised without touching a
 * real home directory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_ENTRY_NAME = 'openbrowser.desktop';

/** Characters after which an argument has to be quoted, per the Desktop Entry spec. */
const RESERVED = /[\s"'\\><~|&;$*?#()`]/;

/**
 * Escape one `Exec` argument.
 *
 * The value is wrapped in double quotes and the four characters that remain
 * special inside a quoted argument are escaped. Unquoted arguments pass
 * through unchanged, which keeps a simple `--flag=value` readable.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeExecArgument(value) {
  const arg = String(value == null ? '' : value);
  // An empty argument becomes an explicit `""` rather than disappearing: a
  // caller that passed one meant to pass one.
  if (arg === '') return '""';
  if (!RESERVED.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

/**
 * Quote an executable path for an `Exec` line.
 *
 * A path that needs no quoting is left bare so the entry stays readable.
 *
 * @param {string} execPath
 * @returns {string}
 */
function quoteExecPath(execPath) {
  return escapeExecArgument(execPath);
}

/**
 * Pick the binary an autostart entry should launch.
 *
 * @param {{env?:object, execPath?:string, realpath?:Function}} [options]
 * @returns {string}
 */
function resolveLaunchBinary(options = {}) {
  const env = options.env || process.env;
  const execPath = options.execPath || process.execPath;
  const bundle = typeof env.APPIMAGE === 'string' ? env.APPIMAGE.trim() : '';
  if (bundle) return bundle;

  const realpath = typeof options.realpath === 'function' ? options.realpath : fs.realpathSync;
  try {
    return realpath(execPath);
  } catch (_) {
    // A missing or unreadable path is better reported as-is than replaced.
    return execPath;
  }
}

/**
 * Assemble the `Exec=` value from a binary and its arguments.
 *
 * @param {string} binary
 * @param {string[]} [args]
 * @returns {string}
 */
function buildExecLine(binary, args = []) {
  const parts = [quoteExecPath(binary)];
  for (const arg of args) parts.push(escapeExecArgument(arg));
  return parts.join(' ');
}

/**
 * Directory holding the autostart entries.
 *
 * @param {{env?:object, home?:string}} [options]
 */
function autostartDirectory(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  return path.join(xdg || path.join(home, '.config'), 'autostart');
}

/**
 * Full path of the desktop entry this module manages.
 *
 * @param {{env?:object, home?:string, entryName?:string}} [options]
 */
function autostartEntryPath(options = {}) {
  const name = options.entryName || DEFAULT_ENTRY_NAME;
  return path.join(autostartDirectory(options), name);
}

/**
 * Render a Desktop Entry.
 *
 * @param {{name:string, exec:string, icon?:string, comment?:string,
 *          startupWMClass?:string, terminal?:boolean, categories?:string[],
 *          noDisplay?:boolean}} options
 * @returns {string}
 */
function buildDesktopEntry(options = {}) {
  const name = String(options.name || '').trim();
  const exec = String(options.exec || '').trim();
  if (!name) throw new Error('desktop entry requires a name');
  if (!exec) throw new Error('desktop entry requires an exec line');

  const categories = Array.isArray(options.categories) && options.categories.length
    ? options.categories.join(';') + ';'
    : 'Network;';

  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${name}`,
  ];
  if (options.comment) lines.push(`Comment=${String(options.comment)}`);
  lines.push(`Exec=${exec}`);
  if (options.icon) lines.push(`Icon=${String(options.icon)}`);
  // NoDisplay keeps an entry out of menus while still letting the shell match
  // a window to it, which is how a bundled launch gets its proper icon.
  if (options.noDisplay) lines.push('NoDisplay=true');
  lines.push(
    `Terminal=${options.terminal ? 'true' : 'false'}`,
    `Categories=${categories}`,
    'StartupNotify=false',
  );
  if (options.startupWMClass) lines.push(`StartupWMClass=${String(options.startupWMClass)}`);
  lines.push('X-GNOME-Autostart-enabled=true', '');
  return lines.join('\n');
}

/**
 * Read back the `Exec` value from a rendered entry.
 *
 * @param {string} text
 * @returns {string|null}
 */
function parseDesktopEntryExec(text) {
  if (typeof text !== 'string') return null;
  const match = /^Exec=(.*)$/m.exec(text);
  return match ? match[1].trim() : null;
}

/** Read a rendered entry back into an object. Empty lines and comments are skipped. */
function parseDesktopEntry(text) {
  if (typeof text !== 'string') return null;
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * Enable or disable launching at login.
 *
 * Disabling removes the entry; a missing entry is not an error, since the
 * desired state is already in effect.
 *
 * @param {boolean} enabled
 * @param {{name:string, args?:string[], icon?:string, comment?:string,
 *          startupWMClass?:string, env?:object, home?:string, execPath?:string,
 *          entryName?:string, realpath?:Function, fsModule?:object}} [options]
 * @returns {{enabled:boolean, path:string|null, exec:string|null}}
 */
function setLinuxAutostart(enabled, options = {}) {
  const io = options.fsModule || fs;
  const entryPath = autostartEntryPath(options);

  if (!enabled) {
    try {
      io.unlinkSync(entryPath);
    } catch (err) {
      const code = err && err.code;
      if (code !== 'ENOENT') throw err;
    }
    return { enabled: false, path: null, exec: null };
  }

  const binary = resolveLaunchBinary(options);
  const exec = buildExecLine(binary, options.args || []);
  const contents = buildDesktopEntry({
    name: options.name || 'OpenBrowser',
    exec,
    icon: options.icon,
    comment: options.comment,
    startupWMClass: options.startupWMClass,
  });

  io.mkdirSync(autostartDirectory(options), { recursive: true });
  io.writeFileSync(entryPath, contents, { encoding: 'utf8', mode: 0o644 });
  return { enabled: true, path: entryPath, exec };
}

/**
 * Report whether an entry is installed, and what it would launch.
 *
 * @returns {{enabled:boolean, path:string, exec:string|null, entry:object|null}}
 */
function getLinuxAutostartState(options = {}) {
  const io = options.fsModule || fs;
  const entryPath = autostartEntryPath(options);
  let text;
  try {
    text = io.readFileSync(entryPath, 'utf8');
  } catch (_) {
    return { enabled: false, path: entryPath, exec: null, entry: null };
  }
  return {
    enabled: true,
    path: entryPath,
    exec: parseDesktopEntryExec(text),
    entry: parseDesktopEntry(text),
  };
}

module.exports = {
  escapeExecArgument,
  quoteExecPath,
  resolveLaunchBinary,
  buildExecLine,
  buildDesktopEntry,
  parseDesktopEntry,
  parseDesktopEntryExec,
  autostartDirectory,
  autostartEntryPath,
  setLinuxAutostart,
  getLinuxAutostartState,
  DEFAULT_ENTRY_NAME,
  RESERVED,
};

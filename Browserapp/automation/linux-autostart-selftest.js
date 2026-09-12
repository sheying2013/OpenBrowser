'use strict';

/**
 * Self-test for XDG autostart entry management.
 * File-system calls go through an in-memory double so no real home directory
 * is touched.
 */

const assert = require('assert');
const path = require('path');
const a = require('./linux-autostart');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

/** Minimal in-memory stand-in for the fs surface this module uses. */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  return {
    files,
    dirs,
    writeFileSync(p, data, opts) { files.set(p, String(data)); this.lastMode = opts && opts.mode; },
    readFileSync(p) {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    unlinkSync(p) {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      files.delete(p);
    },
    mkdirSync(p) { dirs.add(p); },
  };
}

// ---- argument escaping ----

check('plain arguments are emitted verbatim', () => {
  assert.strictEqual(a.escapeExecArgument('--no-sandbox'), '--no-sandbox');
  assert.strictEqual(a.escapeExecArgument('--flag=value'), '--flag=value');
  assert.strictEqual(a.escapeExecArgument('/usr/bin/openbrowser'), '/usr/bin/openbrowser');
});

check('arguments with spaces are quoted, not backslash-escaped', () => {
  assert.strictEqual(a.escapeExecArgument('--flag=a b'), '"--flag=a b"');
  assert.strictEqual(a.escapeExecArgument('a\tb'), '"a\tb"');
});

check('only the four characters special inside a quoted argument are escaped', () => {
  assert.strictEqual(a.escapeExecArgument('say "hi"'), '"say \\"hi\\""');
  assert.strictEqual(a.escapeExecArgument('cost is $5'), '"cost is $5"'.replace('$', '\\$'));
  assert.strictEqual(a.escapeExecArgument('back`tick'), '"back\\`tick"');
  assert.strictEqual(a.escapeExecArgument('back\\slash'), '"back\\\\slash"');
});

check('arguments carrying shell punctuation are quoted so they stay literal', () => {
  for (const raw of ['a;rm -rf /', 'a&&b', 'a|b', 'a>b', 'a<b', 'a&b', 'glob*', 'quest?']) {
    const escaped = a.escapeExecArgument(raw);
    assert.ok(escaped.startsWith('"') && escaped.endsWith('"'), `${raw} should be quoted`);
    assert.ok(!escaped.includes('\\;'), 'a semicolon must not become an escape sequence');
  }
});

check('an empty argument is quoted so it survives as an argument', () => {
  assert.strictEqual(a.escapeExecArgument(''), '""');
  assert.strictEqual(a.escapeExecArgument(null), '""');
  assert.strictEqual(a.escapeExecArgument(undefined), '""');
});

check('quoteExecPath quotes only when the path needs it', () => {
  assert.strictEqual(a.quoteExecPath('/usr/bin/openbrowser'), '/usr/bin/openbrowser');
  assert.strictEqual(a.quoteExecPath('/opt/My App/openbrowser'), '"/opt/My App/openbrowser"');
});

check('buildExecLine joins a quoted binary with its escaped arguments', () => {
  assert.strictEqual(a.buildExecLine('/usr/bin/app', []), '/usr/bin/app');
  assert.strictEqual(
    a.buildExecLine('/opt/My App/app', ['--no-sandbox', '--flag=a b']),
    '"/opt/My App/app" --no-sandbox "--flag=a b"',
  );
});

// ---- launch binary resolution ----

check('a bundled image path wins over the running executable', () => {
  const resolved = a.resolveLaunchBinary({
    env: { APPIMAGE: '/home/u/Apps/OpenBrowser.AppImage' },
    execPath: '/tmp/.mount_abc/openbrowser',
  });
  assert.strictEqual(resolved, '/home/u/Apps/OpenBrowser.AppImage');
});

check('the running executable is resolved through symlinks', () => {
  const resolved = a.resolveLaunchBinary({
    env: {},
    execPath: '/usr/bin/openbrowser',
    realpath: () => '/opt/openbrowser/openbrowser',
  });
  assert.strictEqual(resolved, '/opt/openbrowser/openbrowser');
});

check('an unresolvable executable is reported as-is rather than dropped', () => {
  const resolved = a.resolveLaunchBinary({
    env: {},
    execPath: '/gone/openbrowser',
    realpath: () => { throw new Error('ENOENT'); },
  });
  assert.strictEqual(resolved, '/gone/openbrowser');
});

// ---- paths ----

check('the autostart directory follows XDG_CONFIG_HOME', () => {
  assert.strictEqual(
    a.autostartDirectory({ env: { XDG_CONFIG_HOME: '/custom/cfg' }, home: '/home/u' }),
    path.join('/custom/cfg', 'autostart'),
  );
});

check('the autostart directory falls back to ~/.config', () => {
  assert.strictEqual(
    a.autostartDirectory({ env: {}, home: '/home/u' }),
    path.join('/home/u', '.config', 'autostart'),
  );
  assert.strictEqual(
    a.autostartDirectory({ env: { XDG_CONFIG_HOME: '   ' }, home: '/home/u' }),
    path.join('/home/u', '.config', 'autostart'),
  );
});

check('the entry path uses the configured file name', () => {
  const p = a.autostartEntryPath({ env: {}, home: '/home/u', entryName: 'custom.desktop' });
  assert.strictEqual(p, path.join('/home/u', '.config', 'autostart', 'custom.desktop'));
  assert.ok(a.autostartEntryPath({ env: {}, home: '/home/u' }).endsWith('.desktop'));
});

// ---- entry rendering ----

check('a rendered entry carries the fields a desktop reads', () => {
  const text = a.buildDesktopEntry({ name: 'OpenBrowser', exec: '/usr/bin/openbrowser' });
  assert.ok(text.startsWith('[Desktop Entry]\n'));
  assert.ok(text.includes('\nType=Application\n'));
  assert.ok(text.includes('\nName=OpenBrowser\n'));
  assert.ok(text.includes('\nExec=/usr/bin/openbrowser\n'));
  assert.ok(text.includes('\nTerminal=false\n'));
  assert.ok(text.includes('\nX-GNOME-Autostart-enabled=true\n'));
  assert.ok(text.endsWith('\n'), 'the file ends with a newline');
});

check('optional fields appear only when supplied', () => {
  const bare = a.buildDesktopEntry({ name: 'A', exec: '/a' });
  assert.ok(!bare.includes('Icon='));
  assert.ok(!bare.includes('Comment='));
  assert.ok(!bare.includes('StartupWMClass='));

  const full = a.buildDesktopEntry({
    name: 'A', exec: '/a', icon: 'openbrowser', comment: 'Browser', startupWMClass: 'OpenBrowser',
  });
  assert.ok(full.includes('\nIcon=openbrowser\n'));
  assert.ok(full.includes('\nComment=Browser\n'));
  assert.ok(full.includes('\nStartupWMClass=OpenBrowser\n'));
});

check('a name or exec line is required', () => {
  assert.throws(() => a.buildDesktopEntry({ exec: '/a' }), /requires a name/);
  assert.throws(() => a.buildDesktopEntry({ name: 'A' }), /requires an exec line/);
});

check('categories are terminated as the spec requires', () => {
  assert.ok(a.buildDesktopEntry({ name: 'A', exec: '/a' }).includes('\nCategories=Network;\n'));
  assert.ok(
    a.buildDesktopEntry({ name: 'A', exec: '/a', categories: ['Network', 'Utility'] })
      .includes('\nCategories=Network;Utility;\n'),
  );
});

// ---- entry parsing ----

check('parseDesktopEntry reads key/value pairs and ignores noise', () => {
  const text = [
    '# a comment',
    '[Desktop Entry]',
    'Type=Application',
    'Name=OpenBrowser',
    '',
    'Exec=/usr/bin/openbrowser --no-sandbox',
    'Name=Ignored duplicate',
  ].join('\n');
  const parsed = a.parseDesktopEntry(text);
  assert.strictEqual(parsed.Type, 'Application');
  assert.strictEqual(parsed.Name, 'OpenBrowser', 'the first value wins');
  assert.strictEqual(parsed.Exec, '/usr/bin/openbrowser --no-sandbox');
  assert.strictEqual(parsed['[Desktop Entry]'], undefined, 'section headers are not values');
});

check('parseDesktopEntryExec extracts the exec line only', () => {
  const text = a.buildDesktopEntry({ name: 'A', exec: '"/opt/My App/a" --x' });
  assert.strictEqual(a.parseDesktopEntryExec(text), '"/opt/My App/a" --x');
  assert.strictEqual(a.parseDesktopEntryExec('Name=A'), null);
  assert.strictEqual(a.parseDesktopEntryExec(null), null);
});

check('a rendered entry round-trips through the parser', () => {
  const exec = a.buildExecLine('/opt/My App/openbrowser', ['--no-sandbox']);
  const text = a.buildDesktopEntry({ name: 'OpenBrowser', exec, icon: 'openbrowser' });
  assert.strictEqual(a.parseDesktopEntryExec(text), exec);
  assert.strictEqual(a.parseDesktopEntry(text).Icon, 'openbrowser');
});

// ---- install and remove ----

check('enabling writes an entry and resolving reports the path', () => {
  const io = memoryFs();
  const res = a.setLinuxAutostart(true, {
    name: 'OpenBrowser',
    execPath: '/usr/bin/openbrowser',
    env: {},
    home: '/home/u',
    fsModule: io,
    realpath: () => '/usr/bin/openbrowser',
  });
  assert.strictEqual(res.enabled, true);
  assert.strictEqual(res.path, path.join('/home/u', '.config', 'autostart', a.DEFAULT_ENTRY_NAME));
  assert.strictEqual(res.exec, '/usr/bin/openbrowser');
  assert.ok(io.files.has(res.path), 'the entry was written');
  assert.strictEqual(io.lastMode, 0o644, 'the entry is world-readable, as the desktop expects');
  assert.ok(io.dirs.has(path.join('/home/u', '.config', 'autostart')), 'the directory was created');
  assert.ok(io.files.get(res.path).includes('Exec=/usr/bin/openbrowser'));
});

check('disabling removes the entry', () => {
  const entryPath = path.join('/home/u', '.config', 'autostart', a.DEFAULT_ENTRY_NAME);
  const io = memoryFs({ [entryPath]: 'stale' });
  const res = a.setLinuxAutostart(false, { env: {}, home: '/home/u', fsModule: io });
  assert.strictEqual(res.enabled, false);
  assert.strictEqual(res.path, null);
  assert.ok(!io.files.has(entryPath), 'the entry is gone');
});

check('disabling an entry that was never written succeeds', () => {
  const io = memoryFs();
  const res = a.setLinuxAutostart(false, { env: {}, home: '/home/u', fsModule: io });
  assert.strictEqual(res.enabled, false);
});

check('an unrelated failure while disabling is surfaced', () => {
  const io = memoryFs({ '/home/u/.config/autostart/openbrowser.desktop': 'x' });
  io.unlinkSync = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  assert.throws(
    () => a.setLinuxAutostart(false, { env: {}, home: '/home/u', fsModule: io }),
    /EACCES/,
  );
});

check('state reports installed entries with their exec line', () => {
  const entryPath = path.join('/home/u', '.config', 'autostart', a.DEFAULT_ENTRY_NAME);
  const io = memoryFs({
    [entryPath]: a.buildDesktopEntry({ name: 'OpenBrowser', exec: '/usr/bin/openbrowser --x' }),
  });
  const state = a.getLinuxAutostartState({ env: {}, home: '/home/u', fsModule: io });
  assert.strictEqual(state.enabled, true);
  assert.strictEqual(state.exec, '/usr/bin/openbrowser --x');
  assert.strictEqual(state.entry.Name, 'OpenBrowser');
});

check('state reports absence without throwing', () => {
  const io = memoryFs();
  const state = a.getLinuxAutostartState({ env: {}, home: '/home/u', fsModule: io });
  assert.strictEqual(state.enabled, false);
  assert.strictEqual(state.exec, null);
  assert.strictEqual(state.entry, null);
  assert.ok(state.path.endsWith('.desktop'));
});

check('a bundled install records the bundle path, not the mount point', () => {
  const io = memoryFs();
  const res = a.setLinuxAutostart(true, {
    name: 'OpenBrowser',
    env: { APPIMAGE: '/home/u/Apps/OpenBrowser.AppImage' },
    execPath: '/tmp/.mount_XYZ/openbrowser',
    home: '/home/u',
    fsModule: io,
    args: ['--no-sandbox'],
  });
  assert.strictEqual(res.exec, '/home/u/Apps/OpenBrowser.AppImage --no-sandbox');
  assert.ok(!io.files.get(res.path).includes('.mount_'), 'the throwaway mount path must not be recorded');
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nLINUX_AUTOSTART_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;

'use strict';

/**
 * Native window control with graceful degradation.
 *
 * Window geometry and stacking are reachable three ways, in order of
 * preference:
 *
 *   Windows : user32 via an optional FFI binding
 *   Linux   : libX11 via an optional FFI binding, else the xdotool CLI
 *   macOS   : not handled here (CDP covers it)
 *
 * FFI bindings are loaded lazily and are not required: when they are absent
 * the controller falls back to command-line tooling, and when that is missing
 * too every call reports `false` instead of throwing. Callers can therefore
 * treat native control as best-effort.
 *
 * The CLI path is driven through an injectable `exec`, so behaviour can be
 * exercised without a display server.
 */

const { execSync, exec } = require('child_process');

const BACKENDS = {
  USER32: 'user32',
  X11: 'x11',
  XDOTOOL: 'xdotool',
  NONE: 'none',
};

/** ShowWindow() command values from the Win32 header. */
const SHOW = { SW_HIDE: 0, SW_RESTORE: 9 };

/** SetWindowPos flags: retain size/position where the caller does not change it. */
const SWP = {
  NOSIZE: 0x0001,
  NOMOVE: 0x0002,
  NOZORDER: 0x0004,
  NOACTIVATE: 0x0010,
};

function isValidHandle(handle) {
  const n = Number(handle);
  return Number.isFinite(n) && n > 0;
}

/** Parse `xdotool getwindowgeometry --shell` output into a rectangle. */
function parseXdotoolGeometry(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  const map = {};
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z]+)=(-?\d+)\s*$/.exec(line.trim());
    if (match) map[match[1]] = parseInt(match[2], 10);
  }
  if (!Number.isFinite(map.WIDTH) || !Number.isFinite(map.HEIGHT)) return null;
  return {
    x: Number.isFinite(map.X) ? map.X : 0,
    y: Number.isFinite(map.Y) ? map.Y : 0,
    width: map.WIDTH,
    height: map.HEIGHT,
  };
}

/** Attempt to load an FFI binding. Returns null when unavailable. */
function loadFfiBinding() {
  for (const name of ['koffi', '@lwahonen/ffi-napi']) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return { name, mod: require(name) };
    } catch (_) {
      /* binding not installed; try the next candidate */
    }
  }
  return null;
}

function createWindowController(options = {}) {
  const platform = options.platform || process.platform;
  const runSync = options.execSync || execSync;
  const runAsync = options.exec || exec;
  const loadFfi = options.loadFfi || loadFfiBinding;
  const commandTimeoutMs = Number(options.commandTimeoutMs) > 0 ? Number(options.commandTimeoutMs) : 4000;

  let backend = null;
  let ffiLib = null;
  let hasXdotool = false;
  let probed = false;

  function hasCommand(cmd) {
    try {
      runSync(`command -v ${cmd}`, { stdio: 'ignore', timeout: 3000, shell: '/bin/sh' });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Initialise the FFI binding for the active platform, if one is available. */
  function initFfi() {
    if (ffiLib) return ffiLib;
    const binding = loadFfi();
    if (!binding) return null;

    try {
      if (platform === 'win32') {
        const lib = binding.mod.Library ? binding.mod.Library : binding.mod.default;
        ffiLib = typeof lib === 'function' ? new lib('user32', {
          GetWindowRect: ['bool', ['intptr', 'pointer']],
          SetWindowPos: ['bool', ['intptr', 'intptr', 'int', 'int', 'int', 'int', 'uint']],
          ShowWindow: ['bool', ['intptr', 'int']],
          SetForegroundWindow: ['bool', ['intptr']],
        }) : null;
      } else if (platform === 'linux') {
        const lib = binding.mod.Library ? binding.mod.Library : binding.mod.default;
        ffiLib = typeof lib === 'function' ? new lib('X11', {
          XOpenDisplay: ['pointer', ['string']],
          XCloseDisplay: ['int', ['pointer']],
          XDefaultRootWindow: ['ulong', ['pointer']],
          XMoveResizeWindow: ['int', ['pointer', 'ulong', 'int', 'int', 'uint', 'uint']],
          XMapRaised: ['int', ['pointer', 'ulong']],
          XUnmapWindow: ['int', ['pointer', 'ulong']],
          XFlush: ['int', ['pointer']],
        }) : null;
      }
    } catch (_) {
      ffiLib = null;
    }
    return ffiLib;
  }

  /** Decide which mechanism to use; the result is cached. */
  function detectBackend() {
    if (probed) return backend;
    probed = true;

    if (platform === 'win32') {
      backend = initFfi() ? BACKENDS.USER32 : BACKENDS.NONE;
      return backend;
    }

    if (platform === 'linux') {
      hasXdotool = hasCommand('xdotool');
      if (initFfi()) {
        backend = BACKENDS.X11;
      } else if (hasXdotool) {
        backend = BACKENDS.XDOTOOL;
      } else {
        backend = BACKENDS.NONE;
      }
      return backend;
    }

    backend = BACKENDS.NONE;
    return backend;
  }

  function getBackend() {
    return detectBackend();
  }

  /** Force a backend (tests, or an explicit user preference). */
  function setBackend(next) {
    probed = true;
    backend = Object.values(BACKENDS).includes(next) ? next : BACKENDS.NONE;
    return backend;
  }

  // ---- Linux CLI path ----

  function xdotoolGeometry(handle) {
    if (!hasXdotool) return null;
    try {
      const stdout = runSync(`xdotool getwindowgeometry --shell ${Number(handle)}`, {
        encoding: 'utf8',
        timeout: commandTimeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return parseXdotoolGeometry(stdout);
    } catch (_) {
      return null;
    }
  }

  function xdotoolMoveResize(handle, rect, noMove) {
    return new Promise((resolve) => {
      const id = Number(handle);
      // Clearing the maximized state first makes the move/size stick on most WMs.
      try {
        runSync(`wmctrl -i -r ${id} -b remove,maximized_vert,maximized_horz`, {
          stdio: 'ignore',
          timeout: 3000,
        });
      } catch (_) {
        /* wmctrl absent or window not maximized */
      }

      const parts = [];
      if (!noMove) parts.push(`xdotool windowmove --sync ${id} ${Math.round(rect.x)} ${Math.round(rect.y)}`);
      parts.push(`xdotool windowsize --sync ${id} ${Math.max(1, Math.round(rect.width))} ${Math.max(1, Math.round(rect.height))}`);

      runAsync(parts.join(' && '), { shell: '/bin/sh', timeout: commandTimeoutMs * 2 }, (err) => {
        resolve(!err);
      });
    });
  }

  function xdotoolShow(handle, hide) {
    return new Promise((resolve) => {
      const id = Number(handle);
      const shellCmd = hide
        ? `xdotool windowunmap ${id} 2>/dev/null || true`
        : `xdotool windowmap ${id} 2>/dev/null; xdotool windowactivate ${id} 2>/dev/null || true`;
      runAsync(shellCmd, { shell: '/bin/sh', timeout: commandTimeoutMs * 2 }, () => resolve(true));
    });
  }

  // ---- public API ----

  /** Read the current outer rectangle. Returns null when unavailable. */
  function getGeometry(handle) {
    if (!isValidHandle(handle)) return null;
    const mode = detectBackend();

    if (mode === BACKENDS.X11 || mode === BACKENDS.USER32) {
      const lib = initFfi();
      if (lib) {
        try {
          if (mode === BACKENDS.USER32) {
            const rect = Buffer.alloc(16);
            const ok = lib.GetWindowRect(Number(handle), rect);
            if (ok) {
              return {
                x: rect.readInt32LE(0),
                y: rect.readInt32LE(4),
                width: rect.readInt32LE(8) - rect.readInt32LE(0),
                height: rect.readInt32LE(12) - rect.readInt32LE(4),
              };
            }
          }
        } catch (_) {
          /* fall through to the CLI path */
        }
      }
    }

    if (mode === BACKENDS.XDOTOOL || hasXdotool) {
      return xdotoolGeometry(handle);
    }
    return null;
  }

  const getGeometryAsync = async (handle) => getGeometry(handle);

  /**
   * Move and/or resize a window.
   * @param {number} handle
   * @param {{x?:number,y?:number,width?:number,height?:number}} rect
   * @param {{noMove?:boolean}} [opts]
   */
  async function moveResize(handle, rect, opts = {}) {
    if (!isValidHandle(handle)) return false;
    const mode = detectBackend();
    const noMove = Boolean(opts.noMove);
    const target = {
      x: Number(rect && rect.x) || 0,
      y: Number(rect && rect.y) || 0,
      width: Math.max(1, Math.round(Number(rect && rect.width) || 1)),
      height: Math.max(1, Math.round(Number(rect && rect.height) || 1)),
    };

    if (mode === BACKENDS.X11) {
      const lib = initFfi();
      if (lib) {
        try {
          const display = lib.XOpenDisplay(null);
          if (display) {
            // Preserve the existing origin when the caller only resizes.
            let x = Math.round(target.x);
            let y = Math.round(target.y);
            if (noMove) {
              const current = getGeometry(handle);
              if (!current) {
                lib.XCloseDisplay(display);
                return false;
              }
              x = current.x;
              y = current.y;
            }
            lib.XMoveResizeWindow(display, Number(handle), x, y, target.width, target.height);
            lib.XFlush(display);
            lib.XCloseDisplay(display);
            return true;
          }
        } catch (_) {
          /* fall back to the CLI path */
        }
      }
      if (hasXdotool) return xdotoolMoveResize(handle, Object.assign({}, target, {
        x: noMove ? (getGeometry(handle) || target).x : target.x,
        y: noMove ? (getGeometry(handle) || target).y : target.y,
      }), noMove);
      return false;
    }

    if (mode === BACKENDS.USER32) {
      const lib = initFfi();
      if (lib) {
        try {
          const flags = SWP.NOZORDER | SWP.NOACTIVATE
            | (noMove ? SWP.NOMOVE : 0);
          const x = noMove ? 0 : Math.round(target.x);
          const y = noMove ? 0 : Math.round(target.y);
          return Boolean(lib.SetWindowPos(Number(handle), 0, x, y, target.width, target.height, flags));
        } catch (_) {
          return false;
        }
      }
      return false;
    }

    if (mode === BACKENDS.XDOTOOL) {
      return xdotoolMoveResize(handle, target, noMove);
    }
    return false;
  }

  /** Show (and raise) or hide a window. */
  async function setVisible(handle, visible) {
    if (!isValidHandle(handle)) return false;
    const mode = detectBackend();
    const hide = !visible;

    if (mode === BACKENDS.USER32) {
      const lib = initFfi();
      if (lib) {
        try {
          const ok = lib.ShowWindow(Number(handle), hide ? SHOW.SW_HIDE : SHOW.SW_RESTORE);
          if (!hide) lib.SetForegroundWindow(Number(handle));
          return Boolean(ok) || true;
        } catch (_) {
          return false;
        }
      }
      return false;
    }

    if (mode === BACKENDS.X11) {
      const lib = initFfi();
      if (lib) {
        try {
          const display = lib.XOpenDisplay(null);
          if (display) {
            if (hide) lib.XUnmapWindow(display, Number(handle));
            else lib.XMapRaised(display, Number(handle));
            lib.XFlush(display);
            lib.XCloseDisplay(display);
            return true;
          }
        } catch (_) {
          /* fall back */
        }
      }
      if (hasXdotool) return xdotoolShow(handle, hide);
      return false;
    }

    if (mode === BACKENDS.XDOTOOL) return xdotoolShow(handle, hide);
    return false;
  }

  const showWindow = (handle) => setVisible(handle, true);
  const hideWindow = (handle) => setVisible(handle, false);

  /** Raise a window without changing its geometry. */
  async function bringToFront(handle) {
    if (!isValidHandle(handle)) return false;
    const mode = detectBackend();
    if (mode === BACKENDS.USER32) {
      const lib = initFfi();
      if (lib) {
        try {
          lib.ShowWindow(Number(handle), SHOW.SW_RESTORE);
          return Boolean(lib.SetForegroundWindow(Number(handle)));
        } catch (_) {
          return false;
        }
      }
      return false;
    }
    return setVisible(handle, true);
  }

  /** Human-readable capability report, useful for diagnostics. */
  function describe() {
    const mode = detectBackend();
    return {
      platform,
      backend: mode,
      ffiAvailable: Boolean(initFfi()),
      xdotoolAvailable: hasXdotool,
      canReadGeometry: mode !== BACKENDS.NONE,
      canMoveResize: mode !== BACKENDS.NONE,
      canSetVisibility: mode !== BACKENDS.NONE,
    };
  }

  return {
    BACKENDS,
    SHOW,
    SWP,
    getBackend,
    setBackend,
    describe,
    getGeometry,
    getGeometryAsync,
    moveResize,
    setVisible,
    showWindow,
    hideWindow,
    bringToFront,
  };
}

/** Shared controller for the current process. */
const nativeWindow = createWindowController();

module.exports = {
  createWindowController,
  nativeWindow,
  parseXdotoolGeometry,
  isValidHandle,
  BACKENDS,
  SHOW,
  SWP,
};

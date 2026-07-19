'use strict';

/**
 * Icon pipeline for OpenBrowser:
 * - App shortcuts / Dock (software): assets/logo-pixel.svg
 * - Browser env Dock / extension toolbar: assets/logo-native.svg + env number badge
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(APP_ROOT, 'assets');
const LOGO_PIXEL_SVG = path.join(ASSETS, 'logo-pixel.svg');
const LOGO_NATIVE_SVG = path.join(ASSETS, 'logo-native.svg');
const LOGO_PIXEL_PNG = path.join(ASSETS, 'logo-pixel.png');
const LOGO_NATIVE_PNG = path.join(ASSETS, 'logo-native.png');
const LOGO_PNG = path.join(ASSETS, 'logo.png');
const LOGO_ICNS = path.join(ASSETS, 'logo.icns');

function normalizeEnvNumber(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '1';
  const digits = raw.match(/\d+/);
  if (digits) {
    const n = Math.max(1, Math.min(999, Number(digits[0]) || 1));
    return String(n);
  }
  return raw.slice(0, 3) || '1';
}

/**
 * Exact vector redraw of logo-native.svg (browser chrome icon) via Pillow.
 * Avoids qlmanage padding which leaves a tiny glyph on a huge transparent canvas.
 */
function renderNativeLogoPil(size, outPng) {
  const script = `
import sys
from pathlib import Path
from PIL import Image, ImageDraw
size, out = int(sys.argv[1]), sys.argv[2]
img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
s = size / 128.0
def sc(v): return v * s
def box(x,y,w,h): return [sc(x), sc(y), sc(x+w), sc(y+h)]
rr = max(1, int(sc(28)))
# rounded blue plate
d.rounded_rectangle([0, 0, size-1, size-1], radius=rr, fill=(0, 122, 255, 255))
# window body
d.rounded_rectangle(box(22, 28, 84, 72), radius=max(1, int(sc(12))), fill=(255, 255, 255, 245))
# title bar
d.rounded_rectangle(box(22, 28, 84, 18), radius=max(1, int(sc(12))), fill=(232, 232, 237, 255))
d.rectangle(box(22, 38, 84, 8), fill=(232, 232, 237, 255))
# traffic lights
for cx, col in ((34, (255, 95, 87, 255)), (45, (254, 188, 46, 255)), (56, (40, 200, 64, 255))):
  r = max(1, sc(3.2))
  d.ellipse([sc(cx)-r, sc(37)-r, sc(cx)+r, sc(37)+r], fill=col)
# content lines
d.rounded_rectangle(box(34, 56, 40, 6), radius=max(1, int(sc(3))), fill=(0, 122, 255, 230))
d.rounded_rectangle(box(34, 68, 56, 5), radius=max(1, int(sc(2.5))), fill=(199, 199, 204, 255))
d.rounded_rectangle(box(34, 78, 48, 5), radius=max(1, int(sc(2.5))), fill=(199, 199, 204, 255))
d.rounded_rectangle(box(34, 88, 28, 5), radius=max(1, int(sc(2.5))), fill=(199, 199, 204, 255))
Path(out).parent.mkdir(parents=True, exist_ok=True)
img.save(out, format="PNG")
print("OK")
`;
  const result = spawnSync('python3', ['-c', script, String(size), outPng], {
    encoding: 'utf8',
    timeout: 20000,
  });
  return result.status === 0 && fs.existsSync(outPng) && fs.statSync(outPng).size > 64;
}

/**
 * Exact redraw of logo-pixel.svg (software brand) via Pillow nearest-neighbor upscale.
 */
function renderPixelLogoPil(size, outPng) {
  const script = `
import sys
from pathlib import Path
from PIL import Image, ImageDraw
size, out = int(sys.argv[1]), sys.argv[2]
# draw at 64×64 then scale NEAREST to keep pixel look
base = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
d = ImageDraw.Draw(base)
def rect(x,y,w,h,c):
  d.rectangle([x, y, x+w-1, y+h-1], fill=c)
rect(0,0,64,64,(17,24,32,255))
rect(4,4,56,56,(5,9,13,255))
rect(8,8,48,44,(232,241,232,255))
rect(12,12,40,32,(12,28,36,255))
rect(12,12,40,6,(25,201,212,255))
rect(16,14,2,2,(240,79,79,255))
rect(20,14,2,2,(246,196,83,255))
rect(24,14,2,2,(80,232,120,255))
rect(16,22,20,3,(232,241,232,255))
rect(16,28,12,3,(80,232,120,255))
rect(16,34,8,3,(246,196,83,255))
rect(40,24,4,4,(25,201,212,255))
rect(44,30,4,4,(80,232,120,255))
rect(36,34,4,4,(246,196,83,255))
rect(38,27,2,9,(112,129,138,255))
rect(40,32,6,2,(112,129,138,255))
rect(26,52,12,4,(232,241,232,255))
rect(20,56,24,4,(25,201,212,255))
rect(8,52,8,8,(240,79,79,255))
rect(48,52,8,8,(80,232,120,255))
img = base.resize((size, size), Image.Resampling.NEAREST)
Path(out).parent.mkdir(parents=True, exist_ok=True)
img.save(out, format="PNG")
print("OK")
`;
  const result = spawnSync('python3', ['-c', script, String(size), outPng], {
    encoding: 'utf8',
    timeout: 20000,
  });
  return result.status === 0 && fs.existsSync(outPng) && fs.statSync(outPng).size > 64;
}

/**
 * Rasterize SVG → PNG. Prefers exact Pillow redraw; qlmanage only as last resort (often padded).
 */
function rasterizeSvg(svgPath, size, outPng) {
  if (!svgPath || !fs.existsSync(svgPath)) return false;
  const name = path.basename(svgPath).toLowerCase();
  if (name.includes('native') && renderNativeLogoPil(size, outPng)) return true;
  if (name.includes('pixel') && renderPixelLogoPil(size, outPng)) return true;
  // Fallback: if a prebuilt PNG with same stem exists
  const stem = path.basename(svgPath, path.extname(svgPath));
  const fallback = path.join(path.dirname(svgPath), `${stem}.png`);
  if (fs.existsSync(fallback)) {
    try {
      execFileSync('sips', ['-z', String(size), String(size), fallback, '--out', outPng], { stdio: 'ignore' });
      return fs.existsSync(outPng);
    } catch (_) {
      try { fs.copyFileSync(fallback, outPng); return true; } catch (__) { return false; }
    }
  }
  return false;
}

function ensureBaseLogoPng(kind = 'pixel', size = 1024) {
  const cache = kind === 'native' ? LOGO_NATIVE_PNG : LOGO_PIXEL_PNG;
  const tmp = path.join(os.tmpdir(), `ob-${kind}-${size}.png`);
  const ok = kind === 'native'
    ? renderNativeLogoPil(size, tmp)
    : renderPixelLogoPil(size, tmp);
  if (ok) {
    try { fs.copyFileSync(tmp, cache); } catch (_) { /* assets may be read-only */ }
    return tmp;
  }
  if (fs.existsSync(cache)) return cache;
  if (kind === 'pixel' && fs.existsSync(LOGO_PNG)) return LOGO_PNG;
  return null;
}

/**
 * Draw env number badge on logo PNG via Pillow.
 */
function stampNumberOnPng(logoPath, number, size, outPng) {
  const script = `
import sys
from pathlib import Path
try:
  from PIL import Image, ImageDraw, ImageFont
except Exception as e:
  print("NO_PIL", e, file=sys.stderr)
  sys.exit(2)

logo_path, number, size, out_png = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
img = Image.open(logo_path).convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
draw = ImageDraw.Draw(img)
label = str(number)[:3]
# Larger corner badge so env number is readable on Dock / toolbar
badge_r = max(20, int(size * (0.36 if len(label) <= 1 else 0.40 if len(label) == 2 else 0.44)))
margin = max(2, int(size * 0.03))
cx = size - badge_r // 2 - margin
cy = size - badge_r // 2 - margin
ring = max(2, size // 40)
draw.ellipse(
  (cx - badge_r // 2, cy - badge_r // 2, cx + badge_r // 2, cy + badge_r // 2),
  fill=(0, 122, 255, 255),
  outline=(255, 255, 255, 255),
  width=ring,
)
font_size = max(11, int(badge_r * (0.78 if len(label) == 1 else 0.58 if len(label) == 2 else 0.46)))
font = None
for fp in (
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/SFNSRounded.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/Library/Fonts/Arial Bold.ttf",
  "C:\\\\Windows\\\\Fonts\\\\arialbd.ttf",
  "C:\\\\Windows\\\\Fonts\\\\segoeui.ttf",
):
  try:
    font = ImageFont.truetype(fp, font_size)
    break
  except Exception:
    continue
if font is None:
  font = ImageFont.load_default()
bbox = draw.textbbox((0, 0), label, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
draw.text((cx - tw / 2, cy - th / 2 - max(1, size // 128)), label, fill=(255, 255, 255, 255), font=font)
Path(out_png).parent.mkdir(parents=True, exist_ok=True)
img.save(out_png, format="PNG")
print("OK")
`;
  const result = spawnSync('python3', ['-c', script, logoPath, String(number), String(size), outPng], {
    encoding: 'utf8',
    timeout: 20000,
  });
  return result.status === 0 && fs.existsSync(outPng) && fs.statSync(outPng).size > 64;
}

function generateFallbackPng(number, size, outPng) {
  const script = `
import struct, zlib, sys
from pathlib import Path
number, size, out_png = sys.argv[1], int(sys.argv[2]), sys.argv[3]
r,g,b,a = 0, 122, 255, 255
row = bytes([0] + [r,g,b,a] * size)
raw = row * size
def chunk(tag, data):
  return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
png = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
Path(out_png).parent.mkdir(parents=True, exist_ok=True)
Path(out_png).write_bytes(png)
print('OK')
`;
  const result = spawnSync('python3', ['-c', script, String(number), String(size), outPng], {
    encoding: 'utf8',
    timeout: 10000,
  });
  return result.status === 0 && fs.existsSync(outPng);
}

/**
 * Browser environment icon: logo-native.svg + number badge.
 */
function generateEnvIconPng(number, size, outPng) {
  const label = normalizeEnvNumber(number);
  const base = ensureBaseLogoPng('native', Math.max(size, 256));
  if (base && stampNumberOnPng(base, label, size, outPng)) return outPng;
  // Last resort: rasterize SVG fresh into out dir then stamp
  const tmpBase = path.join(os.tmpdir(), `ob-native-base-${size}.png`);
  if (rasterizeSvg(LOGO_NATIVE_SVG, size, tmpBase) && stampNumberOnPng(tmpBase, label, size, outPng)) {
    return outPng;
  }
  if (generateFallbackPng(label, size, outPng)) return outPng;
  throw new Error('Failed to generate environment icon PNG from logo-native.svg');
}

/**
 * Software / app shortcut icon: logo-pixel.svg (no env number).
 */
function generateAppIconPng(size, outPng) {
  const base = ensureBaseLogoPng('pixel', Math.max(size, 256));
  if (base) {
    try {
      execFileSync('sips', ['-z', String(size), String(size), base, '--out', outPng], { stdio: 'ignore' });
      if (fs.existsSync(outPng)) return outPng;
    } catch (_) {
      fs.copyFileSync(base, outPng);
      return outPng;
    }
  }
  if (rasterizeSvg(LOGO_PIXEL_SVG, size, outPng)) return outPng;
  throw new Error('Failed to generate app icon from logo-pixel.svg');
}

function pngToIcns(pngPath, icnsPath) {
  if (process.platform !== 'darwin') return null;
  const iconset = icnsPath.replace(/\.icns$/i, '.iconset');
  try {
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.mkdirSync(iconset, { recursive: true });
    const sizes = [16, 32, 64, 128, 256, 512];
    for (const size of sizes) {
      const out = path.join(iconset, `icon_${size}x${size}.png`);
      execFileSync('sips', ['-z', String(size), String(size), pngPath, '--out', out], { stdio: 'ignore' });
      if (size <= 256) {
        const out2x = path.join(iconset, `icon_${size}x${size}@2x.png`);
        const s2 = size * 2;
        if (s2 <= 512) {
          execFileSync('sips', ['-z', String(s2), String(s2), pngPath, '--out', out2x], { stdio: 'ignore' });
        }
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsPath], { stdio: 'ignore' });
    fs.rmSync(iconset, { recursive: true, force: true });
    return fs.existsSync(icnsPath) ? icnsPath : null;
  } catch (_) {
    try { fs.rmSync(iconset, { recursive: true, force: true }); } catch (__) {}
    return null;
  }
}

/**
 * Rebuild assets/logo.png + logo.icns (+ logo-pixel.png) from logo-pixel.svg.
 * Used by brand-host-dev / packaging / Dock of the app itself.
 */
function rebuildAppShortcutIcons() {
  const master = path.join(os.tmpdir(), 'ob-app-logo-1024.png');
  generateAppIconPng(1024, master);
  try {
    fs.copyFileSync(master, LOGO_PIXEL_PNG);
    fs.copyFileSync(master, LOGO_PNG);
    // convenient 512 for UI
    const p512 = path.join(ASSETS, 'logo-512.png');
    try {
      execFileSync('sips', ['-z', '512', '512', master, '--out', p512], { stdio: 'ignore' });
    } catch (_) {}
    pngToIcns(master, LOGO_ICNS);
  } catch (error) {
    // If assets dir not writable, still return master path for callers
    return { master, error: error.message };
  }
  return { master, logoPng: LOGO_PNG, logoIcns: LOGO_ICNS, logoPixelPng: LOGO_PIXEL_PNG };
}

/**
 * Per-profile marker extension: toolbar icon = logo-native + number.
 * In-page floating badge also shows the number (extension content script).
 */
async function prepareMarkerExtension({ profileId, envNumber, userDataPath, templateDir }) {
  const label = normalizeEnvNumber(envNumber);
  const dest = path.join(userDataPath, 'env-markers', String(profileId || 'env'), 'extension');
  await fsp.mkdir(dest, { recursive: true });

  const sizes = [16, 32, 48, 128];
  for (const size of sizes) {
    generateEnvIconPng(label, size, path.join(dest, `icon-${size}.png`));
  }

  const manifest = {
    manifest_version: 3,
    name: `环境 ${label}`,
    version: '1.0.2',
    description: `OpenBrowser 环境 ${label}（浏览器图标 logo-native + 编号）`,
    action: {
      default_title: `OpenBrowser · 环境 ${label}`,
      default_icon: {
        16: 'icon-16.png',
        32: 'icon-32.png',
        48: 'icon-48.png',
        128: 'icon-128.png',
      },
    },
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    content_scripts: [
      {
        matches: ['http://*/*', 'https://*/*'],
        js: ['marker.js'],
        run_at: 'document_idle',
      },
    ],
  };
  await fsp.writeFile(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // In-page badge shows env number (toolbar icon already has logo-native+number)
  const markerJs = `(() => {
  const id = 'openbrowser-profile-marker';
  const label = ${JSON.stringify(label)};
  const existing = document.getElementById(id);
  if (existing) {
    existing.textContent = label;
    existing.setAttribute('data-env', label);
    return;
  }
  const badge = document.createElement('div');
  badge.id = id;
  badge.setAttribute('data-env', label);
  badge.textContent = label;
  badge.title = 'OpenBrowser 环境 ' + label;
  Object.assign(badge.style, {
    position: 'fixed',
    right: '14px',
    bottom: '14px',
    zIndex: '2147483647',
    minWidth: '28px',
    height: '28px',
    padding: '0 10px',
    borderRadius: '999px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(145deg,#007AFF,#0056CC)',
    color: '#fff',
    font: '700 13px/1 system-ui,-apple-system,Segoe UI,sans-serif',
    boxShadow: '0 8px 24px rgba(0,122,255,.35)',
    border: '2px solid rgba(255,255,255,.85)',
    pointerEvents: 'none',
    letterSpacing: '0.02em',
  });
  (document.documentElement || document.body).appendChild(badge);
})();
`;
  await fsp.writeFile(path.join(dest, 'marker.js'), markerJs, 'utf8');

  if (templateDir) {
    await fsp.writeFile(path.join(dest, '.source-template'), String(templateDir), 'utf8').catch(() => {});
  }
  return dest;
}

async function forceSymlink(target, linkPath) {
  try { await fsp.rm(linkPath, { recursive: true, force: true }); } catch (_) {}
  await fsp.symlink(target, linkPath);
}

/**
 * Resolve real kernel layout from browser.path (OpenBrowser launcher or .bin).
 * macOS Dock icon follows the .app that owns the running executable path.
 * A thin `exec /path/to/real/OpenBrowser` wrapper DOES NOT change Dock icon —
 * we must run OpenBrowser.bin from inside an env-specific .app that has our icns.
 */
function resolveKernelLayout(realBinary) {
  const resolved = path.resolve(realBinary);
  let realMacOS = path.dirname(resolved);
  if (path.basename(resolved) === 'OpenBrowser.bin' || path.basename(resolved) === 'OpenBrowser') {
    realMacOS = path.dirname(resolved);
  }
  // If path points at .app itself
  if (resolved.endsWith('.app')) {
    realMacOS = path.join(resolved, 'Contents', 'MacOS');
  }
  const realContents = path.dirname(realMacOS);
  const realApp = path.dirname(realContents);
  const realBin = path.join(realMacOS, 'OpenBrowser.bin');
  // kernels/openbrowser (for init_template + ipc-stub): MacOS → Contents → App → openbrowser_148 → chrome_148 → openbrowser
  const kernelRoot = path.resolve(realMacOS, '../../../../..');
  return {
    realMacOS,
    realContents,
    realApp,
    realBin: fs.existsSync(realBin) ? realBin : resolved,
    kernelRoot,
    frameworks: path.join(realContents, 'Frameworks'),
    resources: path.join(realContents, 'Resources'),
  };
}

/**
 * macOS: per-env Chromium .app shell so Dock shows logo-native + number.
 * Structure (symlinks keep size small):
 *   环境 N.app/Contents/
 *     Frameworks -> real Frameworks
 *     Resources/* -> real Resources (icns overwritten with env icon)
 *     MacOS/OpenBrowser.bin -> real bin
 *     MacOS/OpenBrowser      = launcher (runs bin FROM this bundle)
 */
async function prepareMacDockWrapper({
  profileId,
  envNumber,
  userDataPath,
  realBinary,
}) {
  if (process.platform !== 'darwin' || !realBinary || !fs.existsSync(realBinary)) return null;
  const label = normalizeEnvNumber(envNumber);
  const appName = `环境 ${label}`;
  const layout = resolveKernelLayout(realBinary);
  if (!fs.existsSync(layout.realBin)) return null;

  const appRoot = path.join(userDataPath, 'env-apps', String(profileId || label), `${appName}.app`);
  const contents = path.join(appRoot, 'Contents');
  const macOS = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');

  // Rebuild shell cleanly so we never keep a thin exec-wrapper
  await fsp.rm(appRoot, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(macOS, { recursive: true });
  await fsp.mkdir(resources, { recursive: true });

  // Frameworks (Helpers live here — required)
  if (fs.existsSync(layout.frameworks)) {
    await forceSymlink(layout.frameworks, path.join(contents, 'Frameworks'));
  }

  // Resources: link real assets, then replace icons with env-numbered logo-native
  if (fs.existsSync(layout.resources)) {
    for (const name of fs.readdirSync(layout.resources)) {
      await forceSymlink(path.join(layout.resources, name), path.join(resources, name));
    }
  }
  const png512 = path.join(macOS, `.env-icon-${label}.png`);
  generateEnvIconPng(label, 512, png512);
  const icnsPath = path.join(resources, 'app.icns');
  // Remove symlink before writing real icon files
  for (const iconName of ['app.icns', 'AppIcon_store.icns', 'AppIcon_wb.icns']) {
    try { await fsp.rm(path.join(resources, iconName), { force: true }); } catch (_) {}
  }
  pngToIcns(png512, icnsPath);
  if (!fs.existsSync(icnsPath)) {
    try { execFileSync('sips', ['-s', 'format', 'icns', png512, '--out', icnsPath], { stdio: 'ignore' }); } catch (_) {}
  }
  if (fs.existsSync(icnsPath)) {
    for (const iconName of ['AppIcon_store.icns', 'AppIcon_wb.icns']) {
      try { await fsp.copyFile(icnsPath, path.join(resources, iconName)); } catch (_) {}
    }
  }
  // Keep a PNG preview in Resources for debugging
  try { await fsp.copyFile(png512, path.join(resources, 'env-icon.png')); } catch (_) {}

  // MacOS payloads: OpenBrowser.bin MUST be a real file under this .app.
  // Symlink back to the kernel .app makes Dock resolve the kernel icon (Chrome/Hub mark)
  // — never fall back to that path (see CODE_OVERVIEW §4B.2).
  {
    const src = path.join(layout.realMacOS, 'OpenBrowser.bin');
    const dest = path.join(macOS, 'OpenBrowser.bin');
    if (!fs.existsSync(src)) {
      throw new Error('Dock shell: kernel OpenBrowser.bin missing at ' + src);
    }
    try { await fsp.rm(dest, { force: true }); } catch (_) {}
    try {
      await fsp.copyFile(src, dest);
      await fsp.chmod(dest, 0o755);
    } catch (error) {
      throw new Error(
        'Dock shell requires a real OpenBrowser.bin copy under the env app (refusing kernel symlink): '
        + (error && error.message ? error.message : error)
      );
    }
    // Hard-fail if something re-created a symlink
    try {
      const st = await fsp.lstat(dest);
      if (st.isSymbolicLink()) {
        throw new Error('Dock shell OpenBrowser.bin must not be a symlink');
      }
    } catch (error) {
      if (/must not be a symlink|refusing kernel/.test(String(error.message || error))) throw error;
      throw new Error('Dock shell OpenBrowser.bin verify failed: ' + (error.message || error));
    }
  }
  for (const name of ['libskit.dylib', 'analysis', 'webdriver', 'main.dat']) {
    const src = path.join(layout.realMacOS, name);
    if (fs.existsSync(src)) await forceSymlink(src, path.join(macOS, name));
  }

  // PkgInfo
  try {
    const pkg = path.join(layout.realContents, 'PkgInfo');
    if (fs.existsSync(pkg)) await fsp.copyFile(pkg, path.join(contents, 'PkgInfo'));
    else await fsp.writeFile(path.join(contents, 'PkgInfo'), 'APPLCr24', 'utf8');
  } catch (_) {}

  // Info.plist: MUST keep kernel identity (Bundle ID + NSPrincipalClass) or Helpers die → black window.
  // Only display name / icon differ so Dock shows 环境 N + logo-native badge.
  const realPlistPath = path.join(layout.realContents, 'Info.plist');
  let plistBody = '';
  try {
    plistBody = await fsp.readFile(realPlistPath, 'utf8');
  } catch (_) {
    plistBody = '';
  }
  if (plistBody && plistBody.includes('CFBundleIdentifier')) {
    const patch = (key, value) => {
      const re = new RegExp(`(<key>${key}<\\/key>\\s*<string>)[^<]*(<\\/string>)`);
      if (re.test(plistBody)) plistBody = plistBody.replace(re, `$1${value}$2`);
    };
    patch('CFBundleDisplayName', appName);
    patch('CFBundleName', appName);
    patch('CFBundleIconFile', 'app.icns');
    // Keep CFBundleIdentifier = org.HongKongZiXun.HubStudio (Helpers / Mach rendezvous)
    // Keep NSPrincipalClass = BrowserCrApplication
    await fsp.writeFile(path.join(contents, 'Info.plist'), plistBody, 'utf8');
  } else {
    // Minimal fallback still uses real HubStudio id + BrowserCrApplication
    const fallback = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>${appName}</string>
  <key>CFBundleExecutable</key><string>OpenBrowser</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundleIdentifier</key><string>org.HongKongZiXun.HubStudio</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${appName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>148.0.7778.165</string>
  <key>CFBundleSignature</key><string>Cr24</string>
  <key>CFBundleVersion</key><string>7778.165</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>BrowserCrApplication</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
`;
    await fsp.writeFile(path.join(contents, 'Info.plist'), fallback, 'utf8');
  }

  // Launcher: same duties as kernel script. CRITICAL: use exec so OpenBrowser.bin
  // replaces this process and becomes the .app main process (Helpers need that).
  const kernelRoot = layout.kernelRoot;
  const launcher = path.join(macOS, 'OpenBrowser');
  const script = `#!/bin/bash
# Env Dock shell — exec into OpenBrowser.bin so Helpers/Mach rendezvous work; Dock uses this .app icon.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REAL="\${HERE}/OpenBrowser.bin"
KERNEL_ROOT=${JSON.stringify(kernelRoot)}
LOG_DIR="\${HOME}/Library/Application Support/openbrowser/logs"
mkdir -p "\$LOG_DIR" 2>/dev/null || true
LOG="\${LOG_DIR}/kernel-launch.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] env=${label} $*" >>"\$LOG" 2>/dev/null || true; }

if [[ ! -e "\$REAL" ]]; then
  log "FATAL missing OpenBrowser.bin in env app"; exit 127
fi
if [[ -f "\${HERE}/libskit.dylib" ]]; then SKIT="\${HERE}/libskit.dylib"
elif [[ -f "\${KERNEL_ROOT}/libskit.dylib" ]]; then SKIT="\${KERNEL_ROOT}/libskit.dylib"
else SKIT=""; fi
TEMPLATE="\${KERNEL_ROOT}/init_template.json"
IPC_STUB="\${KERNEL_ROOT}/ipc-stub.py"

for a in "\$@"; do
  case "\$a" in
    --version|-version|--product-version)
      if [[ -n "\$SKIT" ]]; then exec env -u DYLD_INSERT_LIBRARIES DYLD_INSERT_LIBRARIES="\$SKIT" "\$REAL" --product-version
      else exec env -u DYLD_INSERT_LIBRARIES "\$REAL" --product-version; fi ;;
  esac
done

USER_DATA=""; HAS_STORE=0; HAS_BROWSER_ID=0; HAS_NO_SANDBOX=0; HAS_MOCK=0; HAS_REMOTE=0; HAS_NOPROXY=0; HAS_DDE=0
for a in "\$@"; do
  case "\$a" in
    --user-data-dir=*) USER_DATA="\${a#--user-data-dir=}" ;;
    --store_data_path=*) HAS_STORE=1 ;;
    --browser_id=*) HAS_BROWSER_ID=1 ;;
    --no-sandbox) HAS_NO_SANDBOX=1 ;;
    --use-mock-keychain) HAS_MOCK=1 ;;
    --remote-allow-origins=*) HAS_REMOTE=1 ;;
    --no-proxy-server) HAS_NOPROXY=1 ;;
    --do-not-de-elevate) HAS_DDE=1 ;;
  esac
done

log "launch user_data=\${USER_DATA:-} dock_app=\${HERE}/../.. args=\$#"
EXTRA=()
BROWSER_ID_VAL=""

if [[ -n "\$USER_DATA" ]]; then
  mkdir -p "\$USER_DATA" 2>/dev/null || true
  rm -f "\$USER_DATA/SingletonLock" "\$USER_DATA/SingletonCookie" "\$USER_DATA/SingletonSocket" "\$USER_DATA/DevToolsActivePort" 2>/dev/null || true
  if command -v python3 >/dev/null 2>&1; then
    BROWSER_ID_VAL=\$(python3 - "\$TEMPLATE" "\$USER_DATA/init.json" <<'PY' 2>>"\$LOG" || true
import base64, json, sys
from pathlib import Path
template, out = Path(sys.argv[1]), Path(sys.argv[2])
def load_init(path: Path):
    if not path.is_file():
        return {}
    raw = path.read_bytes().strip()
    try:
        data = base64.b64decode(raw, validate=False)
        if data[:1] == b"{":
            return json.loads(data)
    except Exception:
        pass
    try:
        if raw[:1] == b"{":
            return json.loads(raw)
    except Exception:
        pass
    return {}
init = load_init(out)
if not init and template.is_file():
    try: init = json.loads(template.read_text(encoding="utf-8"))
    except Exception: init = {}
if not isinstance(init, dict): init = {}
init["proxy"] = {}
init["async_proxy_data"] = 0
init["async_proxy_data_wait_page"] = ""
init["is_garble_dom_event_trusted"] = False
init["is_hubstudio"] = False
init["black_white_list"] = {"black_list": [], "exception_list": [], "tips": "", "type": 1}
init["local_port"] = {"type": 0, "black_list": [], "white_list": []}
init["launcher_page"] = "about:blank"
init["home_page"] = ""
init["page_info_enabled"] = False
init["address_bar_custom"] = []
init["framework_url_entry"] = {
    "password_manage": "chrome://password-manager/",
    "history": "chrome://history/",
    "extension_management": "chrome://extensions/",
    "setting": "chrome://settings/",
    "app_center": "chrome://extensions/",
}
init.setdefault("product_infos", {})["product_name"] = "OpenBrowser"
init.setdefault("sa_analysis", {})
init["sa_analysis"]["sa_product"] = "chromium"
init["sa_analysis"]["sa_productVer"] = "148.0.0.0"
init["required_enabled_extension_id_list"] = []
ipc = init.get("ipc") if isinstance(init.get("ipc"), dict) else {}
win = str(ipc.get("browser_window_name") or "").strip() or "SB171550832"
ipc = {
    "browser_window_name": win,
    "from_client": str(ipc.get("from_client") or f"/tmp/{win}"),
    "from_client_pipe": str(ipc.get("from_client_pipe") or win),
    "is_pipe": True,
    "rnclient_window_name": str(ipc.get("rnclient_window_name") or f"{win}listen"),
    "to_client": str(ipc.get("to_client") or f"/tmp/{win}listen"),
    "to_client_pipe": str(ipc.get("to_client_pipe") or f"{win}listen"),
}
init["ipc"] = ipc
cl = init.get("cmd_line") if isinstance(init.get("cmd_line"), dict) else {}
cl["remote-debugging-port"] = "0"
init["cmd_line"] = cl
if not init.get("token"): init["token"] = "openbrowser-token"
plain = json.dumps(init, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
out.write_bytes(base64.b64encode(plain))
print(win)
PY
)
    BROWSER_ID_VAL=\$(printf '%s\\n' "\$BROWSER_ID_VAL" | head -1 | tr -d '\\r')
    log "init window/browser_id=\${BROWSER_ID_VAL}"
  fi
  if [[ "\$HAS_STORE" -eq 0 ]]; then
    STORE=\$(python3 -c "import base64,sys; print(base64.b64encode(sys.argv[1].encode()).decode())" "\$USER_DATA" 2>>"\$LOG" || true)
    [[ -n "\${STORE:-}" ]] && EXTRA+=(--store_data_path="\$STORE")
  fi
  if [[ "\$HAS_BROWSER_ID" -eq 0 ]]; then
    [[ -z "\${BROWSER_ID_VAL:-}" ]] && BROWSER_ID_VAL="SB171550832"
    EXTRA+=(--browser_id="\$BROWSER_ID_VAL")
  fi
fi

[[ "\$HAS_NO_SANDBOX" -eq 0 ]] && EXTRA+=(--no-sandbox)
[[ "\$HAS_MOCK" -eq 0 ]] && EXTRA+=(--use-mock-keychain)
[[ "\$HAS_REMOTE" -eq 0 ]] && EXTRA+=(--remote-allow-origins=*)
[[ "\$HAS_NOPROXY" -eq 0 ]] && EXTRA+=(--no-proxy-server)
[[ "\$HAS_DDE" -eq 0 ]] && EXTRA+=(--do-not-de-elevate)

# IPC stub detached (survives exec); next launch re-binds the same sockets
if [[ -n "\${BROWSER_ID_VAL:-}" ]] && command -v python3 >/dev/null 2>&1 && [[ -f "\$IPC_STUB" ]]; then
  # drop previous stub holders of this window name
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "ipc-stub.py \${BROWSER_ID_VAL}" 2>/dev/null || true
  fi
  python3 "\$IPC_STUB" "\$BROWSER_ID_VAL" >>"\$LOG" 2>&1 &
  disown 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -S "/tmp/\${BROWSER_ID_VAL}" || -S "/tmp/\${BROWSER_ID_VAL}listen" ]]; then break; fi
    sleep 0.05
  done
  log "ipc-stub ready window=\${BROWSER_ID_VAL}"
fi

log "exec REAL (replace shell) extras=\${#EXTRA[@]}"
# exec: OpenBrowser.bin becomes this .app's main process — required for GPU/renderer Helpers
if [[ -n "\$SKIT" ]]; then
  exec env -u DYLD_INSERT_LIBRARIES DYLD_INSERT_LIBRARIES="\$SKIT" "\$REAL" "\${EXTRA[@]}" "\$@"
else
  exec env -u DYLD_INSERT_LIBRARIES "\$REAL" "\${EXTRA[@]}" "\$@"
fi
`;
  await fsp.writeFile(launcher, script, 'utf8');
  await fsp.chmod(launcher, 0o755);

  try { execFileSync('touch', [appRoot], { stdio: 'ignore' }); } catch (_) {}
  try {
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', [
      '-f', '-R', appRoot,
    ], { stdio: 'ignore' });
  } catch (_) {}

  return launcher;
}

/** Sync bundled-extension template icons to logo-native (no number; per-env copies get numbers). */
function rebuildBundledExtensionIcons() {
  const dir = path.join(APP_ROOT, 'bundled-extension');
  if (!fs.existsSync(dir)) return;
  const base = ensureBaseLogoPng('native', 256);
  if (!base) return;
  for (const size of [16, 32, 48, 128]) {
    const out = path.join(dir, `icon-${size}.png`);
    try {
      execFileSync('sips', ['-z', String(size), String(size), base, '--out', out], { stdio: 'ignore' });
    } catch (_) {
      try { fs.copyFileSync(base, out); } catch (__) {}
    }
  }
}

module.exports = {
  normalizeEnvNumber,
  generateEnvIconPng,
  generateAppIconPng,
  prepareMarkerExtension,
  prepareMacDockWrapper,
  pngToIcns,
  rebuildAppShortcutIcons,
  rebuildBundledExtensionIcons,
  rasterizeSvg,
  LOGO_PIXEL_SVG,
  LOGO_NATIVE_SVG,
};

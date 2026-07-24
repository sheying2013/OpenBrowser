import { rcedit } from 'rcedit';

const [exePath, iconPath] = process.argv.slice(2);
if (!exePath || !iconPath) {
  throw new Error('Usage: node brand-exe.mjs <exePath> <iconPath>');
}

await rcedit(exePath, {
  'version-string': {
    ProductName: 'OpenBrowser',
    FileDescription: 'OpenBrowser',
    CompanyName: 'OpenBrowser 开源项目',
    LegalCopyright: 'AGPL-3.0-or-later',
    OriginalFilename: 'OpenBrowser.exe'
  },
  'file-version': '1.0.3.0',
  'product-version': '1.0.3.0',
  icon: iconPath,
  'requested-execution-level': 'asInvoker'
});

#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const outputDirectory = path.resolve(process.argv[2] || appRoot);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function windowsBuild() {
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const compiler = path.join(framework, 'csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('未找到 .NET Framework C# 编译器：' + compiler);

  const references = [
    path.join(framework, 'System.dll'),
    path.join(framework, 'System.Core.dll'),
    path.join(framework, 'System.Drawing.dll'),
    path.join(framework, 'System.Windows.Forms.dll'),
    path.join(framework, 'WPF', 'UIAutomationClient.dll'),
    path.join(framework, 'WPF', 'UIAutomationTypes.dll'),
    path.join(framework, 'WPF', 'WindowsBase.dll'),
  ];
  const icon = path.join(appRoot, 'assets', 'logo.ico');
  const targets = fs.readdirSync(appRoot)
    .filter((name) => /^native-.*\.cs$/i.test(name))
    .sort()
    .map((name) => path.join(appRoot, name));
  if (!targets.length) throw new Error('没有找到 native-*.cs 原生辅助程序源码');

  ensureDir(outputDirectory);
  for (const target of targets) {
    const output = path.join(outputDirectory, path.basename(target, '.cs') + '.exe');
    const arguments_ = [
      '/nologo',
      '/utf8output',
      '/optimize+',
      '/target:exe',
      '/platform:anycpu',
      '/out:' + output,
      ...references.map((item) => '/reference:' + item),
    ];
    if (fs.existsSync(icon)) arguments_.push('/win32icon:' + icon);
    arguments_.push(target);
    run(compiler, arguments_);
    if (!fs.existsSync(output)) throw new Error('原生辅助程序编译失败：' + path.basename(target));
    console.log('[native]', path.basename(output));
  }
  console.log('原生辅助程序已编译到：' + outputDirectory);
}

function macBuild() {
  ensureDir(outputDirectory);
  console.log('[native] macOS 使用 globalShortcut + CDP 页面同步，无需编译 Windows native-*.cs 辅助程序');
  console.log('原生辅助程序跳过：' + outputDirectory);
}

if (process.platform === 'win32') windowsBuild();
else if (process.platform === 'darwin') macBuild();
else {
  console.log('[native] 当前平台跳过 Windows 原生辅助程序编译：' + process.platform);
}

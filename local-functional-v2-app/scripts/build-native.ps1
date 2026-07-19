param(
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = $appRoot }
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

$framework = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  throw '未找到 .NET Framework C# 编译器：' + $compiler
}

$references = @(
  (Join-Path $framework 'System.dll'),
  (Join-Path $framework 'System.Core.dll'),
  (Join-Path $framework 'System.Drawing.dll'),
  (Join-Path $framework 'System.Windows.Forms.dll'),
  (Join-Path $framework 'WPF\UIAutomationClient.dll'),
  (Join-Path $framework 'WPF\UIAutomationTypes.dll'),
  (Join-Path $framework 'WPF\WindowsBase.dll')
)
$referenceArgs = $references | ForEach-Object { '/reference:' + $_ }
$icon = Join-Path $appRoot 'assets\logo.ico'
$targets = Get-ChildItem -LiteralPath $appRoot -Filter 'native-*.cs' | Sort-Object Name
if (-not $targets) { throw '没有找到 native-*.cs 原生辅助程序源码' }

foreach ($target in $targets) {
  $output = Join-Path $OutputDirectory ($target.BaseName + '.exe')
  $arguments = @('/nologo', '/utf8output', '/optimize+', '/target:exe', '/platform:anycpu', ('/out:' + $output))
  if (Test-Path -LiteralPath $icon) { $arguments += '/win32icon:' + $icon }
  $arguments += $referenceArgs
  $arguments += $target.FullName
  & $compiler @arguments
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output)) {
    throw '原生辅助程序编译失败：' + $target.Name
  }
  Write-Host ('[native] ' + [System.IO.Path]::GetFileName($output))
}

Write-Host ('原生辅助程序已编译到：' + $OutputDirectory)

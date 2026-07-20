param(
  [ValidateSet('with-kernel', 'without-kernel')]
  [string]$Variant = 'with-kernel'
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot

Push-Location $appRoot
try {
  $env:OPENBROWSER_PACKAGE_VARIANT = $Variant
  & node (Join-Path $PSScriptRoot 'package-portable.js')
  if ($LASTEXITCODE -ne 0) {
    throw "便携版打包失败，退出码：$LASTEXITCODE"
  }
}
finally {
  Remove-Item Env:OPENBROWSER_PACKAGE_VARIANT -ErrorAction SilentlyContinue
  Pop-Location
}

<#
.SYNOPSIS
  从解包后的 APK 目录拷贝游戏所需子集到 vendor/。

.DESCRIPTION
  Windows 便捷入口，真正的逻辑在 scripts/fetch-source.js（跨平台，Docker 构建也用它）。
  只拷贝 assets/game/ 与 resource/China/，不拷贝安卓壳文件。

.EXAMPLE
  .\scripts\fetch-source.ps1
  .\scripts\fetch-source.ps1 -Src "E:\apk\com.frog.offline" -Force
#>
[CmdletBinding()]
param(
    [string]$Src = "D:\Downloads\com.frog.offline",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $root "scripts\fetch-source.js"

if (-not (Test-Path $script)) {
    Write-Error "找不到 $script"
    exit 2
}

$nodeArgs = @($script, "--src", $Src)
if ($Force) { $nodeArgs += "--force" }

& node @nodeArgs
exit $LASTEXITCODE

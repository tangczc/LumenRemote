#Requires -Version 5.1
<#
.SYNOPSIS
    离线打包 Windows 安装包（Lumen Remote）。
.DESCRIPTION
    校验环境 -> typecheck/单测 -> build:engine -> 用本机缓存的 Electron 运行时 -> electron-builder 出包 -> 校验产物。
    只依赖本机 %LOCALAPPDATA%\electron\Cache 里的 electron 运行时，不需要联网下载。
.EXAMPLE
    .\scripts\build-win.ps1
.EXAMPLE
    .\scripts\build-win.ps1 -Output out-build -SkipChecks
#>
[CmdletBinding()]
param(
    [string]$Output = 'release',
    [string]$ElectronDist = '.electron-dist',
    [switch]$SkipChecks,
    [switch]$Clean
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step([string]$text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Fail([string]$text) {
    Write-Host "`n[失败] $text" -ForegroundColor Red
    exit 1
}

Step '检查环境'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail '未找到 node，请先安装 Node.js 20+' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail '未找到 npm' }
Write-Host "node $(node -v)"
if (-not (Test-Path 'node_modules\electron-builder')) { Fail '缺少依赖，请先在项目根目录执行 npm install' }
if (-not (Test-Path 'vendor\ffmpeg\ffmpeg.exe')) {
    Fail '缺少 vendor\ffmpeg\ffmpeg.exe（该目录不进仓库，需自备）。缺了它被控端会 spawn ffmpeg ENOENT：没有画面。'
}
Write-Host ("ffmpeg ok：{0:N0} MB" -f ((Get-Item 'vendor\ffmpeg\ffmpeg.exe').Length / 1MB))

if (-not $SkipChecks) {
    Step '类型检查'
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { Fail 'typecheck 未通过，已中止打包（可用 -SkipChecks 跳过）' }

    Step '单元测试'
    npm test
    if ($LASTEXITCODE -ne 0) { Fail '测试未通过，已中止打包（可用 -SkipChecks 跳过）' }
}

Step '编译引擎（TS -> build\，同时拷入 UI / injector / ffmpeg）'
npm run build:engine
if ($LASTEXITCODE -ne 0) { Fail 'build:engine 失败' }
if (-not (Test-Path 'build\app-main.mjs')) { Fail 'build\app-main.mjs 不存在，引擎没编出来' }

Step '准备 Electron 运行时'
$distPath = if ([System.IO.Path]::IsPathRooted($ElectronDist)) { $ElectronDist } else { Join-Path $root $ElectronDist }
if (Test-Path (Join-Path $distPath 'electron.exe')) {
    Write-Host "复用已有运行时：$distPath"
}
else {
    $electronVersion = (Get-Content 'node_modules\electron\package.json' -Raw | ConvertFrom-Json).version
    $cacheRoot = Join-Path $env:LOCALAPPDATA 'electron\Cache'
    $zip = $null
    if (Test-Path $cacheRoot) {
        $zip = Get-ChildItem $cacheRoot -Recurse -Filter "electron-v$electronVersion-win32-x64.zip" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $zip) {
            $zip = Get-ChildItem $cacheRoot -Recurse -Filter 'electron-v*-win32-x64.zip' -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($zip) { Write-Host "没找到 v$electronVersion，退而使用缓存里的 $($zip.Name)" -ForegroundColor Yellow }
        }
    }
    if (-not $zip) {
        Fail "本机缓存里没有 electron 运行时（v$electronVersion）。`n      联网打包请改用：`$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm run dist`n      或者先跑一次 npm run dist（失败也没关系），缓存有了再回来跑本脚本。"
    }
    Write-Host "解压 $($zip.FullName)"
    Remove-Item $distPath -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $distPath -Force | Out-Null
    tar -xf $zip.FullName -C $distPath
    if (-not (Test-Path (Join-Path $distPath 'electron.exe'))) { Fail '解压 electron 运行时失败（tar 返回异常）' }
}

Step "打包（输出目录：$Output）"
$builderArgs = @(
    'electron-builder', '--win',
    "--config.electronDist=$ElectronDist",
    "--config.directories.output=$Output"
)
$attempt = 0
while ($true) {
    $attempt++
    & npx @builderArgs
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -ge 2) {
        Fail "electron-builder 失败。若报 EBUSY，说明有实例正占用 exe：关掉 Lumen Remote 后重跑，或用 -Output out-build 换个目录。"
    }
    Write-Host '打包失败，10 秒后重试一次（常见原因：旧实例占用 exe / 杀毒软件正在扫描）' -ForegroundColor Yellow
    Start-Sleep -Seconds 10
}

Step '校验产物'
$outDir = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $root $Output }
$setup = Get-ChildItem $outDir -Filter '*setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { Fail "没有找到安装包：$outDir\*setup.exe" }

$enginePkg = Join-Path $outDir 'win-unpacked\resources\engine'
$ff = Join-Path $enginePkg 'ffmpeg\ffmpeg.exe'
if (-not (Test-Path $ff)) { Fail '安装包里没有 ffmpeg（被控端会无画面），检查 package.json 的 extraResources 过滤规则' }

$srcHash = (Get-FileHash 'build\app-main.mjs' -Algorithm SHA256).Hash
$pkgHash = (Get-FileHash (Join-Path $enginePkg 'app-main.mjs') -Algorithm SHA256).Hash
if ($srcHash -ne $pkgHash) { Fail '包内引擎与 build\app-main.mjs 不一致，可能打进了旧代码（先确认 build:engine 成功）' }

$portable = Join-Path $outDir 'win-unpacked\Lumen Remote.exe'
Write-Host ''
Write-Host '打包完成：' -ForegroundColor Green
Write-Host ("  安装包    : {0}  ({1:N1} MB, {2:yyyy-MM-dd HH:mm})" -f $setup.FullName, ($setup.Length / 1MB), $setup.LastWriteTime)
Write-Host ("  免安装版  : {0}" -f $portable)
Write-Host ("  ffmpeg    : 已随包 {0:N0} MB" -f ((Get-Item $ff).Length / 1MB))
Write-Host ("  引擎校验  : app-main.mjs 一致 ({0})" -f $srcHash.Substring(0, 12))

if ($Clean) {
    Remove-Item $distPath -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "已清理临时运行时目录 $ElectronDist"
}
else {
    Write-Host "提示：$ElectronDist 已保留，下次打包省去解压；要清理加 -Clean" -ForegroundColor DarkGray
}

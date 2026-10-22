param(
    [string]$Target,
    [string]$StRoot
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot

$knownRoots = @(
    'E:\酒馆\SillyTavern',
    'F:\111\酒馆插件教程\SillyTavern-1.19.0'
)

if (-not $StRoot) {
    foreach ($candidate in $knownRoots) {
        if (Test-Path (Join-Path $candidate 'public\scripts')) {
            $StRoot = $candidate
            break
        }
    }
}

if (-not $Target) {
    if (-not $StRoot) {
        throw '没找到 SillyTavern 目录，请用 -Target 指定扩展目标目录（例如 E:\酒馆\SillyTavern\public\scripts\extensions\third-party\atelier）'
    }
    $Target = Join-Path $StRoot 'public\scripts\extensions\third-party\atelier'
}

Write-Host "源目录 : $source"
Write-Host "目标   : $Target"

New-Item -ItemType Directory -Force -Path $Target | Out-Null

$skip = @('test', 'package.json', 'install.ps1', '.git', 'node_modules')
Get-ChildItem -LiteralPath $source | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Target -Recurse -Force
}

# 清理上一版遗留的文件
foreach ($stale in @('lib\yaml-lite.js', 'lib\compat.js')) {
    $path = Join-Path $Target $stale
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "已删除旧文件: $stale"
    }
}

Write-Host '安装完成。刷新酒馆页面，魔杖菜单（🪄）里会出现「Atelier」。'

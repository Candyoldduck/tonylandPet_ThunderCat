# Builds the portable 雷霆喵 desktop pet: a PyInstaller onedir bundle plus the file tree the page
# loads, staged as dist/雷霆喵/web so the browser sees exactly the repo's layout.
#
#   powershell -ExecutionPolicy Bypass -File tools\build-exe.ps1
#
# -RebuildIcon regenerates projects/leitingmiao/leitingmiao.ico from the illustration first.

param(
    [switch]$RebuildIcon,
    [switch]$SkipLaunchTest
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appName = '雷霆喵'
$dist = Join-Path $root "dist\$appName"
$icon = Join-Path $root 'projects\leitingmiao\leitingmiao.ico'

if ($RebuildIcon) {
    Write-Host '== regenerating the icon from the illustration =='
    py -3.11 (Join-Path $root 'work\probe\make_icon.py')
}
if (-not (Test-Path $icon)) {
    throw "missing $icon - rerun with -RebuildIcon"
}

Write-Host '== stopping any running copy =='
Get-CimInstance Win32_Process -Filter "Name LIKE '%python%' OR Name LIKE '%雷霆喵%'" |
    Where-Object { $_.CommandLine -like '*pet_app.py*' -or $_.Name -eq "$appName.exe" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

Write-Host '== pyinstaller =='
Push-Location $root
try {
    Remove-Item -Recurse -Force build, "dist" -ErrorAction SilentlyContinue
    py -3.11 -m PyInstaller --noconfirm --clean --onedir --windowed `
        --name $appName --icon $icon --contents-directory libs `
        --collect-all webview --collect-all clr_loader --collect-all pythonnet `
        --hidden-import bottle --hidden-import proxy_tools `
        --paths (Join-Path $root 'desktop-pet') `
        (Join-Path $root 'desktop-pet\pet_app.py')
    if ($LASTEXITCODE -ne 0) { throw "pyinstaller exited $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host '== staging web\ =='
$web = Join-Path $dist 'web'
foreach ($dir in @('', 'desktop-pet', 'src\engine', 'projects\leitingmiao\built')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $web $dir) | Out-Null
}
Copy-Item (Join-Path $root 'pet.html') $web -Force
Copy-Item (Join-Path $root 'desktop-pet\pet.js') (Join-Path $web 'desktop-pet') -Force
Copy-Item (Join-Path $root 'src\engine\*.js') (Join-Path $web 'src\engine') -Force
Copy-Item (Join-Path $root 'projects\leitingmiao\rig.json') (Join-Path $web 'projects\leitingmiao') -Force
Copy-Item (Join-Path $root 'projects\leitingmiao\built\*') (Join-Path $web 'projects\leitingmiao\built') -Force

Write-Host '== checking the payload =='
$exe = Join-Path $dist "$appName.exe"
if (-not (Test-Path $exe)) { throw "no executable at $exe" }
$required = @(
    'web\pet.html', 'web\desktop-pet\pet.js', 'web\src\engine\createMeshAvatar.js',
    'web\src\engine\rig.js', 'web\src\engine\motion.js',
    'web\projects\leitingmiao\rig.json', 'web\projects\leitingmiao\built\base.png',
    'web\projects\leitingmiao\built\layers.json', 'web\projects\leitingmiao\built\foreR.png',
    'web\projects\leitingmiao\built\sleeveR.png', 'web\projects\leitingmiao\built\legR_lower.png'
)
foreach ($rel in $required) {
    if (-not (Test-Path (Join-Path $dist $rel))) { throw "missing $rel" }
}
$pngs = (Get-ChildItem (Join-Path $web 'projects\leitingmiao\built') -Filter *.png).Count
$js = (Get-ChildItem (Join-Path $web 'src\engine') -Filter *.js).Count
$size = (Get-ChildItem $dist -Recurse | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("  ok: {0} engine js, {1} layer pngs, {2:N1} MB total" -f $js, $pngs, $size)

if ($SkipLaunchTest) {
    Write-Host "== launch test skipped =="
    return
}

Write-Host '== launching the built exe =='
Start-Process -FilePath $exe -WorkingDirectory $dist
$deadline = (Get-Date).AddSeconds(40)
$found = 0
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    $found = py -3.11 -c "import ctypes;print(ctypes.windll.user32.FindWindowW(None,'$appName'))"
    if ($found -and $found -ne '0') { break }
}
if (-not $found -or $found -eq '0') { throw 'the built exe never showed its window' }
Write-Host "  window appeared (hwnd $found)"
$log = Join-Path $env:APPDATA 'LeitingMiao\pet.log'
if (Test-Path $log) {
    Get-Content $log -Tail 5 | ForEach-Object { Write-Host "  log: $_" }
}
Stop-Process -Name $appName -Force -ErrorAction SilentlyContinue
Write-Host "== done: $dist =="

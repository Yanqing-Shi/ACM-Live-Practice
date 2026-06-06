$ErrorActionPreference = "Stop"

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$testRoot = Join-Path $root ".vscode-test"

$codeCmd = (Get-Command code.cmd -ErrorAction SilentlyContinue).Source
$codeExeCandidates = @()

if ($codeCmd) {
  $binDir = Split-Path -Parent $codeCmd
  $installDir = Split-Path -Parent $binDir
  $codeExeCandidates += Join-Path $installDir "Code.exe"
}

$codeExeCandidates += @(
  (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\Code.exe"),
  (Join-Path $env:ProgramFiles "Microsoft VS Code\Code.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Microsoft VS Code\Code.exe")
)

$codeExe = $codeExeCandidates | Where-Object {
  $_ -and (Test-Path -LiteralPath $_)
} | Select-Object -First 1

if (-not $codeExe) {
  throw "Code.exe not found. Checked: $($codeExeCandidates -join ', ')"
}

Write-Host "Using Code.exe: $codeExe"

$windows = @(
  @{
    Name = "probe-a"
    Workspace = Join-Path $testRoot "probe-a-workspace"
    UserData = Join-Path $testRoot "probe-a-user-data"
    Extensions = Join-Path $testRoot "probe-a-extensions"
  },
  @{
    Name = "probe-b"
    Workspace = Join-Path $testRoot "probe-b-workspace"
    UserData = Join-Path $testRoot "probe-b-user-data"
    Extensions = Join-Path $testRoot "probe-b-extensions"
  }
)

foreach ($window in $windows) {
  New-Item -ItemType Directory -Force -Path $window.Workspace | Out-Null
  New-Item -ItemType Directory -Force -Path $window.UserData | Out-Null
  New-Item -ItemType Directory -Force -Path $window.Extensions | Out-Null

  Set-Content -LiteralPath (Join-Path $window.Workspace "README.txt") -Encoding UTF8 -Value (
    "VS Code launch probe: {0}`nIf you see this in a VS Code window, the direct Code.exe launch works." -f $window.Name
  )

  $args = @(
    "--new-window",
    "--user-data-dir", $window.UserData,
    "--extensions-dir", $window.Extensions,
    $window.Workspace
  )

  Write-Host "Starting $($window.Name): $($args -join ' ')"
  $process = Start-Process -FilePath $codeExe -ArgumentList $args -PassThru
  Write-Host "Started $($window.Name) with PID $($process.Id)"
}

Write-Host "If this worked, two VS Code windows should be open: probe-a and probe-b."

$ErrorActionPreference = "Stop"

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$extensionPath = Join-Path $root "vscode-extension"
$testRoot = Join-Path $root ".vscode-test"

$hosts = @(
  @{
    Name = "alice"
    Workspace = Join-Path $testRoot "alice-workspace"
    UserData = Join-Path $testRoot "alice-user-data"
    Extensions = Join-Path $testRoot "alice-extensions"
  },
  @{
    Name = "bob"
    Workspace = Join-Path $testRoot "bob-workspace"
    UserData = Join-Path $testRoot "bob-user-data"
    Extensions = Join-Path $testRoot "bob-extensions"
  }
)

function Resolve-VSCodeExecutable {
  $candidates = @()

  $codeCommand = (Get-Command code.cmd -ErrorAction SilentlyContinue).Source

  if ($codeCommand) {
    $binDir = Split-Path -Parent $codeCommand
    $installDir = Split-Path -Parent $binDir
    $candidates += Join-Path $installDir "Code.exe"
  }

  $candidates += @(
    (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\Code.exe"),
    (Join-Path $env:ProgramFiles "Microsoft VS Code\Code.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft VS Code\Code.exe")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return @{
        Path = $candidate
        HideWindow = $false
      }
    }
  }

  if ($codeCommand) {
    return @{
      Path = $codeCommand
      HideWindow = $true
    }
  }

  $codeAlias = (Get-Command code -ErrorAction SilentlyContinue).Source

  if ($codeAlias) {
    return @{
      Path = $codeAlias
      HideWindow = $true
    }
  }

  throw "Could not find VS Code. Make sure VS Code is installed and the 'code' command is available in PATH."
}

$code = Resolve-VSCodeExecutable

function Reset-TestHostState {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)

  if (-not $resolvedPath.StartsWith($resolvedTestRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to reset path outside .vscode-test: $resolvedPath"
  }

  if (Test-Path -LiteralPath $resolvedPath) {
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
  }
}

function Write-TestHostSettings {
  param(
    [Parameter(Mandatory = $true)]
    [string] $UserData
  )

  $settingsDir = Join-Path $UserData "User"
  $settingsPath = Join-Path $settingsDir "settings.json"

  New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
  Set-Content -LiteralPath $settingsPath -Encoding UTF8 -Value @'
{
  "window.restoreWindows": "none",
  "files.hotExit": "off",
  "workbench.startupEditor": "none"
}
'@
}

foreach ($hostConfig in $hosts) {
  Reset-TestHostState -Path $hostConfig.UserData
  Reset-TestHostState -Path $hostConfig.Workspace

  New-Item -ItemType Directory -Force -Path $hostConfig.Workspace | Out-Null
  New-Item -ItemType Directory -Force -Path $hostConfig.UserData | Out-Null
  New-Item -ItemType Directory -Force -Path $hostConfig.Extensions | Out-Null
  Write-TestHostSettings -UserData $hostConfig.UserData

  $readmePath = Join-Path $hostConfig.Workspace "README.txt"

  if (-not (Test-Path -LiteralPath $readmePath)) {
    Set-Content -LiteralPath $readmePath -Encoding UTF8 -Value (
      "ICPC Live Extension Development Host: {0}`n`nUse the ICPC Live activity bar to create or join a room." -f $hostConfig.Name
    )
  }

  $startOptions = @{
    FilePath = $code.Path
    ArgumentList = @(
      "--new-window",
      "--disable-restore-windows",
      "--extensionDevelopmentPath", $extensionPath,
      "--user-data-dir", $hostConfig.UserData,
      "--extensions-dir", $hostConfig.Extensions,
      $hostConfig.Workspace
    )
  }

  if ($code.HideWindow) {
    $startOptions.WindowStyle = "Hidden"
  }

  Start-Process @startOptions
}

Write-Host "Opened ICPC Live extension hosts for Alice and Bob."

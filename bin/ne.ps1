# Optional launcher for nebula-enterprise. Usage: ne [arguments]   (for example: ne doctor)
# It finds main.ts relative to its own folder and passes every argument through unchanged.
# It does not use cmd.exe. If the execution policy blocks .ps1 files, run instead:
#   node C:\path\to\nebula-enterprise\src\main.ts
$main = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\main.ts'
& node $main @args
exit $LASTEXITCODE

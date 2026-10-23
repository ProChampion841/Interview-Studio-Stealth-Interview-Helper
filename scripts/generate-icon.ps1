$ErrorActionPreference = "Stop"
& node (Join-Path $PSScriptRoot "generate-icon.cjs")
if ($LASTEXITCODE -ne 0) { throw "Logo rendering failed." }

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$Arguments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$setupScript = Join-Path $PSScriptRoot 'setup-server.mjs'
& node $setupScript @Arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

[CmdletBinding()]
param([string]$DotNet = 'dotnet', [string]$Runtime = 'win-x64', [switch]$SkipGateway)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$extensionRoot = Join-Path $workspaceRoot 'vscode-extension'
$gatewayOut = Join-Path $extensionRoot "bin/$Runtime"

Push-Location -LiteralPath $workspaceRoot
try {
    if (!$SkipGateway) {
        & $DotNet publish src/Muse2Api/Muse2Api.csproj -c Release -r $Runtime --self-contained true -o $gatewayOut --nologo -v minimal
        if ($LASTEXITCODE -ne 0) { throw 'Publish gateway Muse2Api thất bại.' }
        $privateFiles = @(Get-ChildItem -LiteralPath $gatewayOut -Recurse -File | Where-Object { $_.Name -in @('accounts.json','api_key','keys.json','requests.db','cookies.json','storage-state.json','auth.json') })
        if ($privateFiles.Count) { throw 'Dữ liệu cá nhân lọt vào thư mục gateway; dừng đóng gói.' }
    }
    Push-Location -LiteralPath $extensionRoot
    try {
        if (!(Test-Path -LiteralPath 'node_modules')) { npm install }
        npm run compile
        if ($LASTEXITCODE -ne 0) { throw 'Biên dịch TypeScript thất bại.' }
        npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository
        if ($LASTEXITCODE -ne 0) { throw 'Đóng gói vsix thất bại.' }
    } finally { Pop-Location }
    $vsix = @(Get-ChildItem -LiteralPath $extensionRoot -Filter 'muse-vscode-*.vsix' | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
    if (!$vsix) { throw 'Không tìm thấy file .vsix sau khi đóng gói.' }
    Write-Output ('VSIX=' + $vsix.FullName)
    Write-Output ('GATEWAY=' + $gatewayOut)
} finally { Pop-Location }

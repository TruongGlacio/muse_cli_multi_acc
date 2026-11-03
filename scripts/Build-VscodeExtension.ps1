[CmdletBinding()]
param([string]$DotNet = 'dotnet', [string]$Runtime = 'win-x64', [switch]$SkipGateway)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$extensionRoot = Join-Path $workspaceRoot 'vscode-extension'
$gatewayOut = Join-Path $extensionRoot "bin/$Runtime"
$helperOut = Join-Path $extensionRoot "bin/$Runtime/computer-helper"

Push-Location -LiteralPath $workspaceRoot
try {
    if (!$SkipGateway) {
        # v0.8.28: framework-dependent — vsix không còn đóng gói runtime
        # .NET; máy user phải cài .NET 10 Runtime + ASP.NET Core Runtime
        # (và WindowsDesktop Runtime trên Windows cho helper).
        & $DotNet publish src/Muse2Api/Muse2Api.csproj -c Release -r $Runtime --self-contained false -o $gatewayOut --nologo -v minimal
        if ($LASTEXITCODE -ne 0) { throw 'Publish gateway Muse2Api thất bại.' }
        # Helper điều khiển màn hình thử nghiệm (v0.3.0): project net10-windows
        # riêng, chỉ publish cho Windows. Trên runtime khác, bỏ qua helper và
        # extension sẽ báo rõ là computer_* không khả dụng.
        if ($Runtime -like 'win-*') {
            & $DotNet publish src/Muse2Api.ComputerHelper/Muse2Api.ComputerHelper.csproj -c Release -r $Runtime --self-contained false -o $helperOut --nologo -v minimal
            if ($LASTEXITCODE -ne 0) { throw 'Publish helper Muse2Api.ComputerHelper thất bại.' }
            if (!(Test-Path -LiteralPath (Join-Path $helperOut 'Muse2Api.ComputerHelper.exe'))) { throw 'Không tìm thấy Muse2Api.ComputerHelper.exe sau khi publish.' }
        }
        # v0.8.28: vsix không còn đóng gói node của Playwright — extension
        # tự phân giải node lúc chạy (xem gateway.ts). Xóa thư mục node
        # khỏi output publish nhưng GIỮ lại JS driver (.playwright/package).
        $playwrightNode = Join-Path $gatewayOut '.playwright/node'
        if (Test-Path -LiteralPath $playwrightNode) { Remove-Item -LiteralPath $playwrightNode -Recurse -Force }
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
    Write-Output ('HELPER=' + $helperOut)
} finally { Pop-Location }

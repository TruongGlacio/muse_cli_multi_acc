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
        # v0.8.30: trở lại self-contained như 0.8.27 — vsix đóng gói kèm
        # runtime .NET nên máy user KHÔNG cần cài .NET 10 Runtime /
        # ASP.NET Core Runtime / WindowsDesktop Runtime nữa (lý do 0.8.28
        # chuyển sang framework-dependent đã bị rút lại vì user gặp lỗi
        # thiếu runtime ngay lần chạy đầu).
        & $DotNet publish src/Muse2Api/Muse2Api.csproj -c Release -r $Runtime --self-contained true -o $gatewayOut --nologo -v minimal
        if ($LASTEXITCODE -ne 0) { throw 'Publish gateway Muse2Api thất bại.' }
        # Helper điều khiển màn hình thử nghiệm (v0.3.0): project net10-windows
        # riêng, chỉ publish cho Windows. Trên runtime khác, bỏ qua helper và
        # extension sẽ báo rõ là computer_* không khả dụng.
        if ($Runtime -like 'win-*') {
            & $DotNet publish src/Muse2Api.ComputerHelper/Muse2Api.ComputerHelper.csproj -c Release -r $Runtime --self-contained true -o $helperOut --nologo -v minimal
            if ($LASTEXITCODE -ne 0) { throw 'Publish helper Muse2Api.ComputerHelper thất bại.' }
            if (!(Test-Path -LiteralPath (Join-Path $helperOut 'Muse2Api.ComputerHelper.exe'))) { throw 'Không tìm thấy Muse2Api.ComputerHelper.exe sau khi publish.' }
        }
        # v0.8.30: GIỮ nguyên thư mục node của Playwright trong output
        # publish (.playwright/node) để đóng gói kèm vào vsix như 0.8.27;
        # extension ưu tiên node đóng gói sẵn này khi có (xem gateway.ts),
        # chỉ phân giải node hệ thống / tải về khi thật sự chưa có node.
        $privateFiles = @(Get-ChildItem -LiteralPath $gatewayOut -Recurse -File | Where-Object { $_.Name -in @('accounts.json','api_key','keys.json','requests.db','cookies.json','storage-state.json','auth.json') })
        if ($privateFiles.Count) { throw 'Dữ liệu cá nhân lọt vào thư mục gateway; dừng đóng gói.' }
    }
    Push-Location -LiteralPath $extensionRoot
    try {
        if (!(Test-Path -LiteralPath 'node_modules')) { npm install }
        # v0.8.14: khôi phục images/icon.png từ images/icon.png.base64
        # trước khi đóng gói (snapshot-push chỉ chở file text nên icon.png
        # binary không lên được GitHub; thiếu bước này vsix sẽ mất logo).
        node scripts/ensure-extension-icon.js
        if ($LASTEXITCODE -ne 0) { throw 'Khôi phục icon extension thất bại.' }
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

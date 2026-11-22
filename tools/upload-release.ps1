param(
    [string]$Token = $env:GH_TOKEN
)

$ErrorActionPreference = "Stop"

$repo = "YIZ006/PhoneBox-for-dev"
$tag = "v0.9.19"
$releaseTitle = "PhoneBox v0.9.19 (AI Coding & Dev Edition)"
$releaseNotesPath = Join-Path $PSScriptRoot "..\dist\release\RELEASE-NOTES-0.9.19.md"
$body = [System.IO.File]::ReadAllText($releaseNotesPath)

if (-not $Token) {
    $tokenFromEnv = $env:GITHUB_TOKEN
    if ($tokenFromEnv) {
        $Token = $tokenFromEnv
    } else {
        Write-Host "Getting GitHub token from git credential..."
        $credLines = ("protocol=https`nhost=github.com" | git.exe credential fill | Select-String "password=").Line
        if ($credLines -and $credLines.Length -gt 9) {
            $Token = $credLines.Substring(9).Trim()
        }
    }
}

if (-not $Token) {
    throw "Failed to retrieve GitHub token."
}

$headers = @{
    "Authorization" = "Bearer $Token"
    "Accept"        = "application/vnd.github+json"
    "User-Agent"    = "PhoneBox-Release-Uploader"
}

Write-Host "Checking if release already exists for tag $tag..."
$release = $null
try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers -Method Get
    Write-Host "Found existing release (ID: $($release.id))."
} catch {
    Write-Host "Release does not exist yet. Creating release..."
}

if (-not $release) {
    $createPayload = @{
        tag_name         = $tag
        target_commitish = "main"
        name             = $releaseTitle
        body             = $body
        draft            = $false
        prerelease       = $false
    } | ConvertTo-Json -Depth 5

    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases" -Headers $headers -Method Post -Body $createPayload -ContentType "application/json; charset=utf-8"
    Write-Host "Release created successfully! (ID: $($release.id), URL: $($release.html_url))"
}

$uploadUrlBase = $release.upload_url -replace '\{\?name,label\}', ''

$assets = @(
    @{
        Path = Join-Path $PSScriptRoot "..\dist\release\PhoneBoxAgent-0.9.19-win-x64.zip"
        Name = "PhoneBoxAgent-0.9.19-win-x64.zip"
        ContentType = "application/zip"
    },
    @{
        Path = Join-Path $PSScriptRoot "..\dist\release\PhoneBox-0.9.19.apk"
        Name = "PhoneBox-0.9.19.apk"
        ContentType = "application/vnd.android.package-archive"
    },
    @{
        Path = Join-Path $PSScriptRoot "..\dist\release\SHA256SUMS-0.9.19.txt"
        Name = "SHA256SUMS-0.9.19.txt"
        ContentType = "text/plain"
    }
)

# Fetch existing assets in case of resume
$existingAssets = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/$($release.id)/assets" -Headers $headers -Method Get

foreach ($asset in $assets) {
    $filePath = $asset.Path
    $fileName = $asset.Name
    $contentType = $asset.ContentType

    if (-not (Test-Path -LiteralPath $filePath)) {
        Write-Warning "File not found: $filePath"
        continue
    }

    $fileItem = Get-Item -LiteralPath $filePath
    $fileLength = $fileItem.Length
    Write-Host "`nProcessing asset $fileName ($([math]::Round($fileLength / 1MB, 2)) MB)..."

    $match = $existingAssets | Where-Object { $_.name -eq $fileName }
    if ($match) {
        Write-Host "Asset $fileName already exists (ID: $($match.id)). Deleting to replace..."
        Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/assets/$($match.id)" -Headers $headers -Method Delete
    }

    $uploadUri = "$uploadUrlBase`?name=$fileName"
    Write-Host "Uploading $fileName..."

    $uploadHeaders = @{
        "Authorization" = "Bearer $token"
        "Accept"        = "application/vnd.github+json"
        "Content-Type"  = $contentType
        "User-Agent"    = "PhoneBox-Release-Uploader"
    }

    $uploadResp = Invoke-RestMethod -Uri $uploadUri -Headers $uploadHeaders -Method Post -InFile $filePath -TimeoutSec 600
    Write-Host "Uploaded $fileName successfully! (Download URL: $($uploadResp.browser_download_url))"
}

Write-Host "`nAll release assets uploaded successfully!"
Write-Host "Release URL: $($release.html_url)"

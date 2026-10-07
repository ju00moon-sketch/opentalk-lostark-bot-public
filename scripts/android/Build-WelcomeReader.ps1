param(
    [Parameter(Mandatory)][string]$SdkRoot,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$IrisApk
)
$ErrorActionPreference = 'Stop'
$buildPath = [IO.Path]::GetFullPath($OutputDirectory)
$classes = Join-Path $buildPath 'classes'
$dex = Join-Path $buildPath 'dex'
$source = Join-Path $PSScriptRoot 'WelcomeReader.java'
$android = Join-Path $SdkRoot 'platforms/android-30/android.jar'
$d8 = Join-Path $SdkRoot 'build-tools/36.0.0/d8.bat'
$irisHash = '00eaa7800f904b7e3082277525adbbc0581ffe9efdb1c7a475561361f918eab0'
if ((Get-FileHash -LiteralPath $IrisApk).Hash.ToLowerInvariant() -ne $irisHash) { throw 'Unexpected Iris APK.' }
if (!(Test-Path -LiteralPath $android) -or !(Test-Path -LiteralPath $d8)) { throw 'Android platform 30 and build-tools 36.0.0 are required.' }
New-Item -ItemType Directory -Path $classes,$dex -Force | Out-Null
& javac -encoding UTF-8 --release 8 -cp $android -d $classes $source
if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed.' }
& $d8 --lib $android --min-api 30 --output $dex (Join-Path $classes 'opentalk/welcome/WelcomeReader.class')
if ($LASTEXITCODE -ne 0) { throw 'DEX compilation failed.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$jar = Join-Path $buildPath ('welcome-reader-' + [Guid]::NewGuid().ToString('N') + '.jar')
$archive = [IO.Compression.ZipFile]::Open($jar, [IO.Compression.ZipArchiveMode]::Create)
try { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $dex 'classes.dex'), 'classes.dex') | Out-Null }
finally { $archive.Dispose() }
[ordered]@{
    sourceSha256 = (Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant()
    jar = $jar
    jarSha256 = (Get-FileHash -LiteralPath $jar).Hash.ToLowerInvariant()
    irisVersion = 'v0.32'
    irisSha256 = $irisHash
} | ConvertTo-Json | Set-Content (Join-Path $buildPath 'manifest.json') -Encoding UTF8
Write-Output $jar

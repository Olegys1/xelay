$ErrorActionPreference = 'Stop'
$androidRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolRoot = Join-Path $androidRoot '.toolchain'
New-Item -ItemType Directory -Force -Path (Join-Path $toolRoot 'downloads') | Out-Null
$metadata = Invoke-RestMethod -Uri 'https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows'
$package = @($metadata)[0].binary.package
$uri = [Uri]$package.link
if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com' -or $uri.AbsolutePath -notlike '/adoptium/temurin17-binaries/*') { throw 'Unexpected JDK publisher.' }
$archive = Join-Path $toolRoot 'downloads/temurin17-jdk.zip'
if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $archive }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne ([string]$package.checksum).ToLowerInvariant()) { throw 'JDK checksum mismatch.' }
$target = Join-Path $toolRoot 'jdk'
Expand-Archive -LiteralPath $archive -DestinationPath $target -Force
$jdk = Get-ChildItem -LiteralPath $target -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin/jlink.exe') } | Select-Object -First 1
if (-not $jdk) { throw 'Full JDK with jlink is required.' }
Write-Output $jdk.FullName

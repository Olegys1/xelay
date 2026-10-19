param(
    [Parameter(Mandatory = $true)][string]$JavaHomePath,
    [switch]$AcceptAndroidSdkLicense
)
$ErrorActionPreference = 'Stop'
$androidRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolRoot = Join-Path $androidRoot '.toolchain'
$sdkRoot = Join-Path $toolRoot 'sdk'
$downloads = Join-Path $toolRoot 'downloads'
New-Item -ItemType Directory -Force -Path $downloads, $sdkRoot | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $JavaHomePath 'bin/java.exe'))) { throw 'JDK 17/21 is required.' }
if (-not $AcceptAndroidSdkLicense) {
    throw 'Read https://developer.android.com/studio#terms and rerun with -AcceptAndroidSdkLicense only after agreeing.'
}
$env:JAVA_HOME = $JavaHomePath
$env:GRADLE_USER_HOME = Join-Path $toolRoot 'gradle-home'
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot

function Download-Checked([string]$Url, [string]$Target, [string]$Sha256) {
    if (-not (Test-Path -LiteralPath $Target)) {
        Invoke-WebRequest -Uri $Url -OutFile $Target
    }
    if ((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256.ToLowerInvariant()) {
        throw "Checksum mismatch for $([IO.Path]::GetFileName($Target)). No archive will be run."
    }
}

$cliZip = Join-Path $downloads 'commandlinetools-win-15859902_latest.zip'
Download-Checked 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' $cliZip '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
$cliExtract = Join-Path $toolRoot 'cli'
$sdkManager = Join-Path $cliExtract 'cmdline-tools/bin/sdkmanager.bat'
if (-not (Test-Path -LiteralPath $sdkManager)) { Expand-Archive -LiteralPath $cliZip -DestinationPath $cliExtract -Force }
# SDK tools prompt only for the license necessary to install these selected packages.
('y' + [Environment]::NewLine) * 15 | & $sdkManager "--sdk_root=$sdkRoot" 'platforms;android-36' 'build-tools;35.0.0' 'platform-tools'
if ($LASTEXITCODE -ne 0) { throw 'SDK installation failed.' }

$checksumBody = (Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-8.13-bin.zip.sha256').Content
$gradleSha = if ($checksumBody -is [byte[]]) { [Text.Encoding]::UTF8.GetString($checksumBody).Trim() } else { ([string]$checksumBody).Trim() }
$gradleZip = Join-Path $downloads 'gradle-8.13-bin.zip'
Download-Checked 'https://services.gradle.org/distributions/gradle-8.13-bin.zip' $gradleZip $gradleSha
$gradle = Join-Path $toolRoot 'gradle-8.13/bin/gradle.bat'
if (-not (Test-Path -LiteralPath $gradle)) { Expand-Archive -LiteralPath $gradleZip -DestinationPath $toolRoot -Force }
$wrapperProject = Join-Path $toolRoot 'wrapper-project'
New-Item -ItemType Directory -Force -Path $wrapperProject | Out-Null
Set-Content -LiteralPath (Join-Path $wrapperProject 'settings.gradle.kts') -Value 'rootProject.name = "wrapper-bootstrap"' -Encoding utf8
& $gradle -p $wrapperProject wrapper --gradle-version 8.13 --distribution-type bin --gradle-distribution-sha256-sum $gradleSha --no-daemon
if ($LASTEXITCODE -ne 0) { throw 'Wrapper creation failed.' }
New-Item -ItemType Directory -Force -Path (Join-Path $androidRoot 'gradle/wrapper') | Out-Null
Copy-Item -LiteralPath (Join-Path $wrapperProject 'gradlew'), (Join-Path $wrapperProject 'gradlew.bat') -Destination $androidRoot -Force
Copy-Item -LiteralPath (Join-Path $wrapperProject 'gradle/wrapper/gradle-wrapper.jar'), (Join-Path $wrapperProject 'gradle/wrapper/gradle-wrapper.properties') -Destination (Join-Path $androidRoot 'gradle/wrapper') -Force
Write-Output 'Portable SDK and Gradle Wrapper are ready. No global system settings were changed.'
Write-Output "SDK: $sdkRoot"

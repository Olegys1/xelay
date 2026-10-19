param([Parameter(Mandatory = $true)][string]$JavaHomePath, [switch]$Offline)
$ErrorActionPreference = 'Stop'
$androidRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# Windows Gradle immutable-workspace moves are unreliable with very long cache paths.
$shortRoot = Join-Path ([IO.Path]::GetTempPath()) 'xelay-android-build'
New-Item -ItemType Directory -Force -Path $shortRoot | Out-Null
$env:JAVA_HOME = $JavaHomePath
$env:GRADLE_USER_HOME = Join-Path $shortRoot 'gradle-home'
$env:ANDROID_HOME = Join-Path $androidRoot '.toolchain/sdk'
$gradle = Join-Path $androidRoot '.toolchain/gradle-8.13/bin/gradle.bat'
if (-not (Test-Path -LiteralPath $gradle)) { $gradle = Join-Path $androidRoot 'gradlew.bat' }
$gradleArguments = @('-p', $androidRoot, '--project-cache-dir', (Join-Path $shortRoot 'project-cache'), ':app:assembleDebug', '--no-daemon', '--console=plain')
if ($Offline) { $gradleArguments += '--offline' }
& $gradle @gradleArguments
if ($LASTEXITCODE -ne 0) { throw 'Android APK build failed. See the preceding build diagnostics.' }

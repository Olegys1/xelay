#!/usr/bin/env bash
set -euo pipefail

ios_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Generate the iOS project on a Mac with Xcode installed." >&2
  exit 1
fi
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "XcodeGen is missing. Install it with: brew install xcodegen" >&2
  exit 1
fi
if ! xcrun --find xcodebuild >/dev/null 2>&1; then
  echo "Select a full Xcode installation in Xcode > Settings > Locations." >&2
  exit 1
fi
if [[ ! -f "$ios_dir/Config/Local.xcconfig" ]]; then
  echo "Copy Config/Local.example.xcconfig to Config/Local.xcconfig and fill it first." >&2
  exit 1
fi

cd -- "$ios_dir"
exec xcodegen generate --spec project.yml

#!/usr/bin/env bash
# Assemble BridgeBar.app (menu-bar agent) from a release build, ad-hoc signed.
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release
APP="build/release/BridgeBar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp .build/release/BridgeBar "$APP/Contents/MacOS/BridgeBar"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>BridgeBar</string>
    <key>CFBundleIdentifier</key><string>dev.clauderemote.BridgeBar</string>
    <key>CFBundleName</key><string>BridgeBar</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
codesign --force --sign - "$APP"
echo "Built $APP — drag it into /Applications, then launch once"

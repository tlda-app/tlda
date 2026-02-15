#!/bin/bash
#
# install-texsync.sh — Set up the texsync:// URL handler
#
# Cmd-click on rendered content in the viewer opens the source file in Zed
# at the corresponding line. This works via a custom URL scheme:
#
#   texsync://file/absolute/path/to/file.tex:42
#
# Three pieces:
#   1. A shell script that parses the URL and calls zed (~/bin/texsync-url.sh)
#   2. A minimal macOS app that registers the URL scheme and invokes the script
#   3. Registration with Launch Services so macOS knows to route texsync:// URLs
#
# Prerequisites: Zed (https://zed.dev) installed at /usr/local/bin/zed
#
# Usage:
#   ./scripts/install-texsync.sh [--editor CMD]
#
# Options:
#   --editor CMD   Use CMD instead of zed (e.g. "code" for VS Code)

set -euo pipefail

EDITOR_CMD="${EDITOR_CMD:-/usr/local/bin/zed}"
APP_DIR="$HOME/Applications/texsync.app"
SCRIPT_PATH="$HOME/bin/texsync-url.sh"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --editor) EDITOR_CMD="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Resolve editor to absolute path if needed
if [[ "$EDITOR_CMD" != /* ]]; then
  EDITOR_CMD="$(which "$EDITOR_CMD" 2>/dev/null || echo "$EDITOR_CMD")"
fi

echo "Installing texsync:// URL handler..."
echo "  Editor: $EDITOR_CMD"
echo "  App:    $APP_DIR"
echo "  Script: $SCRIPT_PATH"

# --- 1. Install the URL handler script ---

mkdir -p "$(dirname "$SCRIPT_PATH")"

# Detect editor family for goto-line syntax
EDITOR_BASE="$(basename "$EDITOR_CMD")"
case "$EDITOR_BASE" in
  code|cursor|codium|windsurf)
    # VS Code family: needs -g flag for goto
    OPEN_LINE="${EDITOR_CMD} -g \"\${file}:\${line}\"" ;;
  vim|nvim|vi)
    # Vim family: +line before filename
    OPEN_LINE="${EDITOR_CMD} +\"\${line}\" \"\${file}\"" ;;
  *)
    # Zed, Sublime, etc.: file:line works directly
    OPEN_LINE="${EDITOR_CMD} \"\${file}:\${line}\"" ;;
esac

cat > "$SCRIPT_PATH" << SCRIPT
#!/bin/bash
url="\$1"

# Parse texsync://file/path:line
pathline="\${url#texsync://file}"

# Split on last colon
file="\${pathline%:*}"
line="\${pathline##*:}"

${OPEN_LINE}
SCRIPT
chmod +x "$SCRIPT_PATH"

# --- 2. Build the macOS app bundle ---

# Swift source — minimal URL scheme handler
SWIFT_SRC=$(mktemp /tmp/texsync.XXXXXX.swift)
cat > "$SWIFT_SRC" << SWIFT
import Cocoa

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURL(_:withReply:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    @objc func handleURL(_ event: NSAppleEventDescriptor, withReply reply: NSAppleEventDescriptor) {
        guard let urlString = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue else { return }
        let task = Process()
        task.launchPath = "$SCRIPT_PATH"
        task.arguments = [urlString]
        try? task.run()
        // Quit after a short delay to avoid lingering
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            NSApp.terminate(nil)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {}
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
SWIFT

# Compile
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"

echo "  Compiling Swift..."
swiftc -o "$APP_DIR/Contents/MacOS/texsync" "$SWIFT_SRC" \
  -framework Cocoa -O 2>/dev/null

rm "$SWIFT_SRC"

# Info.plist
cat > "$APP_DIR/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>texsync</string>
    <key>CFBundleIdentifier</key>
    <string>com.skip.texsync</string>
    <key>CFBundleName</key>
    <string>texsync</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>TeX Sync</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>texsync</string>
            </array>
        </dict>
    </array>
    <key>LSBackgroundOnly</key>
    <true/>
</dict>
</plist>
PLIST

# --- 3. Register with Launch Services ---

echo "  Registering URL scheme..."
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -R "$APP_DIR"

echo ""
echo "Done. Test with:"
echo "  open 'texsync://file/tmp/test.tex:1'"

#!/bin/bash

# Code Review Mentat - Install Script
# This script builds the CLI and installs it globally

set -e

echo "🔨 Building code-review-mentat..."
bun run build

echo "📦 Copying sqlite-vec extension..."
cp node_modules/sqlite-vec-darwin-arm64/vec0.dylib ./vec0.dylib

echo "📂 Installing to /usr/local/bin..."

# Create install directory if it doesn't exist
INSTALL_DIR="/usr/local/bin"
sudo mkdir -p "$INSTALL_DIR"

# Copy both files
sudo cp code-review "$INSTALL_DIR/crm"
sudo cp vec0.dylib "$INSTALL_DIR/vec0.dylib"
sudo chmod +x "$INSTALL_DIR/crm"

echo ""
echo "✨ Installation complete!"
echo "You can now use 'crm' command from anywhere."
echo ""
echo "To uninstall, run: sudo rm /usr/local/bin/crm /usr/local/bin/vec0.dylib"

#!/bin/bash

# Code Review Mentat - Install Script
# This script builds the CLI and makes it globally available as 'crm'

set -e

echo "🔨 Building code-review-mentat..."
bun run build

echo "✅ Build complete!"
echo "🔗 Installing globally..."

# Make the executable file executable
chmod +x code-review

# Link it globally
npm link

echo ""
echo "✨ Installation complete!"
echo "You can now use 'crm' command from anywhere."
echo ""
echo "To uninstall, run: npm unlink -g code-review-mentat"

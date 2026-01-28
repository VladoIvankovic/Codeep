#!/bin/bash
# Codeep Installer
# Install the latest version of Codeep AI coding assistant via npm
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/VladoIvankovic/Codeep/main/install.sh | bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1"
    exit 1
}

warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Check if Node.js and npm are installed
check_dependencies() {
    if ! command -v node >/dev/null 2>&1; then
        error "Node.js is required but not installed. Install from: https://nodejs.org/"
    fi
    
    if ! command -v npm >/dev/null 2>&1; then
        error "npm is required but not installed. Install from: https://nodejs.org/"
    fi
    
    NODE_VERSION=$(node -v | sed 's/v//')
    REQUIRED_VERSION="18.0.0"
    
    if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$NODE_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then
        error "Node.js >= 18.0.0 is required. Current version: v${NODE_VERSION}"
    fi
    
    success "Node.js v${NODE_VERSION} detected"
}

# Install Codeep via npm
install_codeep() {
    info "Installing Codeep globally via npm..."
    
    if npm install -g codeep; then
        success "Codeep installed successfully!"
    else
        error "Failed to install Codeep. Try running with sudo: sudo npm install -g codeep"
    fi
}

# Verify installation
verify_installation() {
    if command -v codeep >/dev/null 2>&1; then
        INSTALLED_VERSION=$(codeep --version 2>/dev/null || echo "unknown")
        success "Codeep is ready!"
        info "Version: ${INSTALLED_VERSION}"
    else
        warning "Codeep installed but not in PATH"
        warning "You may need to restart your terminal or add npm global bin to PATH"
    fi
}

# Print usage instructions
print_usage() {
    echo ""
    echo -e "${GREEN}🚀 Get started with Codeep:${NC}"
    echo ""
    echo "  codeep              # Start chatting"
    echo "  codeep --help       # Show help"
    echo ""
    echo "Update Codeep:"
    echo "  npm update -g codeep"
    echo ""
    echo "Uninstall Codeep:"
    echo "  npm uninstall -g codeep"
    echo ""
}

# Main installation flow
main() {
    echo ""
    echo "╔═══════════════════════════════════╗"
    echo "║   Codeep Installer                ║"
    echo "║   AI Coding Assistant             ║"
    echo "╚═══════════════════════════════════╝"
    echo ""
    
    check_dependencies
    install_codeep
    verify_installation
    print_usage
}

# Run installer
main

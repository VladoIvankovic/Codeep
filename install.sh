#!/bin/bash
# Codeep Installer
# Install the latest version of Codeep AI coding assistant
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/VladoIvankovic/Codeep/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/VladoIvankovic/Codeep/main/install.sh | VERSION=1.0.0 bash
#   curl -fsSL https://raw.githubusercontent.com/VladoIvankovic/Codeep/main/install.sh | INSTALL_DIR=~/.local/bin bash

set -e

# Configuration
VERSION="${VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
REPO="VladoIvankovic/Codeep"
BINARY_NAME="codeep"

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

# Detect OS and Architecture
detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)
    
    case "$ARCH" in
        x86_64)
            ARCH="x64"
            ;;
        aarch64|arm64)
            ARCH="arm64"
            ;;
        *)
            error "Unsupported architecture: $ARCH"
            ;;
    esac
    
    case "$OS" in
        darwin)
            OS="macos"
            ;;
        linux)
            OS="linux"
            ;;
        *)
            error "Unsupported operating system: $OS"
            ;;
    esac
    
    info "Detected platform: ${OS}-${ARCH}"
}

# Get latest version from GitHub
get_latest_version() {
    if [ "$VERSION" = "latest" ]; then
        info "Fetching latest version..."
        VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/')
        
        if [ -z "$VERSION" ]; then
            error "Failed to fetch latest version from GitHub"
        fi
        
        info "Latest version: v${VERSION}"
    else
        info "Installing version: v${VERSION}"
    fi
}

# Download binary
download_binary() {
    PLATFORM_BINARY="${BINARY_NAME}-${OS}-${ARCH}"
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${PLATFORM_BINARY}"
    
    info "Downloading from ${DOWNLOAD_URL}..."
    
    TEMP_FILE="/tmp/${BINARY_NAME}-$$"
    
    if ! curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_FILE"; then
        error "Failed to download binary. Check if version v${VERSION} exists and has binaries for ${OS}-${ARCH}"
    fi
    
    success "Download complete"
}

# Install binary
install_binary() {
    # Expand tilde in INSTALL_DIR
    INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"
    
    # Create install directory if it doesn't exist
    if [ ! -d "$INSTALL_DIR" ]; then
        info "Creating directory: $INSTALL_DIR"
        mkdir -p "$INSTALL_DIR" || error "Failed to create directory: $INSTALL_DIR"
    fi
    
    # Check if we need sudo
    NEED_SUDO=false
    if [ ! -w "$INSTALL_DIR" ]; then
        NEED_SUDO=true
        warning "Need sudo permissions to install to $INSTALL_DIR"
    fi
    
    # Make executable
    chmod +x "$TEMP_FILE"
    
    # Install
    INSTALL_PATH="${INSTALL_DIR}/${BINARY_NAME}"
    
    if [ "$NEED_SUDO" = true ]; then
        info "Installing to ${INSTALL_PATH} (requires sudo)..."
        sudo mv "$TEMP_FILE" "$INSTALL_PATH" || error "Failed to install binary"
    else
        info "Installing to ${INSTALL_PATH}..."
        mv "$TEMP_FILE" "$INSTALL_PATH" || error "Failed to install binary"
    fi
    
    success "Installed to ${INSTALL_PATH}"
}

# Verify installation
verify_installation() {
    if command -v codeep >/dev/null 2>&1; then
        INSTALLED_VERSION=$(codeep --version 2>/dev/null || echo "unknown")
        success "Codeep is installed and ready!"
        info "Version: ${INSTALLED_VERSION}"
    else
        warning "Codeep installed but not in PATH"
        warning "Add ${INSTALL_DIR} to your PATH:"
        echo ""
        echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
        echo ""
        echo "Add this to your ~/.bashrc, ~/.zshrc, or ~/.profile"
    fi
}

# Print usage instructions
print_usage() {
    echo ""
    echo -e "${GREEN}🚀 Codeep installed successfully!${NC}"
    echo ""
    echo "Get started:"
    echo "  codeep              # Start chatting"
    echo "  codeep --help       # Show help"
    echo ""
    echo "Update Codeep:"
    echo "  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash"
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
    
    detect_platform
    get_latest_version
    download_binary
    install_binary
    verify_installation
    print_usage
}

# Run installer
main

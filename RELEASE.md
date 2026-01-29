# Release Process

Guide for publishing new versions of Codeep.

## Prerequisites

- npm account with publish access to `codeep` package
- 2FA enabled (you'll need OTP codes)
- Git push access to both repos:
  - `VladoIvankovic/Codeep`
  - `VladoIvankovic/homebrew-codeep`

## Release Steps

### 1. Update Version

Edit `package.json`:
```bash
# Example: 1.0.18 → 1.0.19
vim package.json  # Change version number
```

### 2. Build & Test

```bash
npm run build
npm test  # If tests exist
```

### 3. Commit & Push

```bash
git add -A
git commit -m "v1.0.19 - Description of changes"
git push
```

### 4. Publish to npm

```bash
npm publish --otp=<6-digit-code>
```

Get the OTP code from your authenticator app.

### 5. Update Homebrew Formula

```bash
./scripts/update-homebrew.sh 1.0.19
```

This script will:
- Fetch SHA256 hash from npm
- Update `homebrew-codeep/Formula/codeep.rb`
- Commit and push to GitHub

**Manual alternative:**
```bash
# Get SHA256
curl -sL https://registry.npmjs.org/codeep/-/codeep-1.0.19.tgz | shasum -a 256

# Update homebrew-codeep/Formula/codeep.rb manually
cd ~/GitHub/homebrew-codeep
# Edit Formula/codeep.rb with new version and SHA256
git add Formula/codeep.rb
git commit -m "Update codeep to v1.0.19"
git push
```

## Users Update

### via npm
```bash
npm update -g codeep
```

### via Homebrew
```bash
brew update
brew upgrade codeep
```

## Rollback

If you need to unpublish (within 72 hours):
```bash
npm unpublish codeep@1.0.19
```

**Note:** Unpublishing is discouraged. Consider publishing a patch version instead.

## Version Numbering

Follow [Semantic Versioning](https://semver.org/):

- **Major (2.0.0)**: Breaking changes
- **Minor (1.1.0)**: New features, backwards compatible
- **Patch (1.0.1)**: Bug fixes, backwards compatible

## Changelog

Update `CHANGELOG.md` with notable changes for each release.

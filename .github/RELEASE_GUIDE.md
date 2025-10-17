# Release Guide for Radium

This guide is for maintainers who want to create a new release.

## Prerequisites

- Write access to the repository
- All changes merged to `main` branch
- Updated CHANGELOG.md with release notes

## Release Process

### 1. Update Version

Update the version in `package.json`:

```bash
# For patch release (0.1.0 -> 0.1.1)
npm version patch

# For minor release (0.1.0 -> 0.2.0)
npm version minor

# For major release (0.1.0 -> 1.0.0)
npm version major
```

This automatically:
- Updates `package.json` version
- Creates a git commit
- Creates a git tag (e.g., `v0.1.1`)

### 2. Update CHANGELOG.md

Before tagging, ensure `CHANGELOG.md` has an entry for the new version:

```markdown
## [0.1.1] - 2025-10-17

### Added
- New feature X

### Fixed
- Bug Y
- Issue Z

### Changed
- Improved performance of feature W
```

### 3. Push the Tag

Push the version commit and tag to GitHub:

```bash
git push origin main
git push origin --tags
```

### 4. Automated Build

The GitHub Actions workflow will automatically:
1. Detect the new tag
2. Install dependencies
3. Compile TypeScript
4. Package the `.vsix` file
5. Create a GitHub Release with the `.vsix` attached

### 5. Verify Release

1. Go to: `https://github.com/[owner]/radium/releases`
2. Verify the new release appears
3. Download and test the `.vsix` file
4. Confirm installation instructions work

## Manual Release (Alternative)

If you need to create a release manually:

```bash
# Build the extension
npm install
npm run compile
npm run package

# Create a GitHub release manually
# 1. Go to: https://github.com/[owner]/radium/releases/new
# 2. Choose the tag (e.g., v0.1.1)
# 3. Add release notes
# 4. Upload the .vsix file
# 5. Publish release
```

## Release Checklist

Before creating a release:

- [ ] All tests pass locally
- [ ] Code is merged to `main` branch
- [ ] CHANGELOG.md is updated
- [ ] Version number follows semantic versioning
- [ ] README.md reflects current features
- [ ] Documentation is up to date

After creating a release:

- [ ] Release appears on GitHub
- [ ] `.vsix` file is attached
- [ ] Installation instructions are correct
- [ ] Test installation in clean VS Code instance
- [ ] Announce release (if applicable)

## Versioning Strategy

Follow [Semantic Versioning](https://semver.org/):

- **Major (1.0.0)**: Breaking changes, incompatible API changes
- **Minor (0.1.0)**: New features, backwards compatible
- **Patch (0.0.1)**: Bug fixes, backwards compatible

## Troubleshooting

### Build Fails on GitHub Actions

1. Check the Actions tab for error logs
2. Ensure all dependencies are in `package.json`
3. Test build locally: `npm ci && npm run compile && npm run package`

### Tag Already Exists

If you need to re-release:

```bash
# Delete local tag
git tag -d v0.1.1

# Delete remote tag
git push origin :refs/tags/v0.1.1

# Create new tag
npm version [patch|minor|major]
git push origin main --tags
```

### Release Not Created

- Check repository permissions (needs `contents: write`)
- Verify GitHub token has correct scopes
- Check workflow file syntax

## Rolling Back a Release

If a release has critical bugs:

1. Delete the release on GitHub
2. Delete the tag: `git push origin :refs/tags/v0.1.1`
3. Fix the issues
4. Create a new patch release

## Pre-releases

For beta/alpha releases:

```bash
# Create pre-release version
npm version prerelease --preid=beta
# Results in: 0.1.1-beta.0

git push origin main --tags
```

Then manually edit the GitHub Release to mark it as "pre-release".

---

**Questions?** Open an issue or contact the maintainers.


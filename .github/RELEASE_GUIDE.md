# Release Guide for Radium

This guide is for maintainers who want to create a new release.

## Automatic Release Process

Every push to `main` triggers an automatic build and release:

1. The GitHub Actions workflow runs
2. Extension is built and packaged
3. A GitHub Release is created automatically
4. Release is tagged with version from `package.json` and commit SHA (e.g., `v0.1.0-abc1234`)

## Updating the Version

To release a new version:

### 1. Update package.json

Edit the version number in `package.json`:

```json
{
  "version": "0.1.1"
}
```

### 2. Update CHANGELOG.md

Add an entry for the new version:

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

### 3. Commit and Push

```bash
git add package.json CHANGELOG.md
git commit -m "Bump version to 0.1.1"
git push origin main
```

The workflow automatically builds and releases.

### 4. Verify Release

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


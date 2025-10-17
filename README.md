# Radium

A VS Code extension that visualizes your codebase as an interactive graph and tracks changes made by LLMs.

## What It Does

Radium indexes your codebase and creates a visual map showing files, their relationships, and how they're organized into components. When working with LLMs, it tracks all changes made to your code, allowing you to review, apply, or rollback them.

## Features

- Interactive graph visualization of your codebase
- Component-based architecture view (defined in `radium.yaml`)
- Track and manage LLM-generated changes
- Impact analysis for code modifications
- Support for TypeScript, JavaScript, and Python
- Session history and rollback capability

## Usage

### Basic Setup

1. Install the extension
2. Open your project in VS Code
3. Run command: `Radium: Open Map`

The extension indexes your workspace and displays an interactive graph.

### Defining Components

Create a `radium.yaml` file in your project root:

```yaml
project-spec:
  components:
    - frontend:
        name: Frontend
        description: UI components
        files:
          - src/components/**
          - src/views/**
    
    - backend:
        name: Backend
        description: API and business logic
        files:
          - src/api/**
          - src/services/**
```

Components appear as color-coded boxes in the graph. Files are grouped by their component.

### Working with LLM Changes

1. Get a change plan from your LLM in JSON format:

```json
{
  "intent": "add authentication",
  "rationale": "Adding user login flow",
  "edits": [
    {
      "path": "src/auth.ts",
      "operations": [
        {
          "type": "replace",
          "range": { "start": [10, 0], "end": [20, 0] },
          "text": "export function authenticate(token: string) {\n  return verifyToken(token);\n}"
        }
      ]
    }
  ],
  "tests": ["tests/auth.spec.ts"],
  "risk": "medium"
}
```

2. Copy the JSON to clipboard
3. Run: `Radium: Preview LLM Plan from Clipboard`
4. Review the changes in the graph
5. Run: `Radium: Apply LLM Plan` to apply, or reject them

### Available Commands

- `Radium: Open Map` - Show the codebase graph
- `Radium: Show Changes` - View recent sessions
- `Radium: Preview LLM Plan from Clipboard` - Preview changes
- `Radium: Apply LLM Plan` - Apply previewed changes
- `Radium: Undo Last LLM Session` - Rollback a session
- `Radium: Find Impact` - Analyze impact of selected code
- `Radium: Export Session Patch` - Export session as patch file

## Configuration

Available settings:

```json
{
  "radium.indexer.maxCPU": 2,
  "radium.privacy.upload": "none",
  "radium.graph.layout": "force",
  "radium.tests.autoRun": true
}
```

## Installation

### From GitHub Releases

Download the `.vsix` file from the [Releases page](https://github.com/obregman/radium/releases).

Install via VS Code:
1. Extensions view → `...` menu → "Install from VSIX..."
2. Select the downloaded file

Or via command line:
```bash
code --install-extension radium-0.1.0.vsix
```

**Having installation issues?** See [TEST-INSTALLATION.md](TEST-INSTALLATION.md) for detailed debugging steps.

### Building from Source

**Requirements:** Node.js 20 or later

```bash
npm install
npm run compile
npm run package
```

This creates a `.vsix` file you can install.

## Automatic Releases

Every push to `main` automatically:
1. Builds the extension
2. Creates a `.vsix` package
3. Publishes a GitHub Release with the build

The release is tagged with the version from `package.json` and the commit SHA.

## Documentation

- [Architecture](docs/architecture.md)
- [Usage Guide](docs/usage-guide.md)
- [radium.yaml Format](docs/radium-yaml.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

MIT

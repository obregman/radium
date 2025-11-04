# Radium

A VS Code extension that visualizes your codebase as an interactive graph and tracks changes made by LLMs.

## What It Does

Radium indexes your codebase and creates a visual map showing files, their relationships, and how they're organized into components. When working with LLMs, it tracks all changes made to your code, allowing you to review, apply, or rollback them.

## Features

- Interactive graph visualization of your codebase
- Component-based architecture view (defined in `.radium/radium-components.yaml`)
- Track and manage LLM-generated changes
- Real-time file change monitoring with visual diff display
- Automatic change detection every 1 minute when component view is open
- Impact analysis for code modifications
- Support for TypeScript, JavaScript, Python, and C#
- Session history and rollback capability

## Usage

### Basic Setup

1. Install the extension
2. Open your project in VS Code
3. Run command: `Radium: Open Map`

The extension indexes your workspace and displays an interactive graph.

### Multi-Root Workspaces

Radium supports VS Code multi-root workspaces. When you have multiple projects in your workspace:

- If only one project has a `.radium` directory, Radium automatically uses it
- If multiple projects have `.radium` directories, you'll be prompted to select which one to use
- If no projects have `.radium` directories, Radium uses the first workspace folder


### Available Commands

- `Radium: Component View` - Show the codebase graph
- `Radium: Features Map` - Visualize features and their relationships
- `Radium: Real-time File Changes` - Monitor file changes in real-time with visual diff display
- `Radium: Real-time Symbol Visualization` - Visualize code changes as symbols (functions, classes) with call relationships

### Real-time File Changes

The Real-time File Changes view monitors your workspace for file modifications and displays them visually:

- **File boxes** appear when a file changes, highlighted for 5 seconds
- **New files** are marked with an asterisk (*) after the filename
- **Diff boxes** show the actual code changes with syntax highlighting
- **Auto-focus on changes**: Automatically scrolls to and highlights the latest change with animated indicators
- **Connection lines** link the file to its diff display
- **Hover to keep open**: Diff boxes stay visible when you hover over them
- **Pan and zoom**: Navigate the view with mouse drag and scroll wheel
- Automatically tracks source files (TypeScript, JavaScript, Python, etc.)
- Displays git diffs for each change

To use: Run `Radium: Real-time File Changes` from the command palette.

### Symbol Changes

The Symbol Changes view provides an intuitive visualization of code changes using symbols instead of raw diffs:

**Symbol Types:**
- **Function boxes** (teal, rounded) - New or modified functions with change details (+/- lines)
- **Class boxes** (blue, rounded) - New or modified classes  
- **Constructor boxes** (purple, rounded) - New or modified constructors
- **Method boxes** (purple, rounded) - New or modified methods
- **Interface boxes** (light blue, dashed, rounded) - New or modified interfaces
- **Variable boxes** (yellow, rounded) - New or modified variables with values
- **Constant boxes** (gold, rounded) - New or modified constants with values
- **File boxes** (gray, rounded) - Fallback when no symbols are detected in a changed file

Each symbol box displays the symbol type (FUNCTION, CLASS, etc.) at the top for easy identification.

**Change Detection:**
- ✅ **Adding a function** - Shows as new function box with green pulse
- 🔧 **Changing a function** - Shows modified function with yellow pulse and +/- stats
- 📦 **Adding variables** - Shows new variable/constant with initial value
- 🔄 **Changing variable values** - Shows value change with orange pulse (old → new)
- 📋 **Creating interfaces/types** - Shows new interface with dashed border
- 🔗 **Adding function calls** - Animated arrows connect caller to callee

**Visual Features:**
- **Call connectors** - Animated curved arrows showing function calls between symbols
- **Change indicators** - Pulsing animations: green (added), yellow (modified), orange (value changed), red (deleted)
- **Details display** - Shows change statistics and values directly on symbols
- **File grouping** - Symbols are organized by file with clear labels
- **Pan and zoom** - Navigate the view with mouse drag and scroll wheel

This mode makes complex changes easy to understand at a glance by showing the structural changes to your code rather than line-by-line diffs.

To use: Run `Radium: Symbol Changes` from the command palette.

#### Ignoring Files

You can exclude files and directories from both the Real-time File Changes and Symbol Changes views by creating a `radiumignore` file in the `.radium` directory:

```
# .radium/radiumignore

# Ignore generated files
*.g.cs
*.generated.ts

# Ignore directories
debug/
build/
temp/

# Ignore specific files
config.local.json
```

Patterns supported:
- **Extensions**: `*.g.cs` - ignores all files ending with `.g.cs`
- **Directories**: `debug/` - ignores the `debug` directory and all files within it
- **Specific files**: `config.local.json` - ignores this exact file
- **Comments**: Lines starting with `#` are ignored
- **Glob patterns**: Supports wildcards like `**/*.test.ts`

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


**Requirements:** Node.js 20 or later

```bash
npm install
npm run compile
npm run package
```

This creates a `.vsix` file you can install.

## Prompt

Add this instruction to your project to trigger the generation of the necessary yaml files:

```markdown

The VSCode add-on Radium requires the following files to be created in the .radium directory in the project root folder:
1. radium-components.yaml - describes a logical visualization of the codebase.
2. radium-features.yaml - describes the different feature flows

Review the project code and generate the files in the .radium directory.

1. radium-components.yaml syntax:

spec:
  components:
    - views:
        name: Views
        description: UI components and visualization panels
        files:
          - src/views/view-manager.ts
        external:
          
    - store:
        name: Data Store
        description: Database schema and storage adapter
        files:
          - src/store/db-schema.ts
        external:
          - type: PostgreSQL
            name: MainDB
            description: Stores the user data
            usedBy:
              - src/store/db-schema.ts

Guidelines:
- Keep the description detailed but under 200 words
- External sources include: Cloud services (RDS, S3, SQS, etc.), Data files, external API or service, etc.
- For each external source, specify which files use it directly (actually integrate with it) in the 'usedBy' array (file paths relative to project root)
- The usedBy field is optional - if not specified, the external source will only be connected to the component

2. radium-features.yaml syntax

spec:
  features:
      - new_customer:
        name: Add a new customer to the system
        flow:
        - type: user
          name: The user clicks on add new user
          description: The user clicks on add new customer
          impl: src/components/AddUserButton.tsx
        - type: window
          name: App displays the "new customer" screen
          description: Shows the "new customer" screen to the user
          impl: src/screens/NewCustomerScreen.tsx
        - type: user
          name: The user fills the new customer's details
          description: The user fills customer name, address, phone number and email
          impl: src/forms/CustomerForm.tsx

Guidelines:
- Each flow step can optionally include an 'impl' field pointing to the main file that implements this step
- The impl path should be relative to the project root
```

## License

MIT

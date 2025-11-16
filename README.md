# Radium

A VS Code extension that visualizes your codebase as an interactive graph and tracks changes made by LLMs.

## What It Does

Radium indexes your codebase and creates a visual map showing files, their relationships, and how they're organized into components. When working with LLMs, it tracks all changes made to your code, allowing you to review, apply, or rollback them.

## Features

- Interactive graph visualization of your codebase
- Component-based architecture view (defined in `.radium/radium-components.yaml`)
- Track and manage LLM-generated changes
- Real-time file change monitoring with visual diff display
- Automatic change detection every 1 minute when codebase map is open
- Impact analysis for code modifications
- Support for TypeScript, JavaScript, Python, C# (including `.xaml.cs` files), and Go
- Cross-platform support (macOS, Linux, Windows)
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

- `Radium: Codebase Map` - Show the codebase graph
- `Radium: Features Map` - Visualize features and their relationships
- `Radium: Real-time File Changes` - Monitor file changes in real-time with visual diff display
- `Radium: Real-time Symbol Visualization` - Visualize code changes as symbols (functions, classes) with call relationships
- `Radium: Non-committed Git Changes` - Visualize all uncommitted git changes as symbols

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
- **Function boxes** (light green) - New or modified functions with change details (+/- lines)
- **Class boxes** (light blue) - New or modified classes  
- **Struct boxes** (plum) - New or modified struct data types (C#, Go)
- **Constructor boxes** (light green) - New or modified constructors
- **Method boxes** (light green) - New or modified methods
- **Interface boxes** (yellow, dashed) - New or modified interfaces
- **Type boxes** (yellow, dashed) - New or modified type aliases
- **Variable boxes** (gray) - New or modified variables with values
- **Constant boxes** (gray, thicker border) - New or modified constants with values
- **File boxes** (light blue) - Fallback when no symbols are detected in a changed file, or when files are deleted

Each symbol box displays the symbol type (FUNCTION, CLASS, etc.) at the top for easy identification.

**Change Detection:**
- ✅ **Adding a function** - Shows as new function box with green pulse
- 🔧 **Changing a function** - Shows modified function with yellow pulse and +/- stats
- ❌ **Deleting a function** - Shows deleted function with red pulse and faded appearance
- 📦 **Adding variables** - Shows new variable/constant with initial value
- 🔄 **Changing variable values** - Shows value change with orange pulse (old → new)
- 📋 **Creating interfaces/types** - Shows new interface with dashed border
- 🗑️ **Deleting files** - Shows deleted file box with red pulse
- 🔗 **Adding function calls** - Animated arrows connect caller to callee

**Visual Features:**
- **Call connectors** - Animated curved arrows showing function calls between symbols
- **Change indicators** - Pulsing animations: green (added), yellow (modified), orange (value changed), red (deleted)
- **Details display** - Shows change statistics and values directly on symbols
- **File grouping** - Symbols are organized by file with clear labels
- **Pan and zoom** - Navigate the view with mouse drag and scroll wheel

This mode makes complex changes easy to understand at a glance by showing the structural changes to your code rather than line-by-line diffs.

To use: Run `Radium: Symbol Changes` from the command palette.

### Non-committed Git Changes

The Non-committed Git Changes view works exactly like Symbol Changes but shows all uncommitted changes in your git repository:

**What it shows:**
- All modified files (staged and unstaged)
- New files that haven't been committed
- Symbol-level changes compared to the last commit (HEAD)

**How it works:**
- Compares current working directory against git HEAD
- Displays changes using the same symbol visualization as Symbol Changes
- Shows functions, classes, methods, variables, and other symbols that were added or modified
- Includes visual call relationships between symbols

This is useful for reviewing all your work before committing, understanding the scope of changes across multiple files, or getting a high-level overview of your current work in progress.

To use: Run `Radium: Non-committed Git Changes` from the command palette.

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

## Troubleshooting

### Symbol Changes Not Detected

If changes in your code are not being detected in the Symbol Changes view:

1. **Check the Output Panel**: View → Output → Select "Radium" to see detailed logs
2. **For C# files**: Look for logs showing:
   - `[Radium Parser] Parsing ... as csharp` - confirms file is being parsed
   - `[C# Parser] Found method: ...` - shows detected symbols
   - `[Radium Parser] File stats: ... lines, CRLF: true/false` - file characteristics
3. **Try refreshing**: Close and reopen the Symbol Changes panel to clear caches
4. **Check radiumignore**: Make sure your file isn't being ignored by patterns in `.radium/radiumignore`

### Parser Errors

If you see "Tree-sitter parse failed" errors in the output:

1. **Check the detailed logs** - The extension now provides comprehensive diagnostics:
   - File size and line count
   - Line ending type (CRLF vs LF)
   - Presence of BOM (Byte Order Mark)
   - Unicode character detection
   - First and last 100 characters of the file
   
2. **Automatic retry** - The parser automatically retries with a fresh instance if the first parse fails

3. **Fallback extraction** - If tree-sitter parsing fails completely, the extension falls back to regex-based symbol extraction

4. **Common issues**:
   - **Large files (>150KB)**: May cause tree-sitter issues on some systems
   - **BOM in UTF-8 files**: Automatically detected and removed
   - **Mixed line endings**: Handled correctly on both Windows and Unix systems

See [docs/lambda-detection-investigation.md](docs/lambda-detection-investigation.md) for detailed information about lambda expression detection in C#.

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
        area: Customer Management
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
- Each feature should have an 'area' field to group related features (e.g., "Authentication", "Reporting", "User Management")
- Each flow step can optionally include an 'impl' field pointing to the main file that implements this step
- The impl path should be relative to the project root
```

## License

MIT

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

## Demos

Want to see what Radium looks like before installing? Check out the standalone demos:

- **[Symbol Changes Demo](demo/symbol-changes-demo.html)** - Real-time symbol tracking visualization
- **[File Structure Demo](demo/file-structure-demo.html)** - Table-based directory hierarchy view

Simply open any HTML file in your browser. No installation required!

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
- `Radium: Files Map` - View files as size-weighted rectangles with relationship arrows
- `Radium: File Structure` - View files organized in a table by directory hierarchy
- `Radium: Real-time Symbol Visualization` - Visualize code changes as symbols (functions, classes) with call relationships
- `Radium: Semantic Changes` - Track semantic changes by category (logic, API calls, file I/O, etc.)

### Files Map

The Files Map provides a bird's-eye view of your entire codebase structure, showing files as rectangles sized by their line count and organized by directory:

**Color Modes:**
Toggle between three visualization modes using the button bar at the top:
- **Color by Parent Directory** (default): Each directory gets a unique color from 30 predefined colors
  - Colors assigned based on hash of directory name (consistent across sessions)
  - Directory boxes and their files share the same color
  - Makes it easy to visually group files by their directory
  - Same directory always gets the same color
- **Color by Symbol Use**: Files colored by how many symbols they export
  - Grey: 0 exports (isolated files)
  - Yellow: 1-3 exports (lightly connected)
  - Yellow-green: 4-6 exports (moderately connected)
  - Light green: 7-9 exports (well connected)
  - Green: 9+ exports (highly connected, potential core modules)
- **Color by Code Smell**: Files colored by their code smell score (0-100)
  - Green (#52B788): Score 0-20 - Clean code
  - Light Green (#98D8C8): Score 21-40 - Minor issues
  - Yellow (#F7DC6F): Score 41-60 - Moderate concerns
  - Orange (#FFA07A): Score 61-80 - Significant smells
  - Red (#E63946): Score 81-100 - High smell density
  - Score is calculated from: file length, function count, average/max function length, nesting depth, and import count

**Visual Elements:**
- **File Rectangles**: Size proportional to line count (150-350px width, 2:1 aspect ratio, 3000 lines = 350px)
  - Shows filename and line count in a rounded badge
  - Click to open file in editor
  - Drag to reposition
- **Directory Boxes**: White rectangles with gray borders
  - Size scales inversely with directory depth:
    - Depth 0 (root): 600px width, 72px font
    - Depth 1: 450px width, 48px font
    - Depth 2: 320px width, 28px font
    - Depth 3+: 240px width, 18px font
  - Show full directory path with depth-scaled font size
  - All directories in the hierarchy are shown (even those without direct files)
  - Connected hierarchically with bright blue lines (parent → child directories)
  - Connected to their files with gray lines
  - Directory clusters are gathered together for better organization
  - Movable to organize the layout

**Layout:**
- Force-directed physics simulation clusters files around their directories
- Directory hierarchies are connected and clustered together
- Directory groups are well-separated with distinct spacing
- Automatic collision detection prevents overlap
- Files are pulled toward their parent directory
- Pan and zoom to navigate large codebases
- Drag nodes to reposition (simulation continues)

**Interactions:**
- **Hover to zoom**: Hover over any file or directory box to zoom it to 2x size
- **Click to open**: Click on file boxes to open them in the editor
- **Drag to move**: Drag any node to reposition it manually
- **Pan and zoom**: Use mouse drag and scroll wheel to navigate
- **Smart zoom**: When zooming out (scale < 1), directory boxes and font sizes automatically increase to maintain readability

**Use Cases:**
- Understand project structure at a glance
- Identify highly connected files (green) as potential core modules
- Find isolated or orphaned files (grey) that might need better integration
- Compare relative file sizes across the project
- Visualize directory organization and file distribution
- Identify files with code smells that may need refactoring (use "Color by Code Smell" mode)

To use: Run `Radium: Files Map` from the command palette.

### File Structure

The File Structure view provides a graphical visualization of your codebase, organizing files by their directory hierarchy in a clean, visual layout:

**Layout:**
- **Root Box**: Large gray box at the top showing the workspace/project name
- **Category Boxes**: Purple boxes for each top-level directory (Views, Services, Utilities, Data, etc.)
- **Subdirectory Boxes**: Dark boxes with blue borders containing groups of files
- **Files**: Listed as clickable text within their subdirectories

**Visual Features:**
- Graphical boxes representing the directory hierarchy
- Color-coded elements (gray root, purple categories, blue subdirectories)
- Zoom in/out with mouse wheel
- Pan by clicking and dragging
- Files are clickable to open in the editor
- Organized in columns for easy scanning

**Interactions:**
- **Zoom**: Use mouse wheel to zoom in/out
- **Pan**: Click and drag to move around
- **Click files**: Click any file name to open it in the editor
- **Hover**: Boxes highlight on hover

**Use Cases:**
- Get a visual overview of project organization
- Understand directory structure at a glance
- Navigate to files by their logical location
- Compare file distribution across different modules
- Identify which directories contain the most files
- Zoom in to see details or zoom out for the big picture

To use: Run `Radium: File Structure` from the command palette.

### Symbol Changes

The Symbol Changes view provides an intuitive visualization of code changes using symbols instead of raw diffs:

**Symbol Types:**
- **Functions** - Functions, methods, constructors
- **Classes** - Classes, structs
- **Interfaces** - Interfaces (dashed border)
- **Types** - Type aliases (dashed border)
- **Variables** - Variables and constants (constants have thicker border)
- **Files** - Fallback when no symbols are detected in a changed file, or when files are deleted

Each symbol box displays the symbol type (FUNCTION, CLASS, etc.) at the top for easy identification.

**Color Coding by Change Type:**
- 🟡 **Yellow** - New symbols (added)
- 🟢 **Light Green** - Modified symbols (changed)
- ⚫ **Dark Gray** - Deleted symbols (removed, with light gray text)

**Change Detection:**
- ✅ **Adding a function** - Shows as yellow box with pulsing animation
- 🔧 **Changing a function** - Shows as light green box with pulsing animation and +/- stats
- ❌ **Deleting a function** - Shows as dark gray box with light gray text and pulsing animation
- 📦 **Adding variables** - Shows as yellow box with initial value
- 🔄 **Changing variable values** - Shows as light green box (old → new)
- 📋 **Creating interfaces/types** - Shows as yellow box with dashed border
- 🗑️ **Deleting files** - Shows as dark gray file box with light gray text
- 🔗 **Adding function calls** - Animated arrows connect caller to callee

**Visual Features:**
- **Call connectors** - Animated curved arrows showing function calls between symbols
- **Change indicators** - Pulsing border animations on all symbols
- **Color-coded changes** - Yellow (new), light green (changed), dark gray (deleted)
- **Details display** - Shows change statistics and values directly on symbols
- **File grouping** - Symbols are organized by file with clear labels
- **Pan and zoom** - Navigate the view with mouse drag and scroll wheel

This mode makes complex changes easy to understand at a glance by showing the structural changes to your code rather than line-by-line diffs.

To use: Run `Radium: Symbol Changes` from the command palette.

### Semantic Changes

The Semantic Changes view provides a different perspective on code changes by categorizing them based on their semantic meaning rather than structural changes to symbols. This view helps you understand what your code is doing at a higher level.

**Change Categories:**
- 🔵 **Logic Change** - Modified conditionals, loops, operators, return statements
- 🟢 **Add Logic** - New control flow structures (if/for/while/switch/try-catch)
- 🔴 **Delete Code** - Removed lines containing logic
- 🟠 **Read External** - File I/O, database queries, configuration reads
- 🟣 **Call API** - HTTP requests, GraphQL, gRPC, WebSocket calls
- 🔴 **Expose API** - Route definitions, endpoint decorators, API exports

**Visual Features:**
- **Color-coded badges** - Each category has a distinct color for quick identification
- **Latest change highlighted** - Most recent change is prominently displayed
- **Change history** - Expandable list of previous changes per file
- **Clickable locations** - Click file path and line number to jump to the code
- **Real-time monitoring** - Automatically detects changes as you code
- **Session-based tracking** - Changes are grouped by session (cleared on "Clear All")

**Pattern Detection:**
The view uses intelligent pattern matching to detect:
- **Logic changes**: Modified if/else, loops, operators, return statements
- **API calls**: fetch(), axios, http requests, GraphQL queries, WebSocket connections
- **External reads**: File operations (fs.readFile, open), database queries (SELECT, find), config access (process.env)
- **API exposure**: Route handlers (app.get, @Get), exports (export function, module.exports)

**Use Cases:**
- Review what types of changes you've made during a coding session
- Identify when you've added new API calls or external dependencies
- Track logic modifications separately from structural changes
- Understand the semantic impact of your changes at a glance

To use: Run `Radium: Semantic Changes` from the command palette.

#### Ignoring Files

You can exclude files and directories from indexing and all views (Real-time File Changes, Symbol Changes, Files Map, etc.) by creating a `radiumignore` file in the `.radium` directory:

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

Files matching these patterns will be completely excluded from:
- File indexing
- Symbol tracking
- All visualization views (Files Map, Codebase Map, etc.)
- Change detection panels

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

1. **Automatic fallback** - The extension automatically falls back to regex-based symbol extraction when tree-sitter fails

2. **Fresh parser instances** - Each file is parsed with a fresh parser instance to avoid state corruption issues

3. **Enhanced regex extraction** - The fallback parser detects:
   - Functions (including arrow functions)
   - Classes and interfaces
   - Type aliases and enums
   - Variables and constants
   - Exported symbols

4. **Common issues**:
   - **Large files (>1MB)**: Automatically skipped to avoid memory issues
   - **BOM in UTF-8 files**: Automatically detected and removed
   - **Mixed line endings**: Handled correctly on both Windows and Unix systems
   - **Parser state corruption**: Fixed by creating fresh parser instances for each file

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

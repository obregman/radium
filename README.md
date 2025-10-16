# Radium - Vibe Coding Visualizer

A VS Code extension that keeps "vibe coders" grounded in the codebase by rendering a living, zoomable map of the project and visually highlighting **everything the LLM touches**.

## 🎯 Features

- **📊 Living Codebase Map**: Interactive, force-directed graph visualization with color-coded components
- **🎨 Component Architecture View**: Define logical components in `radium.yaml` for clean architectural visualization
- **🌈 Persistent Colors**: Each component gets a unique color (hashed from name) that persists across sessions
- **🤖 LLM Change Tracking**: Track and visualize all LLM-originated edits with overlays, diffs, and timelines
- **🔍 Smart Indexing**: Real-time parsing of TypeScript, JavaScript, and Python using tree-sitter
- **🌳 Code Navigation**: Tree views for code slices, recent sessions, and issues
- **🔄 Change Orchestration**: Preview, apply, and rollback LLM-generated changes with atomic operations
- **📈 Impact Analysis**: Understand dependencies, call graphs, and blast radius before making changes
- **⚡ Real-time Updates**: File system watching with incremental re-indexing
- **🧪 Test Integration**: Track affected tests and run them automatically

## 🚀 Getting Started

1. Install the extension from the marketplace
2. Open a workspace folder
3. Run command: **Radium: Open Map**
4. Watch as Radium indexes your codebase

The extension will automatically start indexing your workspace in the background.

## 📋 Commands

- **Radium: Open Map** - Open the interactive codebase visualization
- **Radium: Show Changes** - View recent LLM sessions and changes
- **Radium: Preview LLM Plan from Clipboard** - Preview changes from LLM plan JSON
- **Radium: Apply LLM Plan** - Apply previewed changes to workspace
- **Radium: Undo Last LLM Session** - Rollback the last session
- **Radium: Explain Selection** - Get LLM explanation of selected code
- **Radium: Find Impact** - Analyze impact of changing a symbol
- **Radium: Export Session Patch** - Export session as a patch file

## 🎨 Views

### Code Slices
Browse your codebase organized by files and symbols (classes, functions, interfaces)

### Recent Sessions
Track all LLM and user sessions with detailed change history

### Issues
View static analysis results and problems detected during indexing

## ⚙️ Configuration

### VS Code Settings

```json
{
  "vibe.indexer.maxCPU": 2,
  "vibe.privacy.upload": "none",
  "vibe.graph.layout": "force",
  "vibe.layers.default": ["structure", "relations", "changes"],
  "vibe.tests.autoRun": true
}
```

### Component-Based Visualization (radium.yaml)

Create a `radium.yaml` file at your project root to define custom logical components for the map visualization:

```yaml
project-spec:
  components:
    - frontend:
        name: Frontend
        description: React UI components and views
        files:
          - src/components/**
          - src/views/**
    
    - backend:
        name: Backend
        description: API and business logic
        files:
          - src/api/**
          - src/services/**
    
    - database:
        name: Database
        description: Data models and storage
        files:
          - src/models/**
          - src/store/**
```

**Features:**
- **Color-coded components**: Each component gets a unique, persistent color based on its name hash
- **Visual consistency**: Files inherit their component's color as a border
- **Large, prominent boxes**: Component boxes are twice the size of regular elements for better visibility
- **Connection lines**: All lines from a component match its color for easy tracing
- Define logical components that map to multiple directories
- Add descriptions for component tooltips
- Support for glob patterns (`**`, `*`) in file paths
- Without `radium.yaml`, files are displayed without directory grouping

See `radium.yaml.example` for a complete example.

## 🔧 LLM Plan Format

To apply LLM changes, copy a JSON plan to clipboard and run **Radium: Preview LLM Plan**:

```json
{
  "intent": "add feature",
  "rationale": "Adding new authentication flow",
  "edits": [
    {
      "path": "src/auth.ts",
      "operations": [
        {
          "type": "replace",
          "range": { "start": [10, 0], "end": [20, 0] },
          "text": "// New code here"
        }
      ]
    }
  ],
  "tests": ["tests/auth.spec.ts"],
  "risk": "medium"
}
```

## 🗺️ Graph Visualization

The map uses D3.js to render an interactive force-directed graph with a **clean, architecture-focused view**:

### Visual Elements

**Components** (requires `radium.yaml`)
- Large, prominent boxes (2x standard size)
- Unique persistent colors generated from component name hash
- 28px bold text labels for maximum readability
- Hover to see component descriptions

**Files**
- Standard-sized boxes with file names
- Border color matches parent component for visual grouping
- Click to navigate to the file

**Connection Lines**
- Component-to-file lines: Match the component's color
- File-to-file import lines: Match the source file's component color
- Width and opacity indicate relationship strength
- Create visual "flow" showing architectural boundaries

### Interaction
- **Hover** for details and mini-diffs
- **Click** to navigate to code
- **Drag** nodes to rearrange
- **Zoom/Pan** to explore
- **Mouse wheel** to zoom in/out

### What's NOT Shown
To keep the visualization clean and focused on architecture:
- ❌ Directory nodes (only components and files)
- ❌ Individual classes, interfaces, types
- ❌ Function nodes
- Focus is on **file-level relationships** and **component boundaries**

### Legend
- 🎨 **Component** - Color-coded by name hash (persistent across sessions)
- 📄 **File** - Border color matches parent component
- 🔗 **Lines** - Component color shows architectural flow

## 📊 Supported Languages

- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`)
- Python (`.py`)

More languages coming soon!

## 🛡️ Privacy & Security

- **Local by default** - No code leaves your machine
- **Optional cloud indexing** - Control with `vibe.privacy.upload`
- **Sandboxed edits** - All LLM changes go through orchestrator
- **Secrets hygiene** - Automatically redacts sensitive data

## 🧪 Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode
npm run watch

# Package extension
npm run package
```

## 📦 Building from Source

```bash
npm install
npm run compile
npm run package
```

This creates a `.vsix` file you can install manually.

## 🤝 Contributing

Contributions welcome! This is a production-ready extension designed to handle real-world codebases.

## 📄 License

MIT

## 🔮 Roadmap

- **v0.1 (MVP)**: TS/JS + Python indexing, map + session overlays, basic diffs
- **v0.2**: Call graph analysis, impact analysis, test runner integration
- **v0.3**: Go/Java support, coverage ingestion, hotspots, replay timeline
- **v0.4**: Model-agnostic LLM adapters, policy guardrails, cloud index

## 💡 Use Cases

- **LLM Collaboration**: Track what the AI changed and why
- **Code Review**: Visualize impact of changes before committing
- **Onboarding**: Explore unfamiliar codebases with interactive maps
- **Refactoring**: Understand dependencies before making changes
- **Architecture**: See the big picture of your system

---

**Stay in flow, never lose the plot.**


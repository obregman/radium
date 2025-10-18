# Change Log

All notable changes to the Radium extension will be documented in this file.

## [Unreleased]

### Fixed
- **CRITICAL: Extension activation failure** - All production dependencies are now properly bundled in the VSIX
  - Previous builds excluded ALL node_modules, causing extension to fail on require() calls
  - Removed `node_modules/**` exclusion from .vscodeignore
  - VSIX now includes all 9 production dependencies: sql.js, chokidar, fast-diff, js-yaml, tree-sitter, and tree-sitter language parsers
  - VSIX size increased to ~12.5MB (expected - includes all runtime dependencies)
  - This fixes "command not found" errors and extension not activating
- WASM binary is loaded directly into memory (more reliable than locateFile)
- Added detailed logging for troubleshooting initialization issues
- Command registration now handles initialization gracefully
- Improved error handling during store initialization

### Added
- **Manual re-index command**: `Radium: Re-index Workspace` to manually trigger indexing
- **radium-components.yaml Configuration**: Define custom logical components for map visualization
  - Component-based grouping overrides default directory structure
  - Support for glob patterns in file paths (`**`, `*`)
  - Component descriptions shown as tooltips
  - Components appear as color-coded boxes in the visualization
  - **External objects support**: Define external dependencies (databases, APIs, services) for each component
    - External objects displayed as white rounded rectangles with black text
    - Connected to their parent components with colored edges
    - Includes type, name, and description fields
  - See `radium-components.yaml.example` and `docs/radium-yaml.md` for details
- **radium-features.yaml Configuration**: Visualize product features and their relationships
  - New `Radium: Features Map` command to open features visualization
  - Shows features, their status (planned/in-progress/completed/deprecated), and dependencies
  - Maps features to components from radium-components.yaml
  - Tracks feature ownership and descriptions
  - See `radium-features.yaml.example` and `docs/radium-features.md` for details
- Added `RadiumConfigLoader` class for parsing and managing YAML configuration
- Added `FeaturesConfigLoader` class for parsing features configuration
- Added `FeaturesMapPanel` view for interactive features visualization
- Component nodes in graph with enhanced styling and collision detection

### Changed
- **Simplified Visualization**: Map now only displays components and files
  - Removed individual class, interface, type, and function nodes from the graph
  - Removed directory nodes - only components and files are shown
  - Focus on high-level architecture and file relationships
  - Cleaner, less cluttered visualization
  - Import relationships shown between files instead of individual symbols
- **Enhanced Component Visualization**:
  - Component boxes are now twice as large for better visibility
  - Each component has a unique persistent color generated from its name hash
  - Files inherit their component's color as a border
  - Color-coding makes it easy to identify which files belong to which component

## [0.1.0] - 2025-10-13

### Added
- Initial release of Radium
- Interactive codebase visualization with D3.js force-directed graph
- Real-time indexing for TypeScript, JavaScript, and Python
- LLM Change Orchestrator with preview and apply workflow
- SQLite-based graph store for nodes, edges, files, sessions, and changes
- Tree views for code slices, recent sessions, and issues
- Commands for map navigation, change tracking, and impact analysis
- Git integration for tracking sessions with commits
- Impact analysis with fan-in/fan-out and transitive dependencies
- Session rollback capability
- Export session patches
- Configuration options for indexing, privacy, and graph layout

### Features
- 📊 Living codebase map with zoom and pan
- 🤖 Track all LLM-originated edits
- 🔍 Smart indexing with tree-sitter
- 🌳 Code navigation tree views
- 🔄 Atomic change orchestration
- 📈 Impact analysis before changes
- ⚡ Real-time file watching
- 🎨 Visual overlays and session heatmaps

### Supported Languages
- TypeScript (`.ts`, `.tsx`)
- JavaScript (`.js`, `.jsx`)
- Python (`.py`)


# Change Log

All notable changes to the Radium extension will be documented in this file.

## [Unreleased]

### Added
- **Function Detection Tests**: Comprehensive unit tests for function detection in semantic changes view
  - Tests for TypeScript function detection (declarations, arrow functions, async functions, class methods, getters/setters)
  - Tests for C# function detection (methods, async methods, static/virtual/override methods)
  - Tests for function context extraction from diff hunk headers
  - Tests for both function additions and deletions
  - Tests for edge cases (nested functions, generics, function replacements)
  - All tests verify that function names are correctly extracted and tracked

### Fixed
- **Semantic Changes Layout**: Fixed issue where file boxes could overlap when their height increases
  - File boxes now properly reposition when content changes cause height adjustments
  - Uses actual rendered height (`offsetHeight`) instead of style height for accurate positioning
  - Repositioning happens after DOM updates complete to ensure correct measurements
  - Boxes in the same column shift down appropriately to maintain proper spacing

### Added
- **Comment Display for XAML/XAML.cs Files**: Comments are now shown even when symbols cannot be extracted
  - Comments from XAML files (HTML-style `<!-- -->`) are extracted and displayed
  - Comments from XAML.cs files (C# style `//` and `/* */`) are extracted and displayed
  - Applies to both realtime mode and git changes mode
  - Useful for files where parser may not extract symbols but comments provide context
  - Comments appear as purple overlays below the file container

### Fixed
- **FILE Fallback Box Logic**: Improved fallback behavior for files with no symbols detected in current change
  - FILE fallback boxes are now only shown if the file has **never** had symbols detected
  - If a file previously had symbols but the current change doesn't affect any symbols, no FILE box is shown
  - Prevents redundant FILE boxes appearing alongside actual symbol boxes
  - Tracks file symbol history using `filesWithSymbols` set, cleared on "Clear All"
- **C# Parser Duplicate Symbol Detection**: Fixed issue where methods in classes, interfaces, structs, and records were being extracted twice
  - Methods were appearing with both correct FQN (e.g., `MyGame.GameWindow.OnStartButtonClick`) and incorrect FQN (e.g., `MyGame.OnStartButtonClick`)
  - Added `return` statements after processing class/interface/struct/record bodies to prevent double recursion
  - Fixes issue where changes to functions in `sealed partial class` (like `GameWindow.xaml.cs`) were not properly detected
  - All C# container types now properly scope their child symbols
  - Added comprehensive test for sealed partial classes with event handlers
- **Comment Popup Improvements**: Enhanced comment overlays in Symbol Changes view
  - Duration now scales dynamically from 4-8 seconds based on text length
  - Popup remains open when user hovers over it (prevents premature disappearing)
  - Changed background color to light purple (rgba(216, 191, 216, 0.95))
  - Text color changed to black for better contrast
  - Leading forward slashes (`//`, `/`, `/*`, `*`) are now automatically removed from comment lines
  - **Positioning**: Comment popups appear below the file container with 20px gap
  - **Timing fix**: Popup display is delayed until after layout repositioning completes (60ms) to use accurate container dimensions
- **C# Constructor Detection**: Added support for detecting C# constructors in the parser
  - Constructor declarations are now properly recognized as `constructor` symbols
  - Fixes issue where changes to C# constructors were categorized as FILE changes instead of symbol-level changes
  - Added comprehensive test suite for C# constructor parsing including overloaded and static constructors
  - Verified support for `.xaml.cs` files (compound file extensions)
- **Windows Path Support**: Fixed cross-platform path handling issues
  - File labels now correctly show only the filename on Windows (was showing full path)
  - Added `getFileName()` and `splitPath()` utilities to normalize Windows backslashes to forward slashes
  - Parser correctly handles Windows paths like `C:\Users\Project\MainPage.xaml.cs`
  - Added test to verify Windows path parsing
- **Debug Logging**: Added specific logging for `.xaml.cs` file detection to help troubleshoot parsing issues
- **Tooltip Positioning**: Tooltips in Symbol Changes view now appear near the cursor instead of fixed to the symbol box
  - Makes tooltips easier to access and read
  - Accounts for zoom and pan transformations

### Verified
- **Symbol Height Scaling**: Confirmed that symbol box height increases with more lines changed
  - Uses logarithmic scaling from 30px (1 line) to 120px (100+ lines)
  - Maintains 10:3 aspect ratio across all sizes
  - Added comprehensive unit test demonstrating height scaling for 1, 5, 10, 25, 50, and 100 line changes
  - Test output shows clear progression: 1 line (30px) → 5 lines (61px) → 10 lines (75px) → 25 lines (93px) → 50 lines (106px) → 100 lines (120px)

### Changed
- **Symbol Changes View Color Scheme**: Complete visual redesign with solid color fills
  - **File containers**: Dark gray background (#4c4d4c) with white text labels
  - **All symbol boxes**: Dark gray borders (#141414)
  - **Functions/Methods/Constructors**: Light green (#90EE90)
  - **Classes**: Pink (#FFC0CB)
  - **Variables/Constants**: Gray (#808080)
  - **Types/Interfaces**: Yellow (#FFFF00) with dashed borders
  - **Unidentified file changes**: Light blue (#ADD8E6)
  - All symbol text in black for maximum contrast and readability
- **Symbol Box Padding**: Increased internal padding (24px top, 12px sides/bottom)
  - Text labels have more breathing room and are easier to read
  - Better visual balance within symbol boxes
- **File Label Display**: File containers now show only the filename instead of the full path
  - Hover over the filename to see the full file path in a tooltip
  - Cleaner, more compact display with help cursor indicator
- **File Container Layout**: File containers now use brick-packing layout instead of horizontal line
  - Containers wrap to multiple rows based on available width (1400px max per row)
  - More efficient use of screen space with 20px padding between containers
  - Better visualization for projects with many changed files

### Removed
- **Dev Mode and Requirements Management**
  - Removed dev mode panel and all requirement management features
  - Removed AI validation functionality
  - Removed `radium.openDevMode` command
  - Removed `radium.selectAIProvider` command
  - Removed `radium.devMode.*` configuration settings
  - Removed `radium-req.yaml` support
  - Deleted related documentation files (dev-mode.md, validation-implementation.md, testing-cursor-validation.md, cursor-integration.md)
  - Simplified extension to focus on core visualization features
- **Show Changes Command**
  - Removed `radium.showChanges` command
  - Removed git diff and session visualization picker
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
- **Feature Flow Visualization**: Document and visualize user flows within features
  - Add `flow` property to features in `radium-features.yaml`
  - Flow items support 5 types: `user`, `window`, `system`, `api`, `database`
  - Each flow item has a name and optional description
  - Features displayed vertically on the left with flow items extending horizontally to the right
  - Sequential flow items connected with arrows showing the flow progression
  - Color-coded by type: purple (user), orange (window), green (system), red (api), gray (database)
  - `components` field is now optional - features can be defined with only flows
  - See updated `docs/radium-features.md` for syntax and examples
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
- **Features Map Tree Layout**: Features map now displays in hierarchical tree structure
  - Parent features appear at the top with larger boxes
  - Sub-features appear below their parents
  - Components appear at the bottom of the tree
  - Replaced force-directed layout with fixed hierarchical positioning
  - Parent-child relationships shown with gray connecting lines
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


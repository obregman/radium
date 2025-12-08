# Files View Design Document

## Overview

A new visualization mode that displays files as rectangles sized by line count, with arrows showing file relationships (imports, calls, etc.). Uses force-directed layout with separate directory nodes connected to their files via dashed lines.

## Implementation Summary

### Files Created
- `src/views/files-map-panel.ts` - Main panel class implementing the Files Map visualization

### Files Modified
- `src/extension.ts` - Added command registration for `radium.openFilesMap`
- `package.json` - Added command to VS Code command palette
- `README.md` - Added documentation for the Files Map feature

## Architecture

### Component Structure

**FilesMapPanel Class** (`src/views/files-map-panel.ts`)
- Follows the same webview panel pattern as other Radium views
- Communicates with webview via message passing
- Handles file opening when user clicks on file nodes

**Data Source**: `GraphStore`
- `getAllFiles()` - Returns all indexed files with metadata
- `getAllNodes()` - Used to calculate accurate line counts
- `getAllEdges()` - Provides file relationship data

**Command**: `radium.openFilesMap`
- Registered in extension activation
- Available in command palette as "Radium: Files Map"

## Data Model

### Graph Nodes

**File Nodes**:
```typescript
{
  id: string,           // file path
  type: 'file',
  label: string,        // filename only
  path: string,         // full path
  lines: number,        // line count
  lang: string,         // file language
  size: number          // visual size (80-200px)
}
```

**Directory Nodes**:
```typescript
{
  id: string,           // 'dir:' + directory path
  type: 'directory',
  label: string,        // directory name
  path: string,         // full directory path
  fileCount: number     // number of files
}
```

### Graph Edges

**File Relationships** (solid arrows):
- Types: imports, calls, inherits, defines, modifies
- Aggregated by file (multiple symbol-level edges combined)
- Weight indicates relationship strength

**Directory Containment** (dashed lines):
- Connects directory nodes to their files
- Visual indicator of project structure

## Data Processing

### Line Count Calculation
1. Query all nodes for a file path
2. Sum the range spans: `(range_end - range_start + 1)`
3. Fallback to `FileRecord.size / 50` if no nodes exist

### Size Calculation
- **Range**: 80px (minimum) to 200px (maximum)
- **Formula**: `Math.sqrt(lines) * 3`
- Square root scaling prevents very large files from dominating

### Edge Aggregation
- Symbol-level edges grouped by source/target file
- Weights summed for multiple edges between same files
- Self-references filtered out

## Visualization

### Layout: D3.js Force Simulation

**Forces Applied**:
- **Charge** (`forceManyBody`): Repulsion between nodes
  - Directories: -300 strength
  - Files: -500 strength
- **Link** (`forceLink`): Attraction along edges
  - Directory containment: 50px distance
  - File relationships: 150px distance
- **Center** (`forceCenter`): Pull toward viewport center
- **Collision** (`forceCollide`): Prevent overlap
  - Radius based on node size

### Visual Design

**File Rectangles**:
- Width: Calculated size (80-200px)
- Height: 70% of width (maintains aspect ratio)
- Rounded corners (4px radius)
- Color by language:
  - TypeScript: #3178c6 (blue)
  - JavaScript: #f7df1e (yellow)
  - Python: #3776ab (blue)
  - C#: #9b4f96 (purple)
  - Go: #00add8 (cyan)
- White border (1.5px)
- Label: filename (truncated to 15 chars)
- Sub-label: line count (e.g., "150 L")

**Directory Rectangles**:
- Fixed size: 60x40px
- Dashed border (4px dash pattern)
- Gray color (#888)
- No fill (transparent)
- Label: directory name (truncated to 10 chars)

**Edges**:
- **File relationships**: Curved arrows (quadratic Bézier)
  - imports: #4a9eff (blue)
  - calls: #4caf50 (green)
  - inherits: #ff9800 (orange)
  - defines: #9c27b0 (purple)
  - modifies: #f44336 (red)
  - Arrow markers on target end
  - Opacity: 0.6 (hover: 1.0)
- **Directory containment**: Dashed gray lines (#666)
  - No arrow markers
  - Opacity: 0.4

### Interaction

**Pan & Zoom**: D3 zoom behavior (0.1x - 4x scale)
**Hover**: Opacity change on nodes and edges
**Click File**: Opens file in VS Code editor
**Drag**: Repositions nodes, simulation continues
**Filters**: Real-time filtering via checkboxes
- Language filters (5 languages)
- Edge type filters (5 types)

### Filter Panel

Located in top-left corner:
- Semi-transparent dark background
- Scrollable (max-height: 200px)
- Checkboxes for languages and edge types
- All filters enabled by default
- Changes apply immediately

## Technical Considerations

### Performance
- All files and edges loaded at once (suitable for typical projects)
- D3 force simulation handles layout efficiently
- Filtering done client-side (no backend queries)

### Edge Cases Handled
- **Files with 0 lines**: Minimum size (80px) applied
- **No nodes for file**: Fallback to file size estimation
- **Self-references**: Filtered out during edge building
- **Empty directories**: Not created (only directories with files)
- **Root directory**: Skipped (path is '.' or '')

### Browser Compatibility
- Uses D3.js v7 from CDN
- Standard SVG rendering
- Modern CSS (flexbox, transforms)
- Works in VS Code webview environment

## Usage

1. Open command palette (Cmd/Ctrl+Shift+P)
2. Run "Radium: Files Map"
3. View opens in new editor column
4. Use filters to focus on specific languages or relationships
5. Click files to open in editor
6. Drag to rearrange, zoom to focus

## Future Enhancements

- **Heatmap overlay**: Show recent changes or complexity
- **Time-based animation**: Visualize file growth over time
- **Clustering**: Group by module/component
- **Export**: Save as SVG or PNG image
- **Search**: Find and highlight specific files
- **Performance limit**: Cap at 500 files for very large projects
- **Directory expansion**: Click to show/hide contained files
- **Edge weight threshold**: Filter weak relationships


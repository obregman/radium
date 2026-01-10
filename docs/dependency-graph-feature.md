# Dependency Graph Feature

## Overview

The Dependency Graph is a new visualization mode in Radium that provides an interactive view of file-to-file dependencies across your codebase. It analyzes the indexed data to show which files depend on each other through imports, function calls, type usage, and other relationships.

## Implementation

### Files Created/Modified

1. **src/views/dependency-graph-panel.ts** (NEW)
   - Main panel implementation
   - Builds dependency graph from indexed data
   - Provides interactive visualization with D3.js-like force simulation
   - Supports multiple layout algorithms (force-directed, hierarchical, circular)
   - Includes filtering capabilities

2. **src/extension.ts** (MODIFIED)
   - Added import for `DependencyGraphPanel`
   - Registered new command `radium.dependencyGraph`

3. **package.json** (MODIFIED)
   - Added command definition for "Radium: Dependency Graph"
   - Icon: `$(type-hierarchy)`

4. **dev/panel-server.ts** (MODIFIED)
   - Added panel configuration for dependency-graph
   - Added mock data generator `getDependencyGraphMockDataScript()`
   - Updated index page to include new panel
   - Updated server console output

5. **README.md** (MODIFIED)
   - Added documentation for the Dependency Graph feature
   - Updated command list
   - Updated dev server panel list

## Features

### Graph Construction

The dependency graph is built by:
1. Retrieving all files from the store
2. Analyzing all edges (relationships) between nodes
3. Aggregating cross-file relationships
4. Calculating in-degree (how many files depend on this file)
5. Calculating out-degree (how many files this file depends on)

### Visualizations

**Layout Algorithms:**
- **Force-Directed**: Natural clustering using simulated physics
- **Hierarchical**: Top-down arrangement based on dependency depth
- **Circular**: Radial layout for overview

**Filtering Options:**
- All Files
- High Dependencies (>5 outgoing)
- High Dependents (>5 incoming)
- Isolated Files (no connections)

### Visual Encoding

**Node Properties:**
- Size: Based on total connections (inDegree + outDegree)
- Color:
  - Gray: Isolated (0 connections)
  - Blue: Low connectivity (1-5 connections)
  - Orange: Medium connectivity (6-10 connections)
  - Red: High connectivity (>10 connections)

**Edge Properties:**
- Color: Based on relationship type (imports, calls, inherits, etc.)
- Thickness: Proportional to connection weight
- Direction: Arrow pointing from source to target

### Interactions

- **Pan**: Click and drag on empty space
- **Zoom**: Mouse wheel
- **Drag Nodes**: Click and drag individual files
- **Hover**: Show tooltip with file details
- **Click**: Open file in editor (when in VS Code)
- **Reset View**: Return to default position
- **Fit to Screen**: Auto-scale to show all files

### Statistics Panel

Real-time statistics displayed:
- Total files count
- Total dependencies count
- Average dependencies per file
- Maximum dependencies for any file

## Technical Details

### Data Flow

1. User opens Dependency Graph panel
2. Panel sends 'ready' message to extension
3. Extension calls `buildDependencyGraph()`
4. Graph data is constructed from store
5. Data sent to webview via `graph:update` message
6. Webview renders graph using custom D3-like simulation

### Graph Algorithm

The force-directed layout uses:
- **Link Force**: Pulls connected nodes together
- **Charge Force**: Pushes all nodes apart (many-body repulsion)
- **Center Force**: Keeps graph centered in viewport
- **Collision Force**: Prevents node overlap

### Performance Considerations

- Edges are aggregated by file pairs to reduce visual clutter
- Only cross-file relationships are shown (internal file relationships excluded)
- Filtering reduces node count for better performance on large codebases
- Simulation can be stopped when dragging for better responsiveness

## Usage Example

1. Open command palette (Cmd/Ctrl + Shift + P)
2. Run "Radium: Dependency Graph"
3. Wait for graph to load
4. Use toolbar to:
   - Change layout algorithm
   - Apply filters
   - Reset or fit view
5. Interact with graph:
   - Hover over nodes to see details
   - Drag nodes to reorganize
   - Click nodes to open files

## Use Cases

1. **Identify Core Files**: Find files with high in-degree (many dependents)
2. **Find Coupling Issues**: Locate files with high out-degree (many dependencies)
3. **Detect Circular Dependencies**: Visual loops in the graph
4. **Refactoring Planning**: Understand impact of changes
5. **Code Organization**: See natural module boundaries
6. **Onboarding**: Help new developers understand codebase structure
7. **Technical Debt**: Identify isolated or orphaned files

## Future Enhancements

Potential improvements:
- Circular dependency detection and highlighting
- Module/package grouping
- Path highlighting between two selected files
- Export graph as image
- Dependency metrics (coupling, cohesion)
- Integration with git history to show dependency evolution
- Comparison mode to show dependency changes over time


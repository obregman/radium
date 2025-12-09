import * as vscode from 'vscode';
import { GraphStore, Node, Edge, FileRecord, EdgeKind } from '../store/schema';
import * as path from 'path';
import * as fs from 'fs';
import { RadiumIgnore } from '../config/radium-ignore';

interface FileNode {
  id: string;
  type: 'file';
  label: string;
  path: string;
  lines: number;
  lang: string;
  size: number;
  exportedSymbols: number;
}

interface DirectoryNode {
  id: string;
  type: 'directory';
  label: string;
  path: string;
  fileCount: number;
}

interface FileEdge {
  source: string;
  target: string;
  type: EdgeKind;
  weight: number;
}

interface DirectoryEdge {
  source: string;
  target: string;
  type: 'contains';
}

interface GraphData {
  nodes: (FileNode | DirectoryNode)[];
  edges: (FileEdge | DirectoryEdge)[];
}

export class FilesMapPanel {
  public static currentPanel: FilesMapPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private radiumIgnore: RadiumIgnore;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private store: GraphStore,
    private workspaceRoot: string
  ) {
    this.panel = panel;
    this.radiumIgnore = new RadiumIgnore(workspaceRoot);
    
    this.panel.webview.onDidReceiveMessage(
      message => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.webview.html = this.getHtmlContent(extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    store: GraphStore
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (FilesMapPanel.currentPanel) {
      FilesMapPanel.currentPanel.panel.reveal(column);
      FilesMapPanel.currentPanel.updateGraph();
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'filesMap',
      'Radium: Files Map',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    FilesMapPanel.currentPanel = new FilesMapPanel(
      panel,
      extensionUri,
      store,
      workspaceFolders[0].uri.fsPath
    );
  }

  private async handleMessage(message: any) {
    switch (message.type) {
      case 'file:open':
        await this.handleFileOpen(message.filePath);
        break;
      case 'ready':
        this.updateGraph();
        break;
    }
  }

  private async handleFileOpen(filePath: string) {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const fullPath = vscode.Uri.file(
        filePath.startsWith('/') ? filePath : path.join(workspaceRoot, filePath)
      );

      const document = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
      console.error('[Files Map] Error opening file:', error);
    }
  }

  public updateGraph() {
    const graphData = this.buildFilesGraph();
    
    this.panel.webview.postMessage({
      type: 'graph:update',
      data: graphData
    });
  }

  private buildFilesGraph(): GraphData {
    const nodes: (FileNode | DirectoryNode)[] = [];
    const edges: (FileEdge | DirectoryEdge)[] = [];
    
    // Get all files from the store
    const allFiles = this.store.getAllFiles();
    
    // Filter out ignored files
    const files = allFiles.filter(file => !this.radiumIgnore.shouldIgnore(file.path));
    
    console.log(`[Files Map] Total files in store: ${allFiles.length}, after radiumignore filter: ${files.length}`);
    
    const allNodes = this.store.getAllNodes();
    const allEdges = this.store.getAllEdges();
    
    // Track directories
    const directories = new Map<string, Set<string>>();
    
    // Calculate exported symbols per file (symbols used by other files)
    const fileExportedSymbols = new Map<string, Set<number>>();
    for (const edge of allEdges) {
      // Count all types of cross-file references (calls, imports, inherits, etc.)
      const srcNode = allNodes.find(n => n.id === edge.src);
      const dstNode = allNodes.find(n => n.id === edge.dst);
      
      if (!srcNode || !dstNode) {
        continue; // Skip if nodes not found
      }
      
      if (srcNode.path === dstNode.path) {
        continue; // Skip same-file references
      }
      
      // Count unique symbols in dstNode's file that are referenced from other files
      // dstNode is the symbol being imported/called/inherited from
      if (!fileExportedSymbols.has(dstNode.path)) {
        fileExportedSymbols.set(dstNode.path, new Set());
      }
      fileExportedSymbols.get(dstNode.path)!.add(dstNode.id!);
    }
    
    console.log('[Files Map] Exported symbols per file:', 
      Array.from(fileExportedSymbols.entries()).map(([path, ids]) => 
        ({ path, count: ids.size })
      )
    );
    
    // Create file nodes
    for (const file of files) {
      // Read the actual file to count lines
      let lines = 1;
      try {
        const fullPath = path.join(this.workspaceRoot, file.path);
        const content = fs.readFileSync(fullPath, 'utf-8');
        lines = content.split('\n').length;
      } catch (error) {
        // Fallback: estimate from file size (average 50 chars per line)
        lines = Math.max(1, Math.floor(file.size / 50));
      }
      
      const fileName = path.basename(file.path);
      const dirPath = path.dirname(file.path);
      
      // Calculate visual size (width) - linear scaling based on lines
      // 1 line = 150px, 3000+ lines = 350px
      const MIN_WIDTH = 150;
      const MAX_WIDTH = 350;
      const MAX_LINES = 3000;
      
      // Linear interpolation: 150px + (lines/3000) * 200px
      let size;
      if (lines <= 1) {
        size = MIN_WIDTH;
      } else if (lines >= MAX_LINES) {
        size = MAX_WIDTH;
      } else {
        // Linear scale from 150px to 350px based on line count
        size = MIN_WIDTH + ((lines - 1) / (MAX_LINES - 1)) * (MAX_WIDTH - MIN_WIDTH);
      }
      
      // Get exported symbols count
      const exportedSymbols = fileExportedSymbols.get(file.path)?.size || 0;
      
      nodes.push({
        id: file.path,
        type: 'file',
        label: fileName,
        path: file.path,
        lines,
        lang: file.lang,
        size,
        exportedSymbols
      });
      
      // Track directory
      if (!directories.has(dirPath)) {
        directories.set(dirPath, new Set());
      }
      directories.get(dirPath)!.add(file.path);
    }
    
    // Create directory nodes (only for directories that aren't ignored)
    for (const [dirPath, fileSet] of directories.entries()) {
      if (dirPath === '.' || dirPath === '') {
        continue;
      }
      
      // Check if directory should be ignored
      if (this.radiumIgnore.shouldIgnoreDirectory(dirPath)) {
        console.log(`[Files Map] Skipping ignored directory: ${dirPath}`);
        continue;
      }
      
      nodes.push({
        id: `dir:${dirPath}`,
        type: 'directory',
        label: dirPath,
        path: dirPath,
        fileCount: fileSet.size
      });
      
      // Create directory containment edges
      for (const filePath of fileSet) {
        edges.push({
          source: `dir:${dirPath}`,
          target: filePath,
          type: 'contains'
        });
      }
    }
    
    // Build file relationships from edges
    const fileEdgeMap = new Map<string, Map<string, { type: EdgeKind; weight: number }>>();
    
    for (const edge of allEdges) {
      const srcNode = allNodes.find(n => n.id === edge.src);
      const dstNode = allNodes.find(n => n.id === edge.dst);
      
      if (!srcNode || !dstNode) {
        continue;
      }
      
      // Skip self-references
      if (srcNode.path === dstNode.path) {
        continue;
      }
      
      const key = `${srcNode.path}:${dstNode.path}`;
      if (!fileEdgeMap.has(key)) {
        fileEdgeMap.set(key, new Map());
      }
      
      const edgeTypes = fileEdgeMap.get(key)!;
      const existing = edgeTypes.get(edge.kind);
      
      if (existing) {
        existing.weight += edge.weight;
      } else {
        edgeTypes.set(edge.kind, { type: edge.kind, weight: edge.weight });
      }
    }
    
    // Create file edges
    for (const [key, edgeTypes] of fileEdgeMap.entries()) {
      const [source, target] = key.split(':');
      
      for (const { type, weight } of edgeTypes.values()) {
        edges.push({
          source,
          target,
          type,
          weight
        });
      }
    }
    
    console.log(`[Files Map] Built graph with ${nodes.length} nodes and ${edges.length} edges`);
    console.log('[Files Map] Sample file export counts:', 
      nodes.filter(n => n.type === 'file').slice(0, 10).map(n => ({
        path: (n as FileNode).path,
        exports: (n as FileNode).exportedSymbols
      }))
    );
    
    return { nodes, edges };
  }

  private getHtmlContent(extensionUri: vscode.Uri): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Radium: Files Map</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow: hidden;
    }
    
    #graph {
      width: 100vw;
      height: 100vh;
    }
    
    .node-file {
      cursor: pointer;
      transition: opacity 0.2s;
    }
    
    .node-file:hover {
      opacity: 1;
    }
    
    .node-directory {
      cursor: move;
    }
    
    .node-directory:hover {
      opacity: 1;
    }
    
    /* Ensure hovered nodes appear on top */
    g.nodes g:hover {
      filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.5));
    }
    
    .edge-file {
      fill: none;
      stroke-width: 1.5;
      opacity: 0.6;
      transition: opacity 0.2s;
    }
    
    .edge-file:hover {
      opacity: 1;
      stroke-width: 2.5;
    }
    
    .edge-directory {
      fill: none;
      stroke: #666;
      stroke-width: 1.5;
      opacity: 0.5;
    }
    
    .node-label {
      font-size: 11px;
      text-anchor: middle;
      pointer-events: none;
      user-select: none;
    }
    
    .node-sublabel {
      font-size: 9px;
      fill: #999;
      text-anchor: middle;
      pointer-events: none;
      user-select: none;
    }
    
    .arrow {
      fill: currentColor;
    }
  </style>
</head>
<body>
  <svg id="graph"></svg>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    let graphData = null;
    let simulation = null;
    let svg = null;
    let g = null;
    
    // Function to get color based on exported symbols
    function getFileColor(exportedSymbols) {
      if (exportedSymbols === 0) return '#999'; // grey
      if (exportedSymbols <= 3) return '#ffd700'; // yellow
      if (exportedSymbols <= 6) return '#adff2f'; // yellow green
      if (exportedSymbols <= 9) return '#90ee90'; // light green
      return '#4caf50'; // green
    }
    
    // Function to get text color based on exported symbols
    function getTextColor(exportedSymbols) {
      if (exportedSymbols === 0) return '#d4d4d4'; // light text for grey background
      if (exportedSymbols <= 9) return '#333'; // dark gray text for yellow/green backgrounds
      return '#d4d4d4'; // light text for dark green
    }
    
    // Edge type colors
    const edgeColors = {
      imports: '#4a9eff',
      calls: '#4caf50',
      inherits: '#ff9800',
      defines: '#9c27b0',
      modifies: '#f44336'
    };
    
    // Initialize
    function init() {
      svg = d3.select('#graph');
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      svg.attr('width', width).attr('height', height);
      
      // Add zoom behavior
      const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });
      
      svg.call(zoom);
      
      // Create container group
      g = svg.append('g');
      
      // Add arrow markers for each edge type
      const defs = svg.append('defs');
      for (const [type, color] of Object.entries(edgeColors)) {
        defs.append('marker')
          .attr('id', \`arrow-\${type}\`)
          .attr('viewBox', '0 -5 10 10')
          .attr('refX', 20)
          .attr('refY', 0)
          .attr('markerWidth', 6)
          .attr('markerHeight', 6)
          .attr('orient', 'auto')
          .append('path')
          .attr('d', 'M0,-5L10,0L0,5')
          .attr('class', 'arrow')
          .style('fill', color);
      }
      
      vscode.postMessage({ type: 'ready' });
    }
    
    // Render graph
    function renderGraph(data) {
      graphData = data;
      
      // Use all nodes and edges (no filtering)
      const nodes = data.nodes;
      const edges = data.edges;
      
      // Log export counts for debugging
      console.log('[Files Map Webview] Total nodes:', nodes.length);
      console.log('[Files Map Webview] File nodes with exports:', 
        nodes.filter(n => n.type === 'file' && n.exportedSymbols > 0).length
      );
      console.log('[Files Map Webview] Sample export counts:', 
        nodes.filter(n => n.type === 'file').slice(0, 10).map(n => ({
          label: n.label,
          exports: n.exportedSymbols,
          color: getFileColor(n.exportedSymbols)
        }))
      );
      
      // Clear existing
      g.selectAll('*').remove();
      
      // Create force simulation
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      // Filter only containment edges for the force simulation
      const containmentEdges = edges.filter(e => e.type === 'contains');
      
      simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(containmentEdges)
          .id(d => d.id)
          .distance(120)
          .strength(d => {
            // Only directories pull their files, files don't pull each other
            if (d.source.type === 'directory') return 0.3; // Weak pull from directory to files
            return 0; // No pull between files
          })
        )
        .force('charge', d3.forceManyBody()
          .strength(d => {
            // Directories repel very strongly to create distinct groups
            if (d.type === 'directory') return -3000;
            // Files repel strongly to avoid sticking together
            return -800; // Increased from -300 to prevent stickiness
          })
        )
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide()
          .radius(d => {
            if (d.type === 'directory') {
              // Directory collision based on its actual size with extra padding
              const width = Math.max(300, d.label.length * 12); // Updated to match new size
              const height = 100; // Updated to match new height
              return Math.sqrt(width * width + height * height) / 2 + 50;
            }
            // File collision based on its size with generous padding to prevent overlap
            const boxWidth = d.size;
            const boxHeight = d.size / 2;
            return Math.sqrt(boxWidth * boxWidth + boxHeight * boxHeight) / 2 + 30;
          })
          .strength(1.2) // Stronger collision to prevent overlap
        )
        .force('x', d3.forceX(width / 2).strength(0.02)) // Reduced from 0.05 to allow more spreading
        .force('y', d3.forceY(height / 2).strength(0.02)); // Reduced from 0.05 to allow more spreading
      
      // Create edges (only directory-to-file connections)
      const edgeGroup = g.append('g').attr('class', 'edges');
      
      const edgeElements = edgeGroup.selectAll('path')
        .data(containmentEdges)
        .enter()
        .append('path')
        .attr('class', 'edge-directory')
        .style('stroke', '#666');
      
      // Create nodes
      const nodeGroup = g.append('g').attr('class', 'nodes');
      
      const nodeElements = nodeGroup.selectAll('g')
        .data(nodes)
        .enter()
        .append('g')
        .attr('class', d => d.type === 'directory' ? 'node-directory' : 'node-file')
        .call(d3.drag()
          .on('start', dragStarted)
          .on('drag', dragged)
          .on('end', dragEnded)
        )
        .on('click', (event, d) => {
          if (d.type === 'file') {
            vscode.postMessage({ type: 'file:open', filePath: d.path });
          }
        })
        .on('mouseenter', function(event, d) {
          // Bring node to front by re-appending it (SVG z-order is DOM order)
          this.parentNode.appendChild(this);
          
          // Zoom to 3x size on hover
          d3.select(this)
            .transition()
            .duration(200)
            .attr('transform', \`translate(\${d.x},\${d.y}) scale(3)\`);
        })
        .on('mouseleave', function(event, d) {
          // Return to normal size
          d3.select(this)
            .transition()
            .duration(200)
            .attr('transform', \`translate(\${d.x},\${d.y}) scale(1)\`);
        });
      
      // Add rectangles for files
      nodeElements.filter(d => d.type === 'file')
        .append('rect')
        .attr('width', d => d.size)
        .attr('height', d => d.size / 2)
        .attr('x', d => -d.size / 2)
        .attr('y', d => -d.size / 4)
        .attr('rx', 4)
        .attr('ry', 4)
        .style('fill', d => getFileColor(d.exportedSymbols))
        .style('stroke', '#fff')
        .style('stroke-width', 1.5);
      
      // Add rectangles for directories
      nodeElements.filter(d => d.type === 'directory')
        .append('rect')
        .attr('width', d => Math.max(300, d.label.length * 12)) // Increased from 200 and 10
        .attr('height', 100) // Increased from 70
        .attr('x', d => -Math.max(300, d.label.length * 12) / 2)
        .attr('y', -50) // Adjusted for new height
        .attr('rx', 8) // Larger corner radius
        .attr('ry', 8)
        .style('fill', '#fff')
        .style('stroke', '#666')
        .style('stroke-width', 2);
      
      // Add line count badge for files (at the top)
      const fileNodes = nodeElements.filter(d => d.type === 'file');
      
      // Add background rectangle for line count
      fileNodes.append('rect')
        .attr('class', 'line-count-badge')
        .attr('width', d => {
          const text = String(d.lines);
          return Math.max(30, text.length * 7 + 10);
        })
        .attr('height', 16)
        .attr('x', d => {
          const text = String(d.lines);
          const badgeWidth = Math.max(30, text.length * 7 + 10);
          return -badgeWidth / 2;
        })
        .attr('y', d => -d.size / 4 + 2) // Position at top of file box
        .attr('rx', 8)
        .attr('ry', 8)
        .style('fill', 'rgba(0, 0, 0, 0.6)')
        .style('stroke', 'rgba(255, 255, 255, 0.3)')
        .style('stroke-width', 1);
      
      // Add line count text
      fileNodes.append('text')
        .attr('class', 'node-sublabel')
        .attr('x', 0)
        .attr('y', d => -d.size / 4 + 14) // Position at top of file box
        .text(d => \`\${d.lines}\`);
      
      // Add labels
      nodeElements.append('text')
        .attr('class', d => d.type === 'directory' ? 'node-label directory' : 'node-label')
        .attr('x', 0) // Center horizontally
        .attr('y', d => {
          if (d.type === 'directory') {
            return 0; // Vertically centered
          }
          // Center vertically in file box
          return 0;
        })
        .attr('text-anchor', 'middle') // Center horizontally
        .attr('dominant-baseline', 'middle') // Center vertically
        .style('font-size', d => {
          if (d.type === 'directory') {
            return '20px'; // Increased from 16px
          }
          // Scale font size based on box width (150-350px -> 10-16px)
          const minFont = 10;
          const maxFont = 16;
          const fontSize = minFont + ((d.size - 150) / (350 - 150)) * (maxFont - minFont);
          return \`\${Math.round(fontSize)}px\`;
        })
        .style('fill', d => d.type === 'directory' ? '#000' : getTextColor(d.exportedSymbols))
        .style('font-weight', d => d.type === 'directory' ? '600' : 'normal') // Bolder for directories
        .text(d => {
          if (d.type === 'directory') {
            return d.label;
          }
          // Truncate filename based on box width with padding
          // Account for font size scaling (10-16px range)
          const fontSize = 10 + ((d.size - 150) / (350 - 150)) * (16 - 10);
          const avgCharWidth = fontSize * 0.6; // Average character width is ~60% of font size
          const padding = 4; // Reduced padding on each side
          const availableWidth = d.size - (padding * 2);
          const maxChars = Math.floor(availableWidth / avgCharWidth);
          return d.label.length > maxChars ? d.label.substring(0, Math.max(1, maxChars - 3)) + '...' : d.label;
        });
      
      // Update positions on tick
      simulation.on('tick', () => {
        edgeElements.attr('d', d => {
          const dx = d.target.x - d.source.x;
          const dy = d.target.y - d.source.y;
          const dr = Math.sqrt(dx * dx + dy * dy) * 2;
          return \`M\${d.source.x},\${d.source.y}A\${dr},\${dr} 0 0,1 \${d.target.x},\${d.target.y}\`;
        });
        
        nodeElements.each(function(d) {
          const node = d3.select(this);
          const currentTransform = node.attr('transform');
          // Preserve scale if hovering (check if scale is in transform)
          if (currentTransform && currentTransform.includes('scale(3)')) {
            node.attr('transform', \`translate(\${d.x},\${d.y}) scale(3)\`);
          } else {
            node.attr('transform', \`translate(\${d.x},\${d.y})\`);
          }
        });
      });
    }
    
    // Drag handlers
    function dragStarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }
    
    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
    }
    
    function dragEnded(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }
    
    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'graph:update':
          renderGraph(message.data);
          break;
      }
    });
    
    // Handle window resize
    window.addEventListener('resize', () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      svg.attr('width', width).attr('height', height);
      
      if (simulation) {
        simulation.force('center', d3.forceCenter(width / 2, height / 2));
        simulation.alpha(0.3).restart();
      }
    });
    
    init();
  </script>
</body>
</html>`;
  }

  private dispose() {
    FilesMapPanel.currentPanel = undefined;
    this.panel.dispose();
    
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}


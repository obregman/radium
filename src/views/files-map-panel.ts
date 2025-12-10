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
  depth: number; // Directory depth level (0 = root, 1 = first level, etc.)
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
      case 'layout:save':
        await this.saveLayout(message.layout);
        break;
      case 'layout:load':
        await this.loadLayout();
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

  private async saveLayout(layout: { [dirPath: string]: { x: number; y: number } }) {
    try {
      const radiumDir = path.join(this.workspaceRoot, '.radium');
      const layoutFile = path.join(radiumDir, 'file-map-layout.json');

      // Ensure .radium directory exists
      if (!fs.existsSync(radiumDir)) {
        fs.mkdirSync(radiumDir, { recursive: true });
      }

      // Save layout to file
      fs.writeFileSync(layoutFile, JSON.stringify(layout, null, 2), 'utf-8');
      console.log('[Files Map] Layout saved to', layoutFile);
    } catch (error) {
      console.error('[Files Map] Error saving layout:', error);
    }
  }

  private async loadLayout() {
    try {
      const layoutFile = path.join(this.workspaceRoot, '.radium', 'file-map-layout.json');

      if (fs.existsSync(layoutFile)) {
        const layoutData = fs.readFileSync(layoutFile, 'utf-8');
        const layout = JSON.parse(layoutData);
        
        // Send layout to webview
        this.panel.webview.postMessage({
          type: 'layout:loaded',
          layout
        });
        
        console.log('[Files Map] Layout loaded from', layoutFile);
      } else {
        console.log('[Files Map] No saved layout found');
      }
    } catch (error) {
      console.error('[Files Map] Error loading layout:', error);
    }
  }

  public updateGraph() {
    const graphData = this.buildFilesGraph();
    
    console.log(`[Files Map] Sending graph data: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);
    console.log(`[Files Map] File nodes: ${graphData.nodes.filter(n => n.type === 'file').length}`);
    console.log(`[Files Map] Directory nodes: ${graphData.nodes.filter(n => n.type === 'directory').length}`);
    
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
    console.log(`[Files Map] Processing ${allEdges.length} edges to calculate exported symbols`);
    
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
      
      // Log cross-file edges for debugging
      if (dstNode.name === 'WebContentExtractor' || dstNode.name === 'WebSearchService') {
        console.log(`[Files Map] Cross-file edge: ${srcNode.path}:${srcNode.name} --${edge.kind}--> ${dstNode.path}:${dstNode.name}`);
      }
      
      // Count unique symbols in dstNode's file that are referenced from other files
      // dstNode is the symbol being imported/called/inherited from
      if (!fileExportedSymbols.has(dstNode.path)) {
        fileExportedSymbols.set(dstNode.path, new Set());
      }
      fileExportedSymbols.get(dstNode.path)!.add(dstNode.id!);
    }
    
    console.log('[Files Map] Exported symbols per file:', 
      Array.from(fileExportedSymbols.entries()).map(([path, ids]) => {
        const symbols = Array.from(ids).map(id => {
          const node = allNodes.find(n => n.id === id);
          return `${node?.kind}:${node?.name}`;
        });
        return { path, count: ids.size, symbols };
      })
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
    
    // Calculate directory depth and create hierarchy
    const dirDepthMap = new Map<string, number>();
    const dirHierarchy = new Map<string, string[]>(); // parent -> children
    const allDirectories = new Set<string>(); // All directories including intermediate ones
    
    // First pass: collect all directories that have files
    for (const [dirPath] of directories.entries()) {
      if (dirPath === '.' || dirPath === '') {
        continue;
      }
      allDirectories.add(dirPath);
    }
    
    // Second pass: add all parent directories in the hierarchy
    for (const dirPath of Array.from(allDirectories)) {
      let currentPath = dirPath;
      while (true) {
        const parentPath = path.dirname(currentPath);
        if (parentPath === '.' || parentPath === '' || parentPath === currentPath) {
          break;
        }
        allDirectories.add(parentPath);
        currentPath = parentPath;
      }
    }
    
    // Calculate depth for all directories
    for (const dirPath of allDirectories) {
      const depth = dirPath.split(path.sep).length - 1;
      dirDepthMap.set(dirPath, depth);
      
      // Find parent directory
      const parentPath = path.dirname(dirPath);
      if (parentPath !== '.' && parentPath !== dirPath) {
        if (!dirHierarchy.has(parentPath)) {
          dirHierarchy.set(parentPath, []);
        }
        dirHierarchy.get(parentPath)!.push(dirPath);
      }
    }
    
    // Create directory nodes for all directories (including those without direct files)
    for (const dirPath of allDirectories) {
      // Check if directory should be ignored
      if (this.radiumIgnore.shouldIgnoreDirectory(dirPath)) {
        console.log(`[Files Map] Skipping ignored directory: ${dirPath}`);
        continue;
      }
      
      const depth = dirDepthMap.get(dirPath) || 0;
      const fileSet = directories.get(dirPath);
      const fileCount = fileSet ? fileSet.size : 0;
      
      nodes.push({
        id: `dir:${dirPath}`,
        type: 'directory',
        label: dirPath,
        path: dirPath,
        fileCount,
        depth
      });
      
      // Create directory containment edges (directory -> files)
      if (fileSet) {
        for (const filePath of fileSet) {
          edges.push({
            source: `dir:${dirPath}`,
            target: filePath,
            type: 'contains'
          });
        }
      }
      
      // Create directory hierarchy edges (parent dir -> child dir)
      const parentPath = path.dirname(dirPath);
      if (parentPath !== '.' && parentPath !== dirPath && allDirectories.has(parentPath)) {
        // Only create edge if parent directory exists and isn't ignored
        if (!this.radiumIgnore.shouldIgnoreDirectory(parentPath)) {
          edges.push({
            source: `dir:${parentPath}`,
            target: `dir:${dirPath}`,
            type: 'contains'
          });
        }
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
    
    #controls {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 1000;
      background: rgba(30, 30, 30, 0.95);
      padding: 10px;
      border-radius: 6px;
      border: 1px solid #444;
      display: flex;
      gap: 10px;
      align-items: center;
    }
    
    #search-box {
      background: #2d2d2d;
      color: #d4d4d4;
      border: 1px solid #555;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 13px;
      width: 250px;
      outline: none;
    }
    
    #search-box:focus {
      border-color: #007acc;
      background: #3d3d3d;
    }
    
    #search-box::placeholder {
      color: #888;
    }
    
    .toggle-btn {
      background: #2d2d2d;
      color: #d4d4d4;
      border: 1px solid #555;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: all 0.2s;
    }
    
    .toggle-btn:hover {
      background: #3d3d3d;
      border-color: #666;
    }
    
    .toggle-btn.active {
      background: #007acc;
      border-color: #007acc;
      color: #fff;
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
      stroke: #4a9eff;
      stroke-width: 3;
      opacity: 0.8;
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
  <div id="controls">
    <input type="text" id="search-box" placeholder="Search files and directories..." />
    <button class="toggle-btn active" data-mode="directory">Color by Parent Directory</button>
    <button class="toggle-btn" data-mode="symbol">Color by Symbol Use</button>
  </div>
  <svg id="graph"></svg>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    let graphData = null;
    let simulation = null;
    let svg = null;
    let g = null;
    let zoom = null;
    let colorMode = 'directory'; // 'symbol' or 'directory'
    let searchQuery = '';
    let savedLayout = {}; // Stores saved directory positions
    
    // 30 predefined distinct colors for directories
    const directoryColors = [
      '#FF6B6B', // Red
      '#4ECDC4', // Teal
      '#45B7D1', // Sky Blue
      '#FFA07A', // Light Salmon
      '#98D8C8', // Mint
      '#F7DC6F', // Yellow
      '#BB8FCE', // Purple
      '#85C1E2', // Light Blue
      '#F8B739', // Orange
      '#52B788', // Green
      '#E63946', // Crimson
      '#06FFA5', // Spring Green
      '#FFB4A2', // Peach
      '#B5838D', // Mauve
      '#6C5B7B', // Dark Purple
      '#C06C84', // Rose
      '#F67280', // Coral
      '#355C7D', // Navy
      '#99B898', // Sage
      '#FECEAB', // Apricot
      '#FF8C94', // Light Coral
      '#5DADE2', // Bright Blue
      '#F39C12', // Bright Orange
      '#A569BD', // Medium Purple
      '#48C9B0', // Turquoise
      '#F4D03F', // Bright Yellow
      '#EC7063', // Salmon
      '#85929E', // Blue Gray
      '#58D68D', // Light Green
      '#AF7AC5'  // Lavender
    ];
    
    // Simple hash function for strings
    function hashString(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      return Math.abs(hash);
    }
    
    // Function to get color based on directory name hash
    function getDirectoryColor(dirPath) {
      const hash = hashString(dirPath);
      const colorIndex = hash % directoryColors.length;
      return directoryColors[colorIndex];
    }
    
    // Function to get file color based on parent directory
    function getFileColorByDirectory(filePath) {
      if (!filePath) return directoryColors[0];
      
      // Find the parent directory of this file
      const lastSlashIndex = filePath.lastIndexOf('/');
      if (lastSlashIndex === -1) return directoryColors[0]; // Root level, first color
      
      const dirPath = filePath.substring(0, lastSlashIndex);
      if (!dirPath) return directoryColors[0]; // Root level, first color
      
      return getDirectoryColor(dirPath);
    }
    
    // Function to get color based on exported symbols
    function getFileColorBySymbols(exportedSymbols) {
      if (exportedSymbols === 0) return '#999'; // grey
      if (exportedSymbols <= 3) return '#ffd700'; // yellow
      if (exportedSymbols <= 6) return '#adff2f'; // yellow green
      if (exportedSymbols <= 9) return '#90ee90'; // light green
      return '#4caf50'; // green
    }
    
    // Function to get color based on current mode
    function getFileColor(node) {
      if (colorMode === 'directory') {
        return getFileColorByDirectory(node.path);
      } else {
        return getFileColorBySymbols(node.exportedSymbols);
      }
    }
    
    // Function to get directory box color
    function getDirBoxColor(dirPath) {
      if (colorMode === 'directory') {
        return getDirectoryColor(dirPath);
      } else {
        return '#fff'; // White for symbol mode
      }
    }
    
    // Function to get text color based on current mode and node
    function getTextColor(node) {
      if (colorMode === 'directory') {
        // For directory mode, use dark text on colored backgrounds
        return '#000';
      } else {
        // For symbol mode, adjust based on background color
        const exportedSymbols = node.exportedSymbols;
        if (exportedSymbols === 0) return '#d4d4d4'; // light text for grey background
        if (exportedSymbols <= 9) return '#333'; // dark gray text for yellow/green backgrounds
        return '#d4d4d4'; // light text for dark green
      }
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
      zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });
      
      svg.call(zoom);
      
      // Create container group
      g = svg.append('g');
      
      // Setup search box
      const searchBox = document.getElementById('search-box');
      searchBox.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        applySearchFilter();
      });
      
      // Setup toggle buttons
      document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const mode = e.target.dataset.mode;
          if (mode !== colorMode) {
            colorMode = mode;
            
            // Update button states
            document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            
            // Update colors
            updateColors();
          }
        });
      });
      
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
      vscode.postMessage({ type: 'layout:load' });
    }
    
    // Zoom to a specific node
    function zoomToNode(node) {
      if (!svg || !zoom) return;
      
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      // Calculate the transform to center and zoom to the node
      const scale = 1.2; // Zoom level (1.2x)
      const x = width / 2 - node.x * scale;
      const y = height / 2 - node.y * scale;
      
      // Stop the simulation to prevent jumping and bouncing
      if (simulation) {
        simulation.stop();
      }
      
      // Apply the transform with smooth transition
      svg.transition()
        .duration(750)
        .call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(scale));
    }
    
    // Check if a node matches the search query
    function nodeMatchesSearch(node) {
      if (!searchQuery) return true;
      
      // Search only in file/directory name (label), not full path
      const label = node.label.toLowerCase();
      
      return label.includes(searchQuery);
    }
    
    // Apply search filter to all nodes
    function applySearchFilter() {
      if (!graphData) return;
      
      // Update file rectangles
      d3.selectAll('.file-rect')
        .transition()
        .duration(200)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (nodeMatchesSearch(node)) {
            return getFileColor(node);
          }
          return '#444'; // Light gray for non-matching
        });
      
      // Update file labels
      d3.selectAll('.file-label')
        .transition()
        .duration(200)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (nodeMatchesSearch(node)) {
            return getTextColor(node);
          }
          return '#888'; // Gray text for non-matching
        });
      
      // Update directory shapes
      d3.selectAll('.dir-rect')
        .transition()
        .duration(200)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (nodeMatchesSearch(node)) {
            return getDirBoxColor(node.path);
          }
          return '#444'; // Light gray for non-matching
        });
      
      // Update directory name labels
      d3.selectAll('.directory-name')
        .transition()
        .duration(200)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (nodeMatchesSearch(node)) {
            return '#000';
          }
          return '#888'; // Gray text for non-matching
        });
      
      // Update directory path labels
      d3.selectAll('.directory-path')
        .transition()
        .duration(200)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (nodeMatchesSearch(node)) {
            return '#000';
          }
          return '#888'; // Gray text for non-matching
        });
      
      // Update line count badges
      d3.selectAll('.node-sublabel')
        .transition()
        .duration(200)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (nodeMatchesSearch(node)) {
            return '#999';
          }
          return '#666'; // Darker gray for non-matching
        });
    }
    
    // Update colors based on current mode
    function updateColors() {
      if (!graphData) return;
      
      // Update file rectangles
      d3.selectAll('.file-rect')
        .transition()
        .duration(300)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (!nodeMatchesSearch(node)) return '#444';
          return getFileColor(node);
        });
      
      // Update file labels
      d3.selectAll('.file-label')
        .transition()
        .duration(300)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (!nodeMatchesSearch(node)) return '#888';
          return getTextColor(node);
        });
      
      // Update directory rectangles
      d3.selectAll('.dir-rect')
        .transition()
        .duration(300)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (!nodeMatchesSearch(node)) return '#444';
          return getDirBoxColor(node.path);
        });
      
      // Update directory text color for better contrast
      d3.selectAll('.directory-name')
        .transition()
        .duration(300)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (!nodeMatchesSearch(node)) return '#888';
          return '#000';
        });
      
      d3.selectAll('.directory-path')
        .transition()
        .duration(300)
        .style('fill', function() {
          const node = d3.select(this.parentNode).datum();
          if (!nodeMatchesSearch(node)) return '#888';
          return '#000';
        });
    }
    
    // Render graph
    function renderGraph(data) {
      graphData = data;
      
      // Use all nodes and edges (no filtering)
      const nodes = data.nodes;
      const edges = data.edges;
      
      // Apply saved positions to directory nodes
      nodes.forEach(node => {
        if (node.type === 'directory' && savedLayout[node.path]) {
          node.fx = savedLayout[node.path].x;
          node.fy = savedLayout[node.path].y;
        }
      });
      
      // Log export counts for debugging
      console.log('[Files Map Webview] Total nodes:', nodes.length);
      console.log('[Files Map Webview] File nodes:', nodes.filter(n => n.type === 'file').length);
      console.log('[Files Map Webview] Directory nodes:', nodes.filter(n => n.type === 'directory').length);
      console.log('[Files Map Webview] File nodes with exports:', 
        nodes.filter(n => n.type === 'file' && n.exportedSymbols > 0).length
      );
      console.log('[Files Map Webview] Sample export counts:', 
        nodes.filter(n => n.type === 'file').slice(0, 10).map(n => ({
          label: n.label,
          exports: n.exportedSymbols,
          color: getFileColor(n)
        }))
      );
      
      // Clear existing
      g.selectAll('*').remove();
      
      // Create force simulation
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      // Filter only containment edges for the force simulation
      const containmentEdges = edges.filter(e => e.type === 'contains');
      
      // Function to get directory size based on depth
      function getDirSize(depth) {
        // Inverse relationship: depth 0 = largest, higher depth = smaller
        // Base sizes: depth 0 = 600px, depth 1 = 450px, depth 2 = 320px, depth 3+ = 240px
        const baseSizes = [600, 450, 320, 240];
        return baseSizes[Math.min(depth, baseSizes.length - 1)];
      }
      
      // Function to get directory font size based on depth
      function getDirFontSize(depth) {
        const fontSizes = [72, 48, 28, 18];
        return fontSizes[Math.min(depth, fontSizes.length - 1)];
      }
      
      // Function to calculate width needed for text
      function getTextWidth(text, fontSize) {
        // For directories, we need to account for both parent path and dir name
        const parts = text.split('/');
        const dirName = parts[parts.length - 1];
        const parentPath = parts.slice(0, -1).join('/');
        
        // Calculate width for directory name (main text)
        const dirNameWidth = dirName.length * fontSize * 0.6;
        
        // Calculate width for parent path (70% of main font size)
        const parentFontSize = fontSize * 0.7;
        const parentPathWidth = parentPath.length * parentFontSize * 0.6;
        
        // Use the larger of the two, plus padding
        const maxWidth = Math.max(dirNameWidth, parentPathWidth);
        return maxWidth + 80; // Add padding (40px on each side)
      }
      
      simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(containmentEdges)
          .id(d => d.id)
          .distance(d => {
            // Directory-to-directory connections should be very close based on depth
            const source = d.source;
            const target = d.target;
            if (source.type === 'directory' && target.type === 'directory') {
              // Child directories stay very close to parent
              // Distance based on parent's depth: depth 0->1 = 250px, 1->2 = 200px, 2->3 = 150px
              const parentDepth = source.depth || 0;
              const distances = [250, 200, 150, 120];
              return distances[Math.min(parentDepth, distances.length - 1)];
            }
            return 120; // Normal distance for directory-to-file
          })
          .strength(d => {
            const source = d.source;
            const target = d.target;
            // Directory-to-directory connections
            if (source.type === 'directory' && target.type === 'directory') {
              return 0.5;
            }
            // Directory-to-file: only strong pull for direct containment
            // Check if target file is directly in source directory
            if (source.type === 'directory' && target.type === 'file') {
              // Extract directory path from file path
              const fileDir = target.path.substring(0, target.path.lastIndexOf('/'));
              // Only apply strong force if this is the direct parent directory
              if (source.path === fileDir) {
                return 1.2;
              }
              // No force for non-direct parent directories
              return 0;
            }
            return 0;
          })
        )
        .force('charge', d3.forceManyBody()
          .strength(d => {
            if (d.type === 'directory') {
              // Reduce repulsion between directories at different depths
              // to allow parent-child to stay close
              const depth = d.depth || 0;
              // Root directories repel strongly, deeper ones less so
              const repulsions = [-4000, -2500, -1500, -1000];
              return repulsions[Math.min(depth, repulsions.length - 1)];
            }
            // Files have minimal repulsion - they mostly orbit their parent
            return -100;
          })
        )
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide()
          .radius(d => {
            if (d.type === 'directory') {
              // Directory collision based on actual width (accounting for text)
              const baseSize = getDirSize(d.depth || 0);
              const fontSize = getDirFontSize(d.depth || 0);
              const textWidth = getTextWidth(d.label, fontSize);
              const width = Math.max(baseSize, textWidth);
              const height = baseSize * 0.3; // Height is 30% of width
              return Math.sqrt(width * width + height * height) / 2 + 50;
            }
            // File collision based on its size with generous padding to prevent overlap
            const boxWidth = d.size;
            const boxHeight = d.size / 2;
            return Math.sqrt(boxWidth * boxWidth + boxHeight * boxHeight) / 2 + 30;
          })
          .strength(1.2)
        )
        .force('x', d3.forceX(width / 2).strength(0.02))
        .force('y', d3.forceY(height / 2).strength(0.02));
      
      // Create edges (only directory-to-file connections)
      const edgeGroup = g.append('g').attr('class', 'edges');
      
      const edgeElements = edgeGroup.selectAll('path')
        .data(containmentEdges)
        .enter()
        .append('path')
        .attr('class', 'edge-directory')
        .style('stroke', d => {
          // Make directory-to-directory connections brighter
          const source = d.source;
          const target = d.target;
          if (source.type === 'directory' && target.type === 'directory') {
            return '#4a9eff'; // Bright blue for directory hierarchy
          }
          return '#888'; // Gray for directory-to-file
        })
        .style('stroke-width', d => {
          const source = d.source;
          const target = d.target;
          if (source.type === 'directory' && target.type === 'directory') {
            return 3; // Thicker for directory hierarchy
          }
          return 1.5; // Normal for directory-to-file
        })
        .style('opacity', d => {
          const source = d.source;
          const target = d.target;
          if (source.type === 'directory' && target.type === 'directory') {
            return 0.9; // More visible for directory hierarchy
          }
          return 0.5; // Less visible for directory-to-file
        });
      
      // Create nodes
      const nodeGroup = g.append('g').attr('class', 'nodes');
      
      const nodeElements = nodeGroup.selectAll('g')
        .data(nodes)
        .enter()
        .append('g')
        .attr('class', d => d.type === 'directory' ? 'node-directory' : 'node-file')
        .call(d3.drag()
          .filter(function(event, d) {
            // Only allow drag for directory nodes, not files
            return d.type === 'directory';
          })
          .on('start', dragStarted)
          .on('drag', dragged)
          .on('end', dragEnded)
        )
        .on('click', function(event, d) {
          // Stop simulation immediately to prevent shuffling
          if (simulation) {
            simulation.stop();
          }
          // Single click: zoom to node
          zoomToNode(d);
        })
        .on('dblclick', (event, d) => {
          // Double click: open file
          if (d.type === 'file') {
            event.stopPropagation();
            vscode.postMessage({ type: 'file:open', filePath: d.path });
          }
        })
      
      // Add rectangles for files
      const fileNodesForRects = nodeElements.filter(d => d.type === 'file');
      console.log('[Files Map Webview] Creating file rectangles for', fileNodesForRects.size(), 'files');
      
      const fileRects = fileNodesForRects
        .append('rect')
        .attr('width', d => d.size)
        .attr('height', d => d.size / 2)
        .attr('x', d => -d.size / 2)
        .attr('y', d => -d.size / 4)
        .attr('rx', 4)
        .attr('ry', 4)
        .attr('class', 'file-rect')
        .style('fill', d => getFileColor(d));
      
      console.log('[Files Map Webview] File rectangles created:', fileRects.size());
      
      // Function to get directory size based on depth
      function getDirSize(depth) {
        const baseSizes = [600, 450, 320, 240];
        return baseSizes[Math.min(depth, baseSizes.length - 1)];
      }
      
      // Function to get directory font size based on depth
      function getDirFontSize(depth) {
        const fontSizes = [72, 48, 28, 18];
        return fontSizes[Math.min(depth, fontSizes.length - 1)];
      }
      
      // Function to calculate width needed for text
      function getTextWidth(text, fontSize) {
        // For directories, we need to account for both parent path and dir name
        const parts = text.split('/');
        const dirName = parts[parts.length - 1];
        const parentPath = parts.slice(0, -1).join('/');
        
        // Calculate width for directory name (main text)
        const dirNameWidth = dirName.length * fontSize * 0.6;
        
        // Calculate width for parent path (70% of main font size)
        const parentFontSize = fontSize * 0.7;
        const parentPathWidth = parentPath.length * parentFontSize * 0.6;
        
        // Use the larger of the two, plus padding
        const maxWidth = Math.max(dirNameWidth, parentPathWidth);
        return maxWidth + 80; // Add padding (40px on each side)
      }

      // Add hexagonal shapes for directories (rectangle with rhombus sides)
      const dirRects = nodeElements.filter(d => d.type === 'directory')
        .append('path')
        .attr('d', d => {
          const baseSize = getDirSize(d.depth || 0);
          const fontSize = getDirFontSize(d.depth || 0);
          const textWidth = getTextWidth(d.label, fontSize);
          const width = Math.max(baseSize, textWidth);
          const height = baseSize * 0.3;
          
          // Create hexagon path: rectangle with angled left and right sides
          const indent = height * 0.4; // How much the sides angle in
          const halfWidth = width / 2;
          const halfHeight = height / 2;
          
          // Start from top-left, go clockwise
          return \`
            M \${-halfWidth + indent},\${-halfHeight}
            L \${halfWidth - indent},\${-halfHeight}
            L \${halfWidth},0
            L \${halfWidth - indent},\${halfHeight}
            L \${-halfWidth + indent},\${halfHeight}
            L \${-halfWidth},0
            Z
          \`;
        })
        .attr('class', 'dir-rect')
        .style('fill', d => getDirBoxColor(d.path))
        .style('stroke', '#fff')
        .style('stroke-width', 6);
      
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
      
      // Add parent path label for directories (smaller, above)
      nodeElements.filter(d => d.type === 'directory')
        .append('text')
        .attr('class', 'node-label directory-path')
        .attr('x', 0)
        .attr('y', d => {
          const fontSize = getDirFontSize(d.depth || 0);
          return -fontSize * 0.65; // Position above the main label with more padding
        })
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', d => {
          const fontSize = getDirFontSize(d.depth || 0);
          return \`\${Math.round(fontSize * 0.7)}px\`; // 70% of main font size (2x increase from 35%)
        })
        .style('fill', '#000')
        .style('font-weight', 'normal')
        .text(d => {
          // Extract parent path (everything except the last segment)
          const parts = d.label.split('/');
          if (parts.length <= 1) return ''; // No parent path
          return parts.slice(0, -1).join('/');
        });
      
      // Add directory name label (larger, centered)
      nodeElements.filter(d => d.type === 'directory')
        .append('text')
        .attr('class', 'node-label directory-name')
        .attr('x', 0)
        .attr('y', d => {
          const fontSize = getDirFontSize(d.depth || 0);
          const parts = d.label.split('/');
          // If there's a parent path, shift down with more padding
          return parts.length > 1 ? fontSize * 0.35 : 0;
        })
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', d => {
          const fontSizes = [72, 48, 28, 18];
          const fontSize = fontSizes[Math.min(d.depth || 0, fontSizes.length - 1)];
          return \`\${fontSize}px\`;
        })
        .style('fill', '#000')
        .style('font-weight', 'bold')
        .text(d => {
          // Extract just the directory name (last segment)
          const parts = d.label.split('/');
          return parts[parts.length - 1];
        });
      
      // Add labels for files
      nodeElements.filter(d => d.type === 'file')
        .append('text')
        .attr('class', 'node-label')
        .attr('x', 0)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', d => {
          // Scale font size based on box width (150-350px -> 10-16px)
          const minFont = 10;
          const maxFont = 16;
          const fontSize = minFont + ((d.size - 150) / (350 - 150)) * (maxFont - minFont);
          return \`\${Math.round(fontSize)}px\`;
        })
        .attr('class', 'file-label')
        .style('fill', d => getTextColor(d))
        .style('font-weight', 'normal')
        .text(d => {
          // Truncate filename based on box width with padding
          const fontSize = 10 + ((d.size - 150) / (350 - 150)) * (16 - 10);
          const avgCharWidth = fontSize * 0.6;
          const padding = 4;
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
        
        nodeElements.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
      });
    }
    
    // Save layout to backend
    function saveLayout() {
      if (!graphData) return;
      
      const layout = {};
      
      // Save positions of all directory nodes
      graphData.nodes.forEach(node => {
        if (node.type === 'directory' && node.fx !== undefined && node.fy !== undefined) {
          layout[node.path] = { x: node.fx, y: node.fy };
        }
      });
      
      vscode.postMessage({
        type: 'layout:save',
        layout
      });
    }
    
    // Drag handlers
    function dragStarted(event, d) {
      // Store starting position to detect actual drag vs click
      d.dragStartX = event.x;
      d.dragStartY = event.y;
      d.wasDragged = false;
      
      // Fix position
      d.fx = d.x;
      d.fy = d.y;
      
      // Restart simulation with low alpha for smooth updates
      if (simulation) {
        simulation.alphaTarget(0.3).restart();
      }
    }
    
    function dragged(event, d) {
      // Calculate distance moved
      const dx = event.x - d.dragStartX;
      const dy = event.y - d.dragStartY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Deadzone: only start dragging if moved more than 10 pixels
      const DEADZONE = 10;
      
      if (distance > DEADZONE) {
        d.wasDragged = true;
        
        // Update position during drag (only after deadzone exceeded)
        d.fx = event.x;
        d.fy = event.y;
      }
    }
    
    function dragEnded(event, d) {
      // Stop simulation
      if (simulation) {
        simulation.alphaTarget(0);
      }
      
      // Keep node fixed after drag
      // Don't unfix position - keep it where user dragged it
      
      // Save layout if this was a directory and was actually dragged
      if (d.type === 'directory' && d.wasDragged) {
        saveLayout();
      }
      
      // If it was a real drag, prevent click event
      if (d.wasDragged) {
        event.sourceEvent.stopPropagation();
      }
    }
    
    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'graph:update':
          renderGraph(message.data);
          break;
        case 'layout:loaded':
          savedLayout = message.layout || {};
          console.log('[Files Map] Layout loaded with', Object.keys(savedLayout).length, 'directory positions');
          // If graph is already rendered, apply the layout
          if (graphData) {
            graphData.nodes.forEach(node => {
              if (node.type === 'directory' && savedLayout[node.path]) {
                node.fx = savedLayout[node.path].x;
                node.fy = savedLayout[node.path].y;
                node.x = savedLayout[node.path].x;
                node.y = savedLayout[node.path].y;
              }
            });
            if (simulation) {
              simulation.alpha(0.3).restart();
            }
          }
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


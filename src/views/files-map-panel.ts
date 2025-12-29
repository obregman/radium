import * as vscode from 'vscode';
import { GraphStore, Node, Edge, FileRecord, EdgeKind, FileSmell } from '../store/schema';
import * as path from 'path';
import * as fs from 'fs';
import { RadiumIgnore } from '../config/radium-ignore';

interface SmellDetails {
  functionCount: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  maxNestingDepth: number;
  importCount: number;
}

interface FileNode {
  id: string;
  type: 'file';
  label: string;
  path: string;
  lines: number;
  lang: string;
  size: number;
  exportedSymbols: number;
  smellScore: number;
  smellDetails: SmellDetails | null;
  functions: string[];
  variables: string[];
  types: string[];
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
    
    // Handle panel visibility changes (when moved, hidden, or shown)
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          // Re-send graph data to ensure proper rendering
          this.updateGraph();
        }
      },
      null,
      this.disposables
    );
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
      case 'file:copy':
        await this.handleFileCopy(message.filePath);
        break;
      case 'dir:unpin':
        await this.handleDirUnpin(message.dirPath);
        break;
    }
  }

  private async handleFileCopy(filePath: string) {
    try {
      await vscode.env.clipboard.writeText(filePath);
      vscode.window.showInformationMessage(`Copied: ${filePath}`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to copy file path: ${filePath}`);
      console.error('[Files Map] Error copying file path:', error);
    }
  }

  private async handleDirUnpin(dirPath: string) {
    try {
      const layoutFile = path.join(this.workspaceRoot, '.radium', 'file-map-layout.json');
      
      if (fs.existsSync(layoutFile)) {
        const layoutData = fs.readFileSync(layoutFile, 'utf-8');
        const layout = JSON.parse(layoutData);
        
        // Remove the directory from the layout
        if (layout[dirPath]) {
          delete layout[dirPath];
          
          // Save updated layout
          fs.writeFileSync(layoutFile, JSON.stringify(layout, null, 2), 'utf-8');
          console.log('[Files Map] Unpinned directory:', dirPath);
          
          // Notify webview to update the node
          this.panel.webview.postMessage({
            type: 'dir:unpinned',
            dirPath
          });
        }
      }
    } catch (error) {
      console.error('[Files Map] Error unpinning directory:', error);
      vscode.window.showErrorMessage(`Failed to unpin directory: ${dirPath}`);
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
      // Normalize path separators for cross-platform compatibility
      const normalizedPath = filePath.replace(/\\/g, '/');
      const fullPath = vscode.Uri.file(
        normalizedPath.startsWith('/') ? normalizedPath : path.join(workspaceRoot, normalizedPath)
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
    const allFileSmells = this.store.getAllFileSmells();
    
    // Build a map of file path to smell data (score and details)
    const fileSmellMap = new Map<string, { score: number; details: SmellDetails }>();
    for (const smell of allFileSmells) {
      const file = files.find(f => f.id === smell.file_id);
      if (file) {
        fileSmellMap.set(file.path, {
          score: smell.score,
          details: {
            functionCount: smell.function_count,
            avgFunctionLength: smell.avg_function_length,
            maxFunctionLength: smell.max_function_length,
            maxNestingDepth: smell.max_nesting_depth,
            importCount: smell.import_count
          }
        });
      }
    }
    
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
      
      // Get smell data
      const smellData = fileSmellMap.get(file.path);
      const smellScore = smellData?.score || 0;
      const smellDetails = smellData?.details || null;
      
      // Get functions and variables for this file
      const fileNodes = allNodes.filter(n => n.path === file.path);
      const functions = fileNodes
        .filter(n => n.kind === 'function' || n.kind === 'method' || n.kind === 'constructor')
        .map(n => n.name + '()')
        .filter((name, index, self) => self.indexOf(name) === index) // Remove duplicates
        .slice(0, 20); // Limit to 20 for performance
      
      // Get all function ranges to filter out function-level variables
      const functionRanges = fileNodes
        .filter(n => n.kind === 'function' || n.kind === 'method' || n.kind === 'constructor')
        .map(n => ({ start: n.range_start, end: n.range_end }));
      
      // Get all type definition ranges to filter out type-level fields
      const typeRanges = fileNodes
        .filter(n => n.kind === 'class' || n.kind === 'interface' || n.kind === 'type' || n.kind === 'enum' || n.kind === 'struct')
        .map(n => ({ name: n.name, start: n.range_start, end: n.range_end }));
      
      // Determine if this is a C# or TypeScript file and get the main class name
      const isCSharp = file.lang === 'csharp';
      const isTypeScript = file.lang === 'typescript' || file.lang === 'javascript';
      const fileNameWithoutExt = fileName.replace(/\.(cs|xaml\.cs|ts|tsx|js|jsx)$/i, '');
      
      // For C# and TypeScript files, find the main class (the one matching the filename)
      const mainClassRange = (isCSharp || isTypeScript) ? typeRanges.find(t => t.name === fileNameWithoutExt) : null;
      
      // Filter variables based on language
      const variables = fileNodes
        .filter(n => {
          // Only include variable or constant kinds
          if (!(n.kind === 'variable' || n.kind === 'constant')) {
            return false;
          }
          
          // Check if this variable is inside any function
          const isInsideFunction = functionRanges.some(fn => 
            n.range_start > fn.start && n.range_end < fn.end
          );
          
          // For C# and TypeScript files: include class member variables (inside the main class) but exclude function-level variables
          if ((isCSharp || isTypeScript) && mainClassRange) {
            const isInsideMainClass = n.range_start > mainClassRange.start && n.range_end < mainClassRange.end;
            return isInsideMainClass && !isInsideFunction;
          }
          
          // For other files: only include global-level variables (not inside functions or types)
          const isInsideType = typeRanges.some(type => 
            n.range_start > type.start && n.range_end < type.end
          );
          return !isInsideFunction && !isInsideType;
        })
        .map(n => n.name)
        .filter((name, index, self) => self.indexOf(name) === index) // Remove duplicates
        .slice(0, 20); // Limit to 20 for performance
      
      // Get types (class, interface, type, enum, struct)
      // For C# and TypeScript files: exclude the main class (the one matching the filename)
      const types = fileNodes
        .filter(n => {
          if (!(n.kind === 'class' || n.kind === 'interface' || n.kind === 'type' || n.kind === 'enum' || n.kind === 'struct')) {
            return false;
          }
          // For C# and TypeScript files, exclude the main class
          if ((isCSharp || isTypeScript) && n.name === fileNameWithoutExt) {
            return false;
          }
          return true;
        })
        .map(n => n.name)
        .filter((name, index, self) => self.indexOf(name) === index) // Remove duplicates
        .slice(0, 20); // Limit to 20 for performance
      
      nodes.push({
        id: file.path,
        type: 'file',
        label: fileName,
        path: file.path,
        lines,
        lang: file.lang,
        size,
        exportedSymbols,
        smellScore,
        smellDetails,
        functions,
        variables,
        types
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
    
    #color-mode-select {
      background: #2d2d2d;
      color: #d4d4d4;
      border: 1px solid #555;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 13px;
      cursor: pointer;
      outline: none;
      min-width: 180px;
    }
    
    #color-mode-select:hover {
      background: #3d3d3d;
      border-color: #666;
    }
    
    #color-mode-select:focus {
      border-color: #007acc;
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
    
    .copy-button {
      opacity: 0;
      transition: opacity 0.3s;
      cursor: pointer;
      pointer-events: none;
    }
    
    .copy-button.visible {
      opacity: 1;
      pointer-events: all;
    }
    
    .copy-button rect {
      pointer-events: all;
      cursor: pointer;
    }
    
    
    .arrow {
      fill: currentColor;
    }
    
    #tooltip {
      position: absolute;
      background: rgba(30, 30, 30, 0.95);
      color: #d4d4d4;
      padding: 8px 12px;
      border-radius: 4px;
      border: 1px solid #555;
      font-size: 13px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
      z-index: 2000;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    }
    
    #tooltip.visible {
      opacity: 1;
    }
    
    .tooltip-filename {
      font-weight: bold;
      margin-bottom: 4px;
    }
    
    .tooltip-lines {
      font-size: 11px;
      color: #999;
    }
    
    .smell-details-panel {
      background: rgba(30, 30, 30, 0.95);
      color: #d4d4d4;
      padding: 8px 12px;
      font-size: 13px;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
      text-align: left;
      border-radius: 6px;
      border: 1px solid #555;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
      width: 100%;
      box-sizing: border-box;
    }
    
    .smell-details-panel.visible {
      opacity: 1;
    }
    
    .smell-header {
      font-size: 13px;
      margin-bottom: 3px;
      white-space: nowrap;
    }
    
    .smell-score {
      font-weight: bold;
    }
    
    .smell-score.clean { color: #52B788; }
    .smell-score.minor { color: #98D8C8; }
    .smell-score.moderate { color: #F7DC6F; }
    .smell-score.significant { color: #FFA07A; }
    .smell-score.high { color: #E63946; }
    
    .smell-metrics {
      display: flex;
      flex-direction: column;
      gap: 1px;
      align-items: flex-start;
    }
    
    .smell-metric {
      font-size: 13px;
      color: #d4d4d4;
      text-align: left;
      white-space: nowrap;
    }
    
    .smell-metric-value {
      font-weight: bold;
    }
    
    .symbol-triangle {
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
      cursor: pointer;
    }
    
    .symbol-triangle.visible {
      opacity: 1;
      pointer-events: all;
    }
    
    .symbol-triangle rect {
      fill: #F7DC6F;
      stroke: #000;
      stroke-width: 1;
      transition: fill 0.3s;
    }
    
    .symbol-triangle.empty rect {
      fill: #666;
    }
    
    .symbol-list-panel {
      background: #4a4a4a;
      color: #ffffff;
      padding: 6px 10px;
      border-radius: 4px;
      border: 2px solid #ffffff;
      font-size: 9px;
      max-height: 120px;
      overflow-y: auto;
      overflow-x: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
      width: fit-content;
      min-width: 80px;
    }
    
    .symbol-list-panel::-webkit-scrollbar {
      width: 6px;
    }
    
    .symbol-list-panel::-webkit-scrollbar-track {
      background: #2a2a2a;
      border-radius: 3px;
    }
    
    .symbol-list-panel::-webkit-scrollbar-thumb {
      background: #666;
      border-radius: 3px;
    }
    
    .symbol-list-panel::-webkit-scrollbar-thumb:hover {
      background: #888;
    }
    
    .symbol-list-item {
      padding: 1px 0;
      white-space: nowrap;
      font-family: 'Courier New', monospace;
    }
    
    #zoom-indicator {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      padding: 8px 16px;
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border);
      font-size: 14px;
      font-weight: 500;
      z-index: 1000;
      font-family: 'Courier New', monospace;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
  </style>
</head>
<body>
  <div id="controls">
    <input type="text" id="search-box" placeholder="Search files and directories..." />
    <select id="color-mode-select">
      <option value="directory">Color by Parent Directory</option>
      <option value="symbol">Color by Symbol Use</option>
      <option value="smell">Color by Code Smell</option>
    </select>
  </div>
  <div id="tooltip">
    <div class="tooltip-filename"></div>
    <div class="tooltip-lines"></div>
  </div>
  <div id="zoom-indicator">100%</div>
  <svg id="graph"></svg>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    let graphData = null;
    let simulation = null;
    let svg = null;
    let g = null;
    let zoom = null;
    let colorMode = 'directory'; // 'symbol', 'directory', or 'smell'
    let searchQuery = '';
    let savedLayout = {}; // Stores saved directory positions
    let tooltipTimeout = null;
    let tooltip = null;
    let isDragging = false;
    let currentSmellDetailsNode = null; // Track which node has smell details shown
    let currentCenteredNode = null; // Track which node is currently centered (for copy button)
    let updateDirectorySizes = null; // Function to update directory sizes on zoom (assigned in renderGraph)
    let filteredNodes = []; // Track filtered nodes for navigation
    let currentFilteredIndex = -1; // Current index in filtered nodes
    
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
    
    // Function to get color based on code smell score (0-100)
    // Green (clean) -> Yellow (moderate) -> Red (high smells)
    function getFileColorBySmell(smellScore) {
      if (smellScore <= 20) return '#52B788'; // Green - Clean code
      if (smellScore <= 40) return '#98D8C8'; // Light Green - Minor issues
      if (smellScore <= 60) return '#F7DC6F'; // Yellow - Moderate concerns
      if (smellScore <= 80) return '#FFA07A'; // Orange - Significant smells
      return '#E63946'; // Red - High smell density
    }
    
    // Function to get color based on current mode
    function getFileColor(node) {
      if (colorMode === 'directory') {
        return getFileColorByDirectory(node.path);
      } else if (colorMode === 'smell') {
        return getFileColorBySmell(node.smellScore);
      } else {
        return getFileColorBySymbols(node.exportedSymbols);
      }
    }
    
    // Function to get directory box color
    function getDirBoxColor(dirPath) {
      if (colorMode === 'directory') {
        return getDirectoryColor(dirPath);
      } else {
        return '#fff'; // White for symbol/smell mode
      }
    }
    
    // Function to get text color based on current mode and node
    function getTextColor(node) {
      if (colorMode === 'directory') {
        // For directory mode, use dark text on colored backgrounds
        return '#000';
      } else if (colorMode === 'smell') {
        // For smell mode, adjust based on background color
        const smellScore = node.smellScore;
        if (smellScore <= 40) return '#000'; // dark text for green/light green
        if (smellScore <= 80) return '#333'; // dark gray text for yellow/orange
        return '#fff'; // white text for red
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
        .scaleExtent([0.01, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
          // Update directory sizes and fonts when zoom changes
          if (updateDirectorySizes) {
            updateDirectorySizes(event.transform.k);
          }
          // Update copy button and smell details based on zoom level
          updateCenteredElements();
          // Update zoom indicator
          const zoomPercent = Math.round(event.transform.k * 100);
          d3.select('#zoom-indicator').text(zoomPercent + '%');
        });
      
      svg.call(zoom);
      
      // Hide smell details when clicking on background
      svg.on('click', (event) => {
        // Only hide if clicking directly on the SVG (not a node)
        if (event.target.tagName === 'svg') {
          hideSmellDetails();
        }
      });
      
      // Create container group
      g = svg.append('g');
      
      // Get tooltip element
      tooltip = document.getElementById('tooltip');
      
      // Setup search box
      const searchBox = document.getElementById('search-box');
      searchBox.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        applySearchFilter();
      });
      
      // Add keyboard navigation for filtered results (Ctrl+N)
      document.addEventListener('keydown', (e) => {
        // Check for Ctrl+N (or Cmd+N on Mac)
        if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
          e.preventDefault();
          navigateToNextFilteredNode();
        }
      });
      
      // Setup color mode dropdown
      const colorModeSelect = document.getElementById('color-mode-select');
      colorModeSelect.addEventListener('change', (e) => {
        const mode = e.target.value;
        if (mode !== colorMode) {
          colorMode = mode;
          
          // Update colors
          updateColors();
          
          // Always check for centered file when switching modes
          checkAndShowCenteredFile();
        }
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
    
    // Show tooltip
    function showTooltip(event, node) {
      if (!tooltip) return;
      
      const filenameEl = tooltip.querySelector('.tooltip-filename');
      const linesEl = tooltip.querySelector('.tooltip-lines');
      
      if (node.type === 'copy-button') {
        filenameEl.textContent = node.label;
        linesEl.textContent = '';
      } else if (node.type === 'pin-indicator') {
        filenameEl.textContent = node.label;
        linesEl.textContent = '';
      } else if (node.type === 'file') {
        filenameEl.textContent = node.label;
        let details = node.lines + ' lines';
        if (colorMode === 'smell') {
          const score = node.smellScore || 0;
          let rating = 'Clean';
          if (score > 80) rating = 'High';
          else if (score > 60) rating = 'Significant';
          else if (score > 40) rating = 'Moderate';
          else if (score > 20) rating = 'Minor';
          details += ' | Smell: ' + rating + ' (' + score + ')';
        }
        linesEl.textContent = details;
      } else if (node.type === 'directory') {
        filenameEl.textContent = node.path;
        linesEl.textContent = '';
      }
      
      updateTooltipPosition(event);
      tooltip.classList.add('visible');
    }
    
    // Update tooltip position
    function updateTooltipPosition(event) {
      if (!tooltip) return;
      
      const offset = 10;
      tooltip.style.left = (event.pageX + offset) + 'px';
      tooltip.style.top = (event.pageY + offset) + 'px';
    }
    
    // Hide tooltip
    function hideTooltip() {
      if (!tooltip) return;
      tooltip.classList.remove('visible');
    }
    
    // Show symbol list in a popup on hover
    let currentSymbolListNode = null;
    let symbolListHideTimeout = null;
    
    function showSymbolList(node, symbolType) {
      // Clear any pending hide timeout
      if (symbolListHideTimeout) {
        clearTimeout(symbolListHideTimeout);
        symbolListHideTimeout = null;
      }
      
      // Hide file tooltip when showing symbol list
      hideTooltip();
      if (tooltipTimeout) {
        clearTimeout(tooltipTimeout);
        tooltipTimeout = null;
      }
      
      // Don't recreate if already showing for this node and symbolType
      if (currentSymbolListNode === node.id + '-' + symbolType) {
        return;
      }
      
      // Remove any existing symbol list
      d3.selectAll('.symbol-list-group').remove();
      currentSymbolListNode = node.id + '-' + symbolType;
      
      const symbols = symbolType === 'functions' ? node.functions : 
                      symbolType === 'variables' ? node.variables : 
                      node.types;
      if (symbols.length === 0) return;
      
      // Create foreignObject for the symbol list
      const listGroup = g.append('g')
        .attr('class', 'symbol-list-group')
        .attr('transform', \`translate(\${node.x}, \${node.y})\`);
      
      // Calculate tooltip dimensions based on content
      const fileBoxHeight = node.size / 2;
      const tooltipHeight = 200;
      
      // Calculate width based on longest symbol name
      // Monospace font: 9px font size * ~0.6 char width ratio = 5.4px per character
      // Add padding (20px total: 10px left + 10px right)
      // Add scrollbar (6px) + border (4px) = 10px
      // Total extra space: 30px
      const longestSymbol = symbols.reduce((max, s) => s.length > max.length ? s : max, '');
      const estimatedWidth = Math.max(
        longestSymbol.length * 5.4 + 30, // 5.4px per char + padding + scrollbar + border
        80 // minimum width
      );
      const tooltipWidth = Math.min(Math.ceil(estimatedWidth), 200); // cap at 200px, round up
      
      // Position calculation
      const squareOffsetFromBox = 15; // Distance from box edge to square center
      const squareSize = 16; // Size of the rounded square
      const gapFromSquare = 15; // Gap between tooltip and square edge
      
      // For variables (left side): tooltip should be completely to the left of the square
      // Calculate: -fileBoxWidth/2 - squareOffset - squareHalfSize - gap - tooltipWidth
      // For functions (right side): tooltip should be completely to the right of the square
      // Calculate: +fileBoxWidth/2 + squareOffset + squareHalfSize + gap
      // For types (top): tooltip should be above the square with same gap
      let offsetX, offsetY;
      
      if (symbolType === 'variables') {
        offsetX = -node.size / 2 - squareOffsetFromBox - squareSize / 2 - gapFromSquare - tooltipWidth;
        offsetY = -fileBoxHeight / 2;
      } else if (symbolType === 'functions') {
        offsetX = node.size / 2 + squareOffsetFromBox + squareSize / 2 + gapFromSquare;
        offsetY = -fileBoxHeight / 2;
      } else { // types (top)
        // Center horizontally
        offsetX = -tooltipWidth / 2;
        // Types icon center is at: -fileBoxHeight/2 - squareOffsetFromBox (which is -node.size/4 - 15)
        // Top edge of icon is at: icon center - squareSize/2
        // Tooltip should appear ABOVE the icon with a gap
        // foreignObject y is the top-left corner where content starts flowing DOWN
        // So we need: y = icon_top - gap - actual_content_height
        // Since we don't know actual content height, use a reasonable estimate (120px max)
        const iconCenterY = -fileBoxHeight / 2 - squareOffsetFromBox;
        const iconTopY = iconCenterY - squareSize / 2;
        // Position tooltip so its bottom edge is gapFromSquare above icon top
        // Estimate tooltip content height as 120px (enough for ~12 items)
        // Add extra 5px clearance to ensure no overlap with the icon
        const estimatedContentHeight = Math.min(symbols.length * 10 + 12, 120);
        offsetY = iconTopY - gapFromSquare - estimatedContentHeight - 5;
      }
      
      // Create HTML content
      const symbolsHTML = symbols.map(s => \`<div class="symbol-list-item">\${s}</div>\`).join('');
      const panelHTML = \`<div class="symbol-list-panel">\${symbolsHTML}</div>\`;
      
      const foreignObj = listGroup.append('foreignObject')
        .attr('x', offsetX)
        .attr('y', offsetY)
        .attr('width', tooltipWidth)
        .attr('height', tooltipHeight)
        .style('pointer-events', 'all')
        .style('overflow', 'visible')
        .html(panelHTML);
      
      // Add event listeners after a short delay to ensure DOM is ready
      setTimeout(() => {
        const panel = foreignObj.node().querySelector('.symbol-list-panel');
        if (panel) {
          panel.addEventListener('mouseenter', function() {
            // Cancel hide when mouse enters the list
            if (symbolListHideTimeout) {
              clearTimeout(symbolListHideTimeout);
              symbolListHideTimeout = null;
            }
          });
          
          panel.addEventListener('mouseleave', function() {
            // Hide after delay when mouse leaves the list
            hideSymbolListWithDelay();
          });
          
          // Prevent scroll events from bubbling to the SVG zoom
          panel.addEventListener('wheel', function(e) {
            e.stopPropagation();
          });
        }
      }, 10);
    }
    
    function hideSymbolListWithDelay() {
      symbolListHideTimeout = setTimeout(() => {
        d3.selectAll('.symbol-list-group').remove();
        currentSymbolListNode = null;
        symbolListHideTimeout = null;
      }, 300);
    }
    
    function hideSymbolListImmediately() {
      if (symbolListHideTimeout) {
        clearTimeout(symbolListHideTimeout);
        symbolListHideTimeout = null;
      }
      d3.selectAll('.symbol-list-group').remove();
      currentSymbolListNode = null;
    }
    
    // Show smell details panel under a file node
    function showSmellDetails(node) {
      if (node.type !== 'file') return;
      
      // Remove any existing panel
      hideSmellDetails();
      
      // Get current zoom scale
      const currentTransform = d3.zoomTransform(svg.node());
      const scale = currentTransform.k;
      
      // Hide if zoomed out too far
      if (scale < 0.5) return;
      
      currentSmellDetailsNode = node;
      
      const score = node.smellScore || 0;
      const details = node.smellDetails;
      
      // Create foreignObject to hold HTML content
      // Position it below the file box, vertically centered
      const panelGroup = g.append('g')
        .attr('class', 'smell-details-group')
        .attr('transform', \`translate(\${node.x}, \${node.y + node.size / 4 + 20})\`);
      
      // Create the panel HTML
      let metricsHTML = '';
      if (details) {
        metricsHTML = \`
          <div class="smell-metric">Functions: <span class="smell-metric-value">\${details.functionCount}</span></div>
          <div class="smell-metric">Avg func len: <span class="smell-metric-value">\${Math.round(details.avgFunctionLength)}</span></div>
          <div class="smell-metric">Max func len: <span class="smell-metric-value">\${details.maxFunctionLength}</span></div>
          <div class="smell-metric">Max nesting: <span class="smell-metric-value">\${details.maxNestingDepth}</span></div>
          <div class="smell-metric">Imports: <span class="smell-metric-value">\${details.importCount}</span></div>
        \`;
      } else {
        metricsHTML = \`
          <div class="smell-metric">No data available</div>
        \`;
      }
      
      let scoreClass = 'clean';
      if (score > 80) scoreClass = 'high';
      else if (score > 60) scoreClass = 'significant';
      else if (score > 40) scoreClass = 'moderate';
      else if (score > 20) scoreClass = 'minor';
      
      const panelHTML = \`
        <div class="smell-details-panel visible">
          <div class="smell-header">Code smell score: <span class="smell-score \${scoreClass}">\${score}</span></div>
          <div class="smell-metrics">
            \${metricsHTML}
          </div>
        </div>
      \`;
      
      // Calculate width based on content
      // Find the longest line in the metrics
      const lines = [
        \`Code smell score: \${score}\`,
        \`Functions: \${details?.functionCount || 0}\`,
        \`Avg func len: \${details ? Math.round(details.avgFunctionLength) : 0}\`,
        \`Max func len: \${details?.maxFunctionLength || 0}\`,
        \`Max nesting: \${details?.maxNestingDepth || 0}\`,
        \`Imports: \${details?.importCount || 0}\`
      ];
      const longestLine = lines.reduce((max, line) => line.length > max.length ? line : max, '');
      
      // Estimate width: ~7px per character + padding (24px) + border (2px)
      const estimatedWidth = Math.max(
        longestLine.length * 7 + 26,
        180 // minimum width
      );
      const panelWidth = Math.min(Math.ceil(estimatedWidth), 350); // cap at 350px
      const panelHeight = 130;
      
      // Center the panel horizontally to align with the file box center
      panelGroup.append('foreignObject')
        .attr('x', -panelWidth / 2)
        .attr('y', 0)
        .attr('width', panelWidth)
        .attr('height', panelHeight)
        .style('overflow', 'visible')
        .html(panelHTML);
    }
    
    // Hide smell details panel
    function hideSmellDetails() {
      d3.selectAll('.smell-details-group').remove();
      currentSmellDetailsNode = null;
    }
    
    // Update smell details position when simulation ticks or zoom changes
    function updateSmellDetailsPosition() {
      // Always check for centered file on zoom/pan changes
      checkAndShowCenteredFile();
      
      // Update position if we have a current node
      if (currentSmellDetailsNode) {
        const node = currentSmellDetailsNode;
        d3.selectAll('.smell-details-group')
          .attr('transform', \`translate(\${node.x}, \${node.y + node.size / 4 + 20})\`);
      }
    }
    
    // Update symbol triangles visibility - only for centered file
    function updateSymbolTrianglesVisibility() {
      if (!graphData) return;
      
      const width = window.innerWidth;
      const height = window.innerHeight;
      const currentTransform = d3.zoomTransform(svg.node());
      const scale = currentTransform.k;
      
      // Hide all triangles first
      d3.selectAll('.symbol-triangle').classed('visible', false);
      
      // Only show when zoomed in enough (scale >= 1.0)
      if (scale < 1.0) return;
      
      // Calculate viewport center in graph coordinates
      const centerX = (width / 2 - currentTransform.x) / scale;
      const centerY = (height / 2 - currentTransform.y) / scale;
      
      // Find the file node closest to center
      let closestNode = null;
      let minDistance = Infinity;
      
      graphData.nodes.forEach(node => {
        if (node.type !== 'file') return;
        
        const dx = node.x - centerX;
        const dy = node.y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // Only consider nodes within a reasonable distance (within their own size)
        if (distance < node.size && distance < minDistance) {
          minDistance = distance;
          closestNode = node;
        }
      });
      
      // Show triangles only for the centered node
      if (closestNode) {
        d3.selectAll('.symbol-triangle')
          .filter(function() {
            const node = d3.select(this.parentNode).datum();
            return node === closestNode;
          })
          .classed('visible', true);
      }
    }
    
    // Update copy button, pin indicators, smell details, and triangles on zoom/pan
    function updateCenteredElements() {
      updateCopyButtonVisibility();
      updatePinIndicatorVisibility();
      updateSmellDetailsPosition();
      updateSymbolTrianglesVisibility();
      
      // Hide symbol list if not hovering over centered node's triangles
      const currentTransform = d3.zoomTransform(svg.node());
      const scale = currentTransform.k;
      if (scale < 1.0) {
        hideSymbolListImmediately();
      }
    }
    
    // Check if a file is centered and show its smell details
    function checkAndShowCenteredFile() {
      if (!graphData) return;
      
      const width = window.innerWidth;
      const height = window.innerHeight;
      const currentTransform = d3.zoomTransform(svg.node());
      const scale = currentTransform.k;
      
      // Only auto-show when zoomed in enough
      if (scale < 1.0) {
        hideSmellDetails();
        return;
      }
      
      // Calculate viewport center in graph coordinates
      const centerX = (width / 2 - currentTransform.x) / scale;
      const centerY = (height / 2 - currentTransform.y) / scale;
      
      // Find the file node closest to center
      let closestNode = null;
      let minDistance = Infinity;
      
      graphData.nodes.forEach(node => {
        if (node.type !== 'file') return;
        
        const dx = node.x - centerX;
        const dy = node.y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // Only consider nodes within a reasonable distance (within their own size)
        if (distance < node.size && distance < minDistance) {
          minDistance = distance;
          closestNode = node;
        }
      });
      
      // If no file is centered, hide the panel
      if (!closestNode) {
        hideSmellDetails();
        return;
      }
      
      // If different file is now centered, switch to it
      if (closestNode !== currentSmellDetailsNode) {
        hideSmellDetails();
        showSmellDetails(closestNode);
      }
    }
    
    // Check if a file is centered and show copy button
    function updateCopyButtonVisibility() {
      if (!graphData) return;
      
      const width = window.innerWidth;
      const height = window.innerHeight;
      const currentTransform = d3.zoomTransform(svg.node());
      const scale = currentTransform.k;
      
      // Only show when zoomed in enough
      if (scale < 1.0) {
        // Hide all copy buttons
        d3.selectAll('.copy-button').classed('visible', false);
        currentCenteredNode = null;
        return;
      }
      
      // Calculate viewport center in graph coordinates
      const centerX = (width / 2 - currentTransform.x) / scale;
      const centerY = (height / 2 - currentTransform.y) / scale;
      
      // Find the file node closest to center
      let closestNode = null;
      let minDistance = Infinity;
      
      graphData.nodes.forEach(node => {
        if (node.type !== 'file') return;
        
        const dx = node.x - centerX;
        const dy = node.y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // Only consider nodes within a reasonable distance (within their own size)
        if (distance < node.size && distance < minDistance) {
          minDistance = distance;
          closestNode = node;
        }
      });
      
      // Update copy button visibility
      if (closestNode !== currentCenteredNode) {
        // Hide all copy buttons first
        d3.selectAll('.copy-button').classed('visible', false);
        
        // Show copy button for centered node
        if (closestNode) {
          d3.selectAll('.copy-button')
            .filter(function() {
              const node = d3.select(this.parentNode).datum();
              return node === closestNode;
            })
            .classed('visible', true);
        }
        
        currentCenteredNode = closestNode;
      }
    }
    
    // Check if a directory is centered and show pin indicator
    function updatePinIndicatorVisibility() {
      if (!graphData) return;
      
      const width = window.innerWidth;
      const height = window.innerHeight;
      const currentTransform = d3.zoomTransform(svg.node());
      const scale = currentTransform.k;
      
      // Calculate viewport center in graph coordinates
      const centerX = (width / 2 - currentTransform.x) / scale;
      const centerY = (height / 2 - currentTransform.y) / scale;
      
      // Find the directory node closest to center (only pinned ones)
      let closestDir = null;
      let minDistance = Infinity;
      
      graphData.nodes.forEach(node => {
        if (node.type !== 'directory') return;
        if (node.fx == null || node.fy == null) return; // Only pinned directories (using == to catch both null and undefined)
        
        const dx = node.x - centerX;
        const dy = node.y - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // Calculate directory size for distance check
        const MIN_DIR_SCALE = 0.4;
        const MAX_DIR_SCALE = 8.0;
        const ZOOM_THRESHOLD = 0.5;
        let dirSizeMultiplier = 1;
        if (scale > 1) {
          dirSizeMultiplier = Math.max(MIN_DIR_SCALE, 1 / Math.sqrt(scale));
        } else if (scale < ZOOM_THRESHOLD) {
          // Only scale up directories when zoomed out below 50%
          // Seamless exponential scaling: the smaller the zoom, the larger the directories
          dirSizeMultiplier = Math.min(MAX_DIR_SCALE, Math.pow(ZOOM_THRESHOLD / scale, 0.9));
        }
        
        const fontSizes = [84, 60, 36, 22];
        const fontSize = fontSizes[Math.min(node.depth || 0, fontSizes.length - 1)] * dirSizeMultiplier;
        const parts = node.label.split('/');
        const dirName = parts[parts.length - 1];
        const dirNameWidth = dirName.length * fontSize * 0.5;
        const calculatedWidth = dirNameWidth + 60;
        const minWidths = [400, 250, 180, 140];
        const minWidth = minWidths[Math.min(node.depth || 0, minWidths.length - 1)] * dirSizeMultiplier;
        const dirWidth = Math.max(calculatedWidth, minWidth);
        const dirHeight = fontSize * 1.8;
        const dirSize = Math.max(dirWidth, dirHeight);
        
        // Only consider nodes within a reasonable distance
        if (distance < dirSize && distance < minDistance) {
          minDistance = distance;
          closestDir = node;
        }
      });
      
      // Update pin indicator visibility
      // Hide all pin indicators first
      d3.selectAll('.pin-indicator').classed('visible', false);
      
      // Show pin indicator for centered directory
      if (closestDir) {
        d3.selectAll('.pin-indicator')
          .filter(function() {
            const node = d3.select(this.parentNode).datum();
            return node === closestDir;
          })
          .classed('visible', true);
      }
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
      // Note: smell details will be updated by the zoom event handler
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
      
      // Collect filtered nodes for navigation
      filteredNodes = [];
      currentFilteredIndex = -1;
      
      if (searchQuery) {
        graphData.nodes.forEach(node => {
          if (nodeMatchesSearch(node)) {
            filteredNodes.push(node);
          }
        });
      }
      
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
    
    // Navigate to next filtered node
    function navigateToNextFilteredNode() {
      if (filteredNodes.length === 0) {
        console.log('[Files Map] No filtered nodes to navigate');
        return;
      }
      
      // Move to next index, wrapping around to 0 after the last item
      currentFilteredIndex = (currentFilteredIndex + 1) % filteredNodes.length;
      
      const node = filteredNodes[currentFilteredIndex];
      console.log('[Files Map] Navigating to filtered node ' + (currentFilteredIndex + 1) + '/' + filteredNodes.length + ': ' + node.label);
      
      // Zoom to the node
      zoomToNode(node);
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
      
      // Function to get directory size based on depth (base sizes, no zoom adjustment)
      function getDirSize(depth) {
        // Inverse relationship: depth 0 = largest, higher depth = smaller
        // Base sizes: depth 0 = 400px, depth 1 = 300px, depth 2 = 220px, depth 3+ = 160px
        const baseSizes = [400, 300, 220, 160];
        return baseSizes[Math.min(depth, baseSizes.length - 1)];
      }
      
      // Function to get directory font size based on depth (base sizes, no zoom adjustment)
      function getDirFontSize(depth) {
        const fontSizes = [64, 44, 28, 18];
        return fontSizes[Math.min(depth, fontSizes.length - 1)];
      }
      
      // Function to calculate width needed for text
      function getTextWidth(text, fontSize) {
        // For directories, we only show the directory name (last segment)
        const parts = text.split('/');
        const dirName = parts[parts.length - 1];
        
        // Calculate width for directory name
        // Use 0.5 as character width ratio for bold text (tighter fit)
        const dirNameWidth = dirName.length * fontSize * 0.5;
        
        // Add padding (30px on each side for margin)
        const calculatedWidth = dirNameWidth + 60;
        
        // Set minimum width based on depth
        const minWidths = [400, 250, 180, 140];
        const minWidth = minWidths[Math.min(parts.length - 1, minWidths.length - 1)];
        
        return Math.max(calculatedWidth, minWidth);
      }
      
      // Update directory and file sizes based on zoom level
      // Assign to outer-scope variable so it can be called from zoom handler
      updateDirectorySizes = function(zoomScale) {
        // Only update if we have a valid scale
        if (zoomScale === undefined) return;
        
        // Calculate INVERSE scaling factor for directory sizes
        // When zooming IN (scale > 1), make boxes SMALLER
        // When zooming OUT (scale < 1), make boxes LARGER
        const MIN_DIR_SCALE = 0.4; // Minimum size when zoomed in (40% of base)
        const MAX_DIR_SCALE = 8.0;  // Maximum size when zoomed out (800% of base)
        const ZOOM_THRESHOLD = 0.5; // Only scale up below 50% zoom
        
        let dirSizeMultiplier = 1;
        
        if (zoomScale > 1) {
          // Zooming IN: scale down directories
          dirSizeMultiplier = Math.max(MIN_DIR_SCALE, 1 / Math.sqrt(zoomScale));
        } else if (zoomScale < ZOOM_THRESHOLD) {
          // Only scale up directories when zoomed out below 50%
          // Seamless exponential scaling: the smaller the zoom, the larger the directories
          dirSizeMultiplier = Math.min(MAX_DIR_SCALE, Math.pow(ZOOM_THRESHOLD / zoomScale, 0.9));
        }
        
        // Update directory shapes
        d3.selectAll('.dir-rect')
          .attr('d', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'directory') return null;
            
            const fontSizes = [84, 60, 36, 22];
            const fontSize = fontSizes[Math.min(node.depth || 0, fontSizes.length - 1)] * dirSizeMultiplier;
            
            // Calculate text width
            const parts = node.label.split('/');
            const dirName = parts[parts.length - 1];
            const dirNameWidth = dirName.length * fontSize * 0.5;
            const calculatedWidth = dirNameWidth + 60; // 30px margin on each side
            
            // Set minimum width based on depth
            const minWidths = [400, 250, 180, 140];
            const minWidth = minWidths[Math.min(node.depth || 0, minWidths.length - 1)] * dirSizeMultiplier;
            
            const width = Math.max(calculatedWidth, minWidth);
            const height = fontSize * 1.8; // Height proportional to font size
            
            // Create hexagon path: rectangle with angled left and right sides
            const indent = height * 0.4;
            const halfWidth = width / 2;
            const halfHeight = height / 2;
            
            return \`
              M \${-halfWidth + indent},\${-halfHeight}
              L \${halfWidth - indent},\${-halfHeight}
              L \${halfWidth},0
              L \${halfWidth - indent},\${halfHeight}
              L \${-halfWidth + indent},\${halfHeight}
              L \${-halfWidth},0
              Z
            \`;
          });
        
        // Update directory name font sizes (always centered)
        d3.selectAll('.directory-name')
          .style('font-size', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'directory') return null;
            const fontSizes = [64, 44, 28, 18];
            const fontSize = fontSizes[Math.min(node.depth || 0, fontSizes.length - 1)] * dirSizeMultiplier;
            return fontSize + 'px';
          });
      }
      
      
      // Create a map of directory -> files for radial positioning
      const dirToFiles = new Map();
      const dirNodeMap = new Map(); // Map dirPath -> directory node
      
      // First pass: map directory nodes
      nodes.forEach(node => {
        if (node.type === 'directory') {
          dirNodeMap.set(node.path, node);
        }
      });
      
      // Second pass: group files by parent directory
      nodes.forEach(node => {
        if (node.type === 'file') {
          const fileDir = node.path.substring(0, node.path.lastIndexOf('/'));
          if (!dirToFiles.has(fileDir)) {
            dirToFiles.set(fileDir, []);
          }
          dirToFiles.get(fileDir).push(node);
        }
      });
      
      // Build directory hierarchy
      const dirHierarchy = new Map(); // parentPath -> [childDirs]
      const rootDirs = [];
      const dirToParentEdges = []; // Store directory-to-parent edges
      
      nodes.forEach(node => {
        if (node.type === 'directory') {
          const parentPath = node.path.substring(0, node.path.lastIndexOf('/'));
          if (parentPath && dirNodeMap.has(parentPath)) {
            if (!dirHierarchy.has(parentPath)) {
              dirHierarchy.set(parentPath, []);
            }
            dirHierarchy.get(parentPath).push(node);
            
            // Create edge from parent to child directory
            const parentNode = dirNodeMap.get(parentPath);
            dirToParentEdges.push({
              source: parentNode,
              target: node,
              type: 'contains'
            });
          } else {
            rootDirs.push(node);
          }
        }
      });
      
      // Position directories in circles around their parents with depth-based spacing
      const BASE_DIR_RADIUS = 1800; // Base radius for all directories
      const FILE_SPACE = 1000; // Space needed for files (max 3 layers = 1000px)
      const DIRS_PER_LAYER = 8;
      
      // Calculate directory depth (how many levels of directories below this one)
      function calculateDirectoryDepth(dirNode) {
        const children = dirHierarchy.get(dirNode.path) || [];
        
        if (children.length === 0) {
          // Leaf directory - no child directories
          dirNode.directoryDepth = 0;
          return 0;
        }
        
        // Calculate depth for all children first (recursive)
        let maxChildDepth = 0;
        children.forEach(child => {
          const childDepth = calculateDirectoryDepth(child);
          maxChildDepth = Math.max(maxChildDepth, childDepth);
        });
        
        // This directory's depth is 1 + max child depth
        dirNode.directoryDepth = maxChildDepth + 1;
        return dirNode.directoryDepth;
      }
      
      // Calculate depth for all directories
      nodes.forEach(node => {
        if (node.type === 'directory') {
          calculateDirectoryDepth(node);
        }
      });
      
      // Position root directories with significant separation for distinct graphs
      if (rootDirs.length === 1) {
        // Single root - center it
        const dirNode = rootDirs[0];
        if (dirNode.fx === undefined && dirNode.fy === undefined) {
          dirNode.x = width / 2;
          dirNode.y = height / 2;
          dirNode.fx = dirNode.x;
          dirNode.fy = dirNode.y;
        } else {
          // Has saved position - use it
          dirNode.x = dirNode.fx;
          dirNode.y = dirNode.fy;
        }
      } else {
        // Multiple roots - position them far apart horizontally
        // Separate roots with saved positions from those without
        const rootsWithoutSavedPos = rootDirs.filter(r => r.fx === undefined && r.fy === undefined);
        const rootsWithSavedPos = rootDirs.filter(r => r.fx !== undefined && r.fy !== undefined);
        
        // Position roots that don't have saved positions
        if (rootsWithoutSavedPos.length > 0) {
          // Calculate spacing based on each root's depth
          const rootSpacing = [];
          rootsWithoutSavedPos.forEach(root => {
            const depthFactor = (root.directoryDepth || 0) + 1;
            const totalRadius = FILE_SPACE + (BASE_DIR_RADIUS * depthFactor);
            rootSpacing.push(totalRadius * 2); // Double for full diameter
          });
          
          // Calculate total width needed
          const totalWidth = rootSpacing.reduce((sum, space) => sum + space, 0);
          const padding = 2000; // Extra padding between graphs
          const totalWithPadding = totalWidth + (padding * (rootsWithoutSavedPos.length - 1));
          
          // Position roots horizontally with appropriate spacing
          let currentX = width / 2 - totalWithPadding / 2;
          
          rootsWithoutSavedPos.forEach((dirNode, index) => {
            // Move to center of this root's allocated space
            currentX += rootSpacing[index] / 2;
            dirNode.x = currentX;
            dirNode.y = height / 2;
            dirNode.fx = dirNode.x;
            dirNode.fy = dirNode.y;
            // Move to start of next root's space
            currentX += rootSpacing[index] / 2 + padding;
          });
        }
        
        // For roots with saved positions, just use their saved positions
        rootsWithSavedPos.forEach(dirNode => {
          dirNode.x = dirNode.fx;
          dirNode.y = dirNode.fy;
        });
      }
      
      // Position child directories in circles around their parents with depth-based radius
      // Process directories level by level to ensure parents are positioned before children
      function positionChildrenRecursively(parentDir) {
        const childDirs = dirHierarchy.get(parentDir.path);
        if (!childDirs || childDirs.length === 0) return;
        
        childDirs.forEach((childDir, index) => {
          // Skip positioning if this child already has a saved position
          if (childDir.fx !== undefined && childDir.fy !== undefined) {
            // Use the saved position
            childDir.x = childDir.fx;
            childDir.y = childDir.fy;
            
            // Still recursively position this directory's children
            positionChildrenRecursively(childDir);
            return;
          }
          
          // Calculate distance factor based on directory depth
          // depth 0 (no child dirs) = factor 1
          // depth 1 (1 level of dirs) = factor 2
          // depth 2 (2 levels of dirs) = factor 3
          // depth 3 (3 levels of dirs) = factor 4
          const distanceFactor = (childDir.directoryDepth || 0) + 1;
          
          // Calculate radius: FILE_SPACE + (BASE_DIR_RADIUS * distanceFactor)
          const baseRadius = FILE_SPACE + (BASE_DIR_RADIUS * distanceFactor);
          
          // Calculate which layer this directory belongs to
          const layer = Math.floor(index / DIRS_PER_LAYER);
          const indexInLayer = index % DIRS_PER_LAYER;
          const dirsInThisLayer = Math.min(DIRS_PER_LAYER, childDirs.length - layer * DIRS_PER_LAYER);
          
          // Add layer spacing if multiple layers
          const layerSpacing = layer * 500;
          const radius = baseRadius + layerSpacing;
          
          // Calculate angle for this directory in its layer
          const angleStep = (2 * Math.PI) / dirsInThisLayer;
          const angle = indexInLayer * angleStep;
          
          // Set position around parent's CURRENT position
          // This ensures children follow their parent even if parent has a saved position
          childDir.x = parentDir.x + Math.cos(angle) * radius;
          childDir.y = parentDir.y + Math.sin(angle) * radius;
          childDir.fx = childDir.x;
          childDir.fy = childDir.y;
          
          // Store the calculated values for debugging
          childDir.calculatedRadius = radius;
          childDir.distanceFactor = distanceFactor;
          
          // Recursively position this directory's children
          positionChildrenRecursively(childDir);
        });
      }
      
      // Start positioning from root directories
      rootDirs.forEach(rootDir => {
        positionChildrenRecursively(rootDir);
      });
      
      // Assign initial angles and POSITIONS to files for multi-layer radial distribution
      // Layer configuration: [maxFiles, radius]
      const LAYER_CONFIG = [
        { maxFiles: 10, radius: 450 },   // Layer 1: closer, max 10 files
        { maxFiles: 16, radius: 700 },   // Layer 2: max 16 files
        { maxFiles: 28, radius: 1000 }   // Layer 3: max 28 files
      ];
      
      dirToFiles.forEach((files, dirPath) => {
        const parentDir = dirNodeMap.get(dirPath);
        
        files.forEach((file, index) => {
          file.parentDir = parentDir; // Store direct reference to parent
          
          if (parentDir) {
            // Determine which layer this file belongs to
            let layer = 0;
            let filesBeforeThisLayer = 0;
            let cumulativeFiles = 0;
            
            for (let i = 0; i < LAYER_CONFIG.length; i++) {
              cumulativeFiles += LAYER_CONFIG[i].maxFiles;
              if (index < cumulativeFiles) {
                layer = i;
                filesBeforeThisLayer = cumulativeFiles - LAYER_CONFIG[i].maxFiles;
                break;
              }
            }
            
            // If we exceed all configured layers, use the last layer config
            if (index >= cumulativeFiles) {
              layer = LAYER_CONFIG.length - 1;
              filesBeforeThisLayer = cumulativeFiles - LAYER_CONFIG[layer].maxFiles;
            }
            
            // Calculate position within the layer
            const indexInLayer = index - filesBeforeThisLayer;
            const filesInThisLayer = Math.min(
              LAYER_CONFIG[layer].maxFiles,
              files.length - filesBeforeThisLayer
            );
            
            // Get radius for this layer
            const radius = LAYER_CONFIG[layer].radius;
            
            // Calculate angle for this file in its layer
            const angleStep = (2 * Math.PI) / filesInThisLayer;
            const angle = indexInLayer * angleStep;
            
            // Store layer and angle info
            file.targetAngle = angle;
            file.targetRadius = radius;
            file.layer = layer;
            
            // Set initial position
            file.x = parentDir.x + Math.cos(angle) * radius;
            file.y = parentDir.y + Math.sin(angle) * radius;
          } else {
            file.x = width / 2 + (Math.random() - 0.5) * 200;
            file.y = height / 2 + (Math.random() - 0.5) * 200;
          }
        });
      });
      
      // Collect all descendants for each directory (for group dragging)
      function collectDescendants(dirNode) {
        const descendants = [];
        
        // Get child directories
        const childDirs = dirHierarchy.get(dirNode.path) || [];
        childDirs.forEach(childDir => {
          descendants.push(childDir);
          // Recursively collect descendants of child directories
          const childDescendants = collectDescendants(childDir);
          descendants.push(...childDescendants);
        });
        
        // Get files in this directory
        const files = dirToFiles.get(dirNode.path) || [];
        descendants.push(...files);
        
        return descendants;
      }
      
      // Attach descendants to each directory node
      nodes.forEach(node => {
        if (node.type === 'directory') {
          node.descendants = collectDescendants(node);
        }
      });
      
      simulation = d3.forceSimulation(nodes)
        .velocityDecay(0.8) // Higher decay to reduce vibration (default 0.4)
        .force('orbit', alpha => {
          // Custom force to keep files orbiting around their parent directory in layers
          nodes.forEach(node => {
            if (node.type !== 'file' || node.targetAngle === undefined || !node.parentDir || node.targetRadius === undefined) return;
            
            // Use stored parent reference and radius for this file's layer
            const parentDir = node.parentDir;
            const radius = node.targetRadius;
            
            // Calculate target position using the current parent position and layer radius
            const targetX = parentDir.x + Math.cos(node.targetAngle) * radius;
            const targetY = parentDir.y + Math.sin(node.targetAngle) * radius;
            
            // Calculate distance from target
            const dx = targetX - node.x;
            const dy = targetY - node.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            // Apply very strong force to lock files in their circular positions
            if (distance > 0) {
              const baseStrength = 2.0;
              // Increase strength based on distance (spring gets stronger when stretched)
              const distanceFactor = Math.min(distance / 100, 3);
              const strength = baseStrength * (1 + distanceFactor);
              node.vx += dx * strength;
              node.vy += dy * strength;
            }
          });
        });
      
      // Create edges (directory hierarchy + directory-to-file connections)
      const edgeGroup = g.append('g').attr('class', 'edges');
      
      // Combine directory hierarchy edges with file containment edges
      const allEdges = [...dirToParentEdges, ...containmentEdges.filter(e => {
        const source = typeof e.source === 'object' ? e.source : nodes.find(n => n.id === e.source);
        const target = typeof e.target === 'object' ? e.target : nodes.find(n => n.id === e.target);
        return source && target && source.type === 'directory' && target.type === 'file';
      })];
      
      const edgeElements = edgeGroup.selectAll('path')
        .data(allEdges)
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
        })
        .style('fill', 'none');
      
      // Create nodes
      const nodeGroup = g.append('g').attr('class', 'nodes');
      
      // Separate file and directory nodes for proper layering
      const fileNodes = nodes.filter(n => n.type === 'file');
      const dirNodes = nodes.filter(n => n.type === 'directory');
      
      // Create file nodes first (will be rendered behind)
      const fileElements = nodeGroup.selectAll('g.node-file')
        .data(fileNodes)
        .enter()
        .append('g')
        .attr('class', 'node-file')
        .on('click', function(event, d) {
          if (simulation) {
            simulation.stop();
          }
          zoomToNode(d);
        })
        .on('dblclick', (event, d) => {
          event.stopPropagation();
          vscode.postMessage({ type: 'file:open', filePath: d.path });
        })
        .on('mouseenter', function(event, d) {
          if (isDragging) return;
          if (currentSymbolListNode) return;
          
          if (tooltipTimeout) {
            clearTimeout(tooltipTimeout);
          }
          
          tooltipTimeout = setTimeout(() => {
            if (!isDragging && !currentSymbolListNode) {
              showTooltip(event, d);
            }
          }, 200);
        })
        .on('mousemove', function(event, d) {
          if (tooltip && tooltip.classList.contains('visible')) {
            updateTooltipPosition(event);
          }
        })
        .on('mouseleave', function(event, d) {
          if (tooltipTimeout) {
            clearTimeout(tooltipTimeout);
            tooltipTimeout = null;
          }
          hideTooltip();
        });
      
      // Create directory nodes second (will be rendered on top)
      const dirElements = nodeGroup.selectAll('g.node-directory')
        .data(dirNodes)
        .enter()
        .append('g')
        .attr('class', 'node-directory')
        .call(d3.drag()
          .on('start', dragStarted)
          .on('drag', dragged)
          .on('end', dragEnded)
        )
        .on('click', function(event, d) {
          if (simulation) {
            simulation.stop();
          }
          zoomToNode(d);
        })
        .on('mouseenter', function(event, d) {
          if (isDragging) return;
          if (currentSymbolListNode) return;
          
          if (tooltipTimeout) {
            clearTimeout(tooltipTimeout);
          }
          
          tooltipTimeout = setTimeout(() => {
            if (!isDragging && !currentSymbolListNode) {
              showTooltip(event, d);
            }
          }, 200);
        })
        .on('mousemove', function(event, d) {
          if (tooltip && tooltip.classList.contains('visible')) {
            updateTooltipPosition(event);
          }
        })
        .on('mouseleave', function(event, d) {
          if (tooltipTimeout) {
            clearTimeout(tooltipTimeout);
            tooltipTimeout = null;
          }
          hideTooltip();
        });
      
      // Combine both for unified access
      const nodeElements = nodeGroup.selectAll('g.node-file, g.node-directory')
      
      // Add rectangles for files
      console.log('[Files Map Webview] Creating file rectangles for', fileElements.size(), 'files');
      
      const fileRects = fileElements
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

      // Add hexagonal shapes for directories (rectangle with rhombus sides)
      const dirRects = dirElements
        .append('path')
        .attr('d', d => {
          const fontSize = getDirFontSize(d.depth || 0);
          const width = getTextWidth(d.label, fontSize);
          const height = fontSize * 1.8; // Height proportional to font size
          
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
        .style('stroke-width', 3);
      
      // Add line count badge for files (at the top)
      
      // Add background rectangle for line count
      fileElements.append('rect')
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
      fileElements.append('text')
        .attr('class', 'node-sublabel')
        .attr('x', 0)
        .attr('y', d => -d.size / 4 + 14) // Position at top of file box
        .text(d => \`\${d.lines}\`);
      
      // Add yellow triangles for functions (right side)
      const functionsTriangle = fileElements.append('g')
        .attr('class', d => {
          const baseClass = 'symbol-triangle functions-triangle';
          return d.functions.length === 0 ? baseClass + ' empty' : baseClass;
        })
        .attr('transform', d => {
          // Position at right side, vertically centered
          const x = d.size / 2 + 15;
          const y = 0;
          return \`translate(\${x}, \${y})\`;
        })
        .on('mouseenter', function(event, d) {
          if (d.functions.length > 0) {
            // Clear any pending hide timeout to prevent blinking
            if (symbolListHideTimeout) {
              clearTimeout(symbolListHideTimeout);
              symbolListHideTimeout = null;
            }
            showSymbolList(d, 'functions');
          }
        })
        .on('mouseleave', function(event, d) {
          hideSymbolListWithDelay();
        });
      
      // Add rounded square shape
      functionsTriangle.append('rect')
        .attr('x', -8)
        .attr('y', -8)
        .attr('width', 16)
        .attr('height', 16)
        .attr('rx', 3)
        .attr('ry', 3);
      
      // Add 'f' label to functions square
      functionsTriangle.append('text')
        .attr('x', 0)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', '10px')
        .style('font-weight', 'bold')
        .style('fill', '#000')
        .style('pointer-events', 'none')
        .text('f');
      
      // Add yellow triangles for variables (left side)
      const variablesTriangle = fileElements.append('g')
        .attr('class', d => {
          const baseClass = 'symbol-triangle variables-triangle';
          return d.variables.length === 0 ? baseClass + ' empty' : baseClass;
        })
        .attr('transform', d => {
          // Position at left side, vertically centered
          const x = -d.size / 2 - 15;
          const y = 0;
          return \`translate(\${x}, \${y})\`;
        })
        .on('mouseenter', function(event, d) {
          if (d.variables.length > 0) {
            // Clear any pending hide timeout to prevent blinking
            if (symbolListHideTimeout) {
              clearTimeout(symbolListHideTimeout);
              symbolListHideTimeout = null;
            }
            showSymbolList(d, 'variables');
          }
        })
        .on('mouseleave', function(event, d) {
          hideSymbolListWithDelay();
        });
      
      // Add rounded square shape
      variablesTriangle.append('rect')
        .attr('x', -8)
        .attr('y', -8)
        .attr('width', 16)
        .attr('height', 16)
        .attr('rx', 3)
        .attr('ry', 3);
      
      // Add 'v' label to variables square
      variablesTriangle.append('text')
        .attr('x', 0)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', '10px')
        .style('font-weight', 'bold')
        .style('fill', '#000')
        .style('pointer-events', 'none')
        .text('v');
      
      // Add rounded square for types (top side)
      const typesTriangle = fileElements.append('g')
        .attr('class', d => {
          const baseClass = 'symbol-triangle types-triangle';
          return d.types.length === 0 ? baseClass + ' empty' : baseClass;
        })
        .attr('transform', d => {
          // Position at top side, horizontally centered
          const x = 0;
          const y = -d.size / 4 - 15;
          return \`translate(\${x}, \${y})\`;
        })
        .on('mouseenter', function(event, d) {
          if (d.types.length > 0) {
            // Clear any pending hide timeout to prevent blinking
            if (symbolListHideTimeout) {
              clearTimeout(symbolListHideTimeout);
              symbolListHideTimeout = null;
            }
            showSymbolList(d, 'types');
          }
        })
        .on('mouseleave', function(event, d) {
          hideSymbolListWithDelay();
        });
      
      // Add rounded square shape
      typesTriangle.append('rect')
        .attr('x', -8)
        .attr('y', -8)
        .attr('width', 16)
        .attr('height', 16)
        .attr('rx', 3)
        .attr('ry', 3);
      
      // Add 't' label to types square
      typesTriangle.append('text')
        .attr('x', 0)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', '10px')
        .style('font-weight', 'bold')
        .style('fill', '#000')
        .style('pointer-events', 'none')
        .text('t');
      
      // Add copy button group (icon only) at bottom right corner
      const copyButtonGroup = fileElements.append('g')
        .attr('class', 'copy-button')
        .attr('transform', d => {
          // Position at bottom right corner of the file box with margin
          const margin = 12;
          const x = d.size / 2 - margin;
          const y = d.size / 4 - margin;
          return \`translate(\${x}, \${y})\`;
        })
        .on('click', function(event, d) {
          event.stopPropagation(); // Prevent triggering zoom/open
          vscode.postMessage({ type: 'file:copy', filePath: d.path });
        })
        .on('mouseenter', function(event, d) {
          showTooltip(event, { type: 'copy-button', label: 'Copy file path' });
        })
        .on('mousemove', function(event, d) {
          updateTooltipPosition(event);
        })
        .on('mouseleave', function(event, d) {
          hideTooltip();
        });
      
      // Add copy icon (two overlapping rectangles to represent copy/duplicate)
      // Back rectangle (outline only)
      copyButtonGroup.append('rect')
        .attr('class', 'copy-button-icon')
        .attr('x', -4)
        .attr('y', -3)
        .attr('width', 7)
        .attr('height', 8)
        .attr('rx', 1)
        .attr('ry', 1)
        .style('fill', 'none')
        .style('stroke', '#fff')
        .style('stroke-width', 1.2);
      
      // Front rectangle (outline only)
      copyButtonGroup.append('rect')
        .attr('class', 'copy-button-icon')
        .attr('x', -1)
        .attr('y', -6)
        .attr('width', 7)
        .attr('height', 8)
        .attr('rx', 1)
        .attr('ry', 1)
        .style('fill', 'none')
        .style('stroke', '#fff')
        .style('stroke-width', 1.2);
      
      // Add directory name label (centered)
      dirElements
        .append('text')
        .attr('class', 'node-label directory-name')
        .attr('x', 0)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', d => {
          const fontSizes = [84, 60, 36, 22];
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
      fileElements
        .append('text')
        .attr('class', 'node-label')
        .attr('x', 0)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('class', 'file-label')
        .style('fill', d => getTextColor(d))
        .style('font-weight', 'normal')
        .text(d => d.label)
        .each(function(d) {
          // Dynamically adjust font size to fit the box width with padding
          const textElement = this;
          const padding = 8; // Small padding on left and right
          const availableWidth = d.size - (padding * 2);
          
          let fontSize = 16; // Start with max font size
          const minFontSize = 8;
          
          // Binary search for optimal font size
          let low = minFontSize;
          let high = fontSize;
          
          while (high - low > 0.5) {
            fontSize = (low + high) / 2;
            textElement.style.fontSize = fontSize + 'px';
            const textWidth = textElement.getComputedTextLength();
            
            if (textWidth > availableWidth) {
              high = fontSize;
            } else {
              low = fontSize;
            }
          }
          
          // Set final font size
          fontSize = low;
          textElement.style.fontSize = fontSize + 'px';
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
        
        // Update copy button and smell details position if shown
        updateCenteredElements();
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
      
      // Set dragging flag and hide tooltip
      isDragging = true;
      hideTooltip();
      
      // Clear any pending tooltip timeout
      if (tooltipTimeout) {
        clearTimeout(tooltipTimeout);
        tooltipTimeout = null;
      }
      
      // Fix position of dragged node
      d.fx = d.x;
      d.fy = d.y;
      
      // If dragging a directory, collect all descendants for group movement
      if (d.type === 'directory' && d.descendants) {
        d.descendants.forEach(descendant => {
          descendant.dragOffsetX = descendant.x - d.x;
          descendant.dragOffsetY = descendant.y - d.y;
        });
      }
      
      // Restart simulation with very low alpha to prevent vibration
      if (simulation) {
        simulation.alphaTarget(0.1).restart();
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
        
        // If dragging a directory, move all descendants with it
        if (d.type === 'directory' && d.descendants) {
          d.descendants.forEach(descendant => {
            descendant.fx = event.x + descendant.dragOffsetX;
            descendant.fy = event.y + descendant.dragOffsetY;
            descendant.x = descendant.fx;
            descendant.y = descendant.fy;
          });
        }
      }
    }
    
    function dragEnded(event, d) {
      // Clear dragging flag
      isDragging = false;
      
      // If directory was dragged, restart simulation to reposition files
      if (d.type === 'directory' && d.wasDragged && simulation) {
        simulation.alphaTarget(0.5).restart();
        // Gradually stop the simulation after files settle
        setTimeout(() => {
          if (simulation) {
            simulation.alphaTarget(0);
          }
        }, 1000);
      } else if (simulation) {
        // For files or non-dragged nodes, just stop
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
        case 'dir:unpinned':
          // Remove directory from saved layout
          if (savedLayout[message.dirPath]) {
            delete savedLayout[message.dirPath];
          }
          
          // Find the node and unpin it
          if (graphData) {
            const node = graphData.nodes.find(n => n.type === 'directory' && n.path === message.dirPath);
            if (node) {
              node.fx = null;
              node.fy = null;
              
              // Hide pin indicator (visibility is controlled by updatePinIndicatorVisibility)
              updatePinIndicatorVisibility();
              
              // Restart simulation to let the node find a new position
              if (simulation) {
                simulation.alpha(0.5).restart();
              }
            }
          }
          break;
      }
    });
    
    // Handle visibility changes (when panel is moved or becomes visible)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && graphData) {
        console.log('[Files Map] Panel became visible, refreshing rendering');
        // Force a re-render of all elements
        d3.selectAll('.node-file, .node-directory')
          .attr('transform', d => \`translate(\${d.x},\${d.y})\`);
        
        // Restart simulation briefly to ensure proper positioning
        if (simulation) {
          simulation.alpha(0.1).restart();
          setTimeout(() => {
            if (simulation) {
              simulation.alpha(0);
            }
          }, 100);
        }
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


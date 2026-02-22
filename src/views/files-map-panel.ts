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
  size: number;  // width (fixed)
  height: number; // height (based on lines)
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
    // Note: We no longer re-render the graph on visibility change because
    // the webview's visibilitychange handler already restores sizes properly.
    // Re-rendering would reset the zoom level and cause directory boxes to shrink.
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
      case 'index:start':
        await this.handleIndexProject();
        break;
    }
  }

  private async handleIndexProject() {
    try {
      // Execute the radium reindex command
      // Note: This command uses withProgress internally and the actual indexing
      // happens asynchronously inside withProgress
      vscode.commands.executeCommand('radium.reindex');
      
      // Wait for indexing to complete
      // The reindex command clears the store first (count goes to 0), then repopulates
      // We wait for: store cleared -> files added -> count stabilizes
      const startTime = Date.now();
      const maxWaitTime = 60000; // 60 seconds max
      const pollInterval = 500; // Check every 500ms
      
      await new Promise<void>((resolve) => {
        let stableCount = 0;
        let lastFileCount = -1;
        let sawEmpty = false; // Track if we saw the store get cleared
        
        const checkComplete = () => {
          const currentFileCount = this.store.getAllFiles().length;
          const elapsed = Date.now() - startTime;
          
          // Track if store was cleared
          if (currentFileCount === 0) {
            sawEmpty = true;
          }
          
          // If file count changed, reset stability counter
          if (currentFileCount !== lastFileCount) {
            stableCount = 0;
            lastFileCount = currentFileCount;
          } else {
            stableCount++;
          }
          
          // Consider complete if:
          // 1. Store was cleared, then repopulated, and count is stable for 3 checks, OR
          // 2. Timeout reached
          const isComplete = sawEmpty && currentFileCount > 0 && stableCount >= 3;
          
          if (isComplete || elapsed >= maxWaitTime) {
            resolve();
          } else {
            setTimeout(checkComplete, pollInterval);
          }
        };
        
        // Start checking after a short delay to let indexing begin
        setTimeout(checkComplete, 500);
      });
      
      // Update the graph after indexing
      this.updateGraph();
      
      // Notify webview that indexing is complete
      this.panel.webview.postMessage({ type: 'index:complete' });
    } catch (error) {
      console.error('[Files Map] Error indexing project:', error);
      vscode.window.showErrorMessage('Failed to index project');
      
      // Still notify webview to reset button state
      this.panel.webview.postMessage({ type: 'index:complete' });
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
      
      // Fixed width for all files, height based on line count
      const FILE_WIDTH = 120; // Fixed width for all file boxes
      const MIN_HEIGHT = 50; // Minimum height to fit badges and buttons
      const MAX_HEIGHT = 150;
      const MAX_LINES = 2000;
      
      // Calculate height based on line count
      let fileHeight;
      if (lines <= 1) {
        fileHeight = MIN_HEIGHT;
      } else if (lines >= MAX_LINES) {
        fileHeight = MAX_HEIGHT;
      } else {
        // Linear scale based on line count
        fileHeight = MIN_HEIGHT + ((lines - 1) / (MAX_LINES - 1)) * (MAX_HEIGHT - MIN_HEIGHT);
      }
      
      const size = FILE_WIDTH; // Keep 'size' as width for compatibility
      
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
      
      // Determine if this is a C#, TypeScript, Go, or Kotlin file and get the main class name
      const isCSharp = file.lang === 'csharp';
      const isTypeScript = file.lang === 'typescript' || file.lang === 'javascript';
      const isGo = file.lang === 'go';
      const isKotlin = file.lang === 'kotlin';
      const fileNameWithoutExt = fileName.replace(/\.(cs|xaml\.cs|ts|tsx|js|jsx|go|kt|kts)$/i, '');
      
      // For C#, TypeScript, Go, and Kotlin files, find the main class/struct (the one matching the filename)
      const mainClassRange = (isCSharp || isTypeScript || isGo || isKotlin) ? typeRanges.find(t => t.name === fileNameWithoutExt) : null;
      
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
          
          // For C#, TypeScript, Go, and Kotlin files: include class/struct member variables (inside the main class) but exclude function-level variables
          if ((isCSharp || isTypeScript || isGo || isKotlin) && mainClassRange) {
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
          // For C#, TypeScript, Go, and Kotlin files, exclude the main class/struct
          if ((isCSharp || isTypeScript || isGo || isKotlin) && n.name === fileNameWithoutExt) {
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
        height: fileHeight,
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
    
    // Check if there are files in the root directory
    const hasRootFiles = directories.has('.') || directories.has('');
    
    // First pass: collect all directories that have files
    for (const [dirPath] of directories.entries()) {
      // Include root directory if it has files
      if (dirPath === '.' || dirPath === '') {
        if (hasRootFiles) {
          allDirectories.add('.');
        }
        continue;
      }
      allDirectories.add(dirPath);
    }
    
    // Second pass: add all parent directories in the hierarchy
    for (const dirPath of Array.from(allDirectories)) {
      if (dirPath === '.') continue; // Root has no parent
      let currentPath = dirPath;
      while (true) {
        const parentPath = path.dirname(currentPath);
        if (parentPath === '.' || parentPath === '' || parentPath === currentPath) {
          // Add root as parent if there are any directories
          if (hasRootFiles || allDirectories.size > 0) {
            allDirectories.add('.');
          }
          break;
        }
        allDirectories.add(parentPath);
        currentPath = parentPath;
      }
    }
    
    // Calculate depth for all directories
    for (const dirPath of allDirectories) {
      let depth;
      if (dirPath === '.') {
        depth = 0;
      } else {
        depth = dirPath.split('/').length;
      }
      dirDepthMap.set(dirPath, depth);
      
      // Find parent directory
      const parentPath = path.dirname(dirPath);
      if (dirPath !== '.' && (parentPath === '.' || parentPath === '')) {
        // Top-level directories have root as parent
        if (!dirHierarchy.has('.')) {
          dirHierarchy.set('.', []);
        }
        dirHierarchy.get('.')!.push(dirPath);
      } else if (parentPath !== '.' && parentPath !== dirPath) {
        if (!dirHierarchy.has(parentPath)) {
          dirHierarchy.set(parentPath, []);
        }
        dirHierarchy.get(parentPath)!.push(dirPath);
      }
    }
    
    // Create directory nodes for all directories (including those without direct files)
    for (const dirPath of allDirectories) {
      // Check if directory should be ignored (but never ignore root)
      if (dirPath !== '.' && this.radiumIgnore.shouldIgnoreDirectory(dirPath)) {
        console.log(`[Files Map] Skipping ignored directory: ${dirPath}`);
        continue;
      }
      
      const depth = dirDepthMap.get(dirPath) || 0;
      // For root directory, also check for files with empty dirPath
      let fileSet = directories.get(dirPath);
      if (dirPath === '.') {
        const emptyDirFiles = directories.get('');
        if (emptyDirFiles) {
          if (fileSet) {
            emptyDirFiles.forEach(f => fileSet!.add(f));
          } else {
            fileSet = emptyDirFiles;
          }
        }
      }
      const fileCount = fileSet ? fileSet.size : 0;
      
      // Use workspace folder name for root directory label
      const label = dirPath === '.' ? path.basename(this.workspaceRoot) : dirPath;
      
      nodes.push({
        id: `dir:${dirPath}`,
        type: 'directory',
        label,
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
      if (dirPath !== '.' && (parentPath === '.' || parentPath === '')) {
        // Top-level directories connect to root
        edges.push({
          source: `dir:.`,
          target: `dir:${dirPath}`,
          type: 'contains'
        });
      } else if (parentPath !== '.' && parentPath !== dirPath && allDirectories.has(parentPath)) {
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
    
    .control-button {
      background: #2d2d2d;
      color: #d4d4d4;
      border: 1px solid #555;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 13px;
      cursor: pointer;
      outline: none;
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    
    .control-button:hover {
      background: #3d3d3d;
      border-color: #666;
    }
    
    .control-button:active {
      background: #4d4d4d;
    }
    
    .control-button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid #555;
      border-top-color: #007acc;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
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
      stroke: #888;
      stroke-width: 2;
      opacity: 0.7;
    }
    
    .node-label {
      font-size: 14px;
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
      cursor: pointer;
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
    <button id="reset-view-btn" class="control-button" title="Fit entire tree in view">
      Reset View
    </button>
    <button id="index-project-btn" class="control-button" title="Re-index the project">
      <span id="index-btn-text">Index Project</span>
      <span id="index-spinner" class="spinner" style="display: none;"></span>
    </button>
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
    let isResizing = false; // Track if window is being resized
    let currentSmellDetailsNode = null; // Track which node has smell details shown
    let currentCenteredNode = null; // Track which node is currently centered (for copy button)
    let updateDirectorySizes = null; // Function to update directory sizes on zoom (assigned in renderGraph)
    let filteredNodes = []; // Track filtered nodes for navigation
    let currentFilteredIndex = -1; // Current index in filtered nodes
    
    // 50 predefined distinct colors for directories
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
      '#AF7AC5', // Lavender
      '#FF6F91', // Pink
      '#C44569', // Dark Rose
      '#F8B500', // Amber
      '#78E08F', // Mint Green
      '#60A3BC', // Steel Blue
      '#EA8685', // Light Red
      '#FD79A8', // Hot Pink
      '#FDCB6E', // Mustard
      '#6C5CE7', // Indigo
      '#00B894', // Emerald
      '#00CEC9', // Cyan
      '#0984E3', // Azure
      '#A29BFE', // Periwinkle
      '#FF7675', // Watermelon
      '#74B9FF', // Sky
      '#55EFC4', // Aqua
      '#FAB1A0', // Apricot
      '#DFE6E9', // Silver
      '#E17055', // Terracotta
      '#81ECEC'  // Turquoise Blue
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
      if (exportedSymbols <= 3) return '#FFD700'; // gold
      if (exportedSymbols <= 6) return '#ADFF2F'; // green yellow
      if (exportedSymbols <= 9) return '#7FFF00'; // chartreuse
      return '#00D084'; // emerald green
    }
    
    // Function to get color based on code smell score (0-100)
    // Green (clean) -> Yellow (moderate) -> Red (high smells)
    function getFileColorBySmell(smellScore) {
      if (smellScore <= 20) return '#00D084'; // Emerald - Clean code
      if (smellScore <= 40) return '#55EFC4'; // Aqua - Minor issues
      if (smellScore <= 60) return '#FDCB6E'; // Mustard - Moderate concerns
      if (smellScore <= 80) return '#FF7675'; // Watermelon - Significant smells
      return '#D63031'; // Red - High smell density
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
      
      // Setup reset view button
      const resetViewBtn = document.getElementById('reset-view-btn');
      resetViewBtn.addEventListener('click', () => {
        fitTreeInView();
      });
      
      // Setup index project button
      const indexProjectBtn = document.getElementById('index-project-btn');
      const indexBtnText = document.getElementById('index-btn-text');
      const indexSpinner = document.getElementById('index-spinner');
      
      indexProjectBtn.addEventListener('click', () => {
        // Disable button and show spinner
        indexProjectBtn.disabled = true;
        indexBtnText.textContent = 'Indexing...';
        indexSpinner.style.display = 'block';
        
        // Send message to extension to start indexing
        vscode.postMessage({ type: 'index:start' });
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
      const fileBoxHeight = node.height;
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
        .attr('transform', \`translate(\${node.x}, \${node.y + node.height / 2 + 20})\`);
      
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
          .attr('transform', \`translate(\${node.x}, \${node.y + node.height / 2 + 20})\`);
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
        
        // Calculate directory size for distance check (matches updateDirectorySizes logic)
        const ZOOM_THRESHOLD = 0.20;
        const MAX_DIR_SCALE = 30.0;
        
        // Use the stored base width/height (calculated from text)
        const baseWidth = node.baseWidth || 200;
        const baseHeight = node.baseHeight || 100;
        
        let dirWidth, dirHeight;
        if (scale >= ZOOM_THRESHOLD) {
          dirWidth = baseWidth;
          dirHeight = baseHeight;
        } else {
          const multiplier = Math.min(MAX_DIR_SCALE, ZOOM_THRESHOLD / scale);
          dirWidth = baseWidth * multiplier;
          dirHeight = baseHeight * multiplier;
        }
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
    
    // Fit the entire tree in view
    function fitTreeInView() {
      if (!svg || !zoom || !graphData || graphData.nodes.length === 0) return;
      
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      // Calculate bounding box of all nodes
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      
      graphData.nodes.forEach(node => {
        if (node.x === undefined || node.y === undefined) return;
        
        // Account for node size
        const nodeWidth = node.type === 'directory' ? (node.baseWidth || 200) : node.size;
        const nodeHeight = node.type === 'directory' ? (node.baseHeight || 100) : node.height;
        
        minX = Math.min(minX, node.x - nodeWidth / 2);
        maxX = Math.max(maxX, node.x + nodeWidth / 2);
        minY = Math.min(minY, node.y - nodeHeight / 2);
        maxY = Math.max(maxY, node.y + nodeHeight / 2);
      });
      
      if (minX === Infinity) return; // No valid nodes
      
      // Add padding
      const padding = 50;
      minX -= padding;
      maxX += padding;
      minY -= padding;
      maxY += padding;
      
      // Calculate scale to fit
      const treeWidth = maxX - minX;
      const treeHeight = maxY - minY;
      const scale = Math.min(width / treeWidth, height / treeHeight, 1); // Cap at 1x
      
      // Calculate center of tree
      const treeCenterX = (minX + maxX) / 2;
      const treeCenterY = (minY + maxY) / 2;
      
      // Calculate transform to center the tree
      const x = width / 2 - treeCenterX * scale;
      const y = height / 2 - treeCenterY * scale;
      
      // Stop simulation
      if (simulation) {
        simulation.stop();
      }
      
      // Apply transform with smooth transition
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
        // Use tighter character width ratio for bold text
        const dirNameWidth = dirName.length * fontSize * 0.6;
        
        // Add padding (20px on each side for margin - reduced from 30px)
        const calculatedWidth = dirNameWidth + 40;
        
        // Set minimum width based on depth (reduced by ~30%)
        const minWidths = [200, 130, 90, 70];
        const minWidth = minWidths[Math.min(parts.length - 1, minWidths.length - 1)];
        
        return Math.max(calculatedWidth, minWidth);
      }
      
      // Update directory and file sizes based on zoom level
      // Assign to outer-scope variable so it can be called from zoom handler
      updateDirectorySizes = function(zoomScale) {
        // Only update if we have a valid scale
        if (zoomScale === undefined) return;
        
        // Directory scaling:
        // - 0% - 20% zoom (very zoomed out): directories GROW as zoom decreases (0% = largest, 20% = smallest)
        // - 20%+ zoom: directories stay at their base size (calculated from text width)
        const ZOOM_THRESHOLD = 0.20; // Below this, directories start growing
        const MAX_DIR_SCALE = 30.0; // Maximum growth when very zoomed out (30x larger)
        
        // Update directory shapes (squares)
        d3.selectAll('.dir-rect')
          .attr('x', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'directory') return 0;
            
            const baseWidth = node.baseWidth || 200;
            let width = baseWidth;
            
            if (zoomScale < ZOOM_THRESHOLD) {
              const multiplier = Math.min(MAX_DIR_SCALE, ZOOM_THRESHOLD / zoomScale);
              width = baseWidth * multiplier;
            }
            
            return -width / 2;
          })
          .attr('y', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'directory') return 0;
            
            const baseHeight = node.baseHeight || 100;
            let height = baseHeight;
            
            if (zoomScale < ZOOM_THRESHOLD) {
              const multiplier = Math.min(MAX_DIR_SCALE, ZOOM_THRESHOLD / zoomScale);
              height = baseHeight * multiplier;
            }
            
            return -height / 2;
          })
          .attr('width', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'directory') return 0;
            
            const baseWidth = node.baseWidth || 200;
            let width = baseWidth;
            
            if (zoomScale < ZOOM_THRESHOLD) {
              const multiplier = Math.min(MAX_DIR_SCALE, ZOOM_THRESHOLD / zoomScale);
              width = baseWidth * multiplier;
            }
            
            return width;
          })
          .attr('height', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'directory') return 0;
            
            const baseHeight = node.baseHeight || 100;
            let height = baseHeight;
            
            if (zoomScale < ZOOM_THRESHOLD) {
              const multiplier = Math.min(MAX_DIR_SCALE, ZOOM_THRESHOLD / zoomScale);
              height = baseHeight * multiplier;
            }
            
            return height;
          });
        
        // Update directory name font sizes - scale proportionally with box size
        d3.selectAll('.directory-name')
          .style('font-size', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'directory') return null;
            
            // Calculate font size based on the base height
            const baseHeight = node.baseHeight || 100;
            // Font size should be approximately 55% of box height for good readability
            const baseFontSize = baseHeight * 0.55;
            
            let fontSize;
            if (zoomScale >= ZOOM_THRESHOLD) {
              fontSize = baseFontSize;
            } else {
              const multiplier = Math.min(MAX_DIR_SCALE, ZOOM_THRESHOLD / zoomScale);
              fontSize = baseFontSize * multiplier;
            }
            
            return fontSize + 'px';
          })
          .text(function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'directory') return '';
            const parts = node.label.split('/');
            return parts[parts.length - 1];
          })
          .each(function() {
            // No truncation needed - boxes are now sized to fit text
            // This function is kept for potential future use
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'directory') return;
          });
        
        // File element scaling:
        // Scale file UI elements (badges, buttons, triangles) inversely with zoom
        // so they maintain a consistent visual size on screen
        const FILE_ZOOM_THRESHOLD = 1.0; // Below this, elements start growing
        const MAX_FILE_ELEMENT_SCALE = 3.0; // Maximum growth when zoomed out
        const LINE_COUNT_HIDE_THRESHOLD = 0.5; // Hide line count below 50% zoom
        
        // Calculate scale factor for file elements
        const elementScale = zoomScale >= FILE_ZOOM_THRESHOLD ? 1 : 
          Math.min(MAX_FILE_ELEMENT_SCALE, FILE_ZOOM_THRESHOLD / zoomScale);
        
        // Hide line count when zoomed out
        const showLineCount = zoomScale >= LINE_COUNT_HIDE_THRESHOLD;
        
        // Update line count badge background
        d3.selectAll('.line-count-badge')
          .style('display', showLineCount ? 'block' : 'none')
          .attr('width', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'file') return 0;
            const text = String(node.lines);
            const baseWidth = Math.max(14, text.length * 4 + 4);
            return baseWidth * elementScale;
          })
          .attr('height', 9 * elementScale)
          .attr('x', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'file') return 0;
            const text = String(node.lines);
            const baseWidth = Math.max(14, text.length * 4 + 4);
            return -baseWidth * elementScale / 2;
          })
          .attr('y', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'file') return 0;
            return -node.height / 2 + 3 * elementScale;
          })
          .attr('rx', 2 * elementScale)
          .attr('ry', 2 * elementScale);
        
        // Update line count text
        d3.selectAll('.node-sublabel')
          .style('display', showLineCount ? 'block' : 'none')
          .attr('y', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'file') return 0;
            return -node.height / 2 + 7.5 * elementScale;
          })
          .style('font-size', (6 * elementScale) + 'px');
        
        // Update symbol triangles (functions, variables, types)
        d3.selectAll('.functions-triangle')
          .attr('transform', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'file') return '';
            const x = node.size / 2 - 10 * elementScale;
            const y = node.height / 2 - 10 * elementScale;
            return \`translate(\${x}, \${y}) scale(\${elementScale})\`;
          });
        
        d3.selectAll('.variables-triangle')
          .attr('transform', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'file') return '';
            const x = -node.size / 2 + 10 * elementScale;
            const y = node.height / 2 - 10 * elementScale;
            return \`translate(\${x}, \${y}) scale(\${elementScale})\`;
          });
        
        d3.selectAll('.types-triangle')
          .attr('transform', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'file') return '';
            const x = 0;
            const y = node.height / 2 - 10 * elementScale;
            return \`translate(\${x}, \${y}) scale(\${elementScale})\`;
          });
        
        // Update copy button
        d3.selectAll('.copy-button')
          .attr('transform', function() {
            const node = d3.select(this.parentNode).datum();
            if (!node || node.type !== 'file') return '';
            const x = node.size / 2 - 10 * elementScale;
            const y = -node.height / 2 + 10 * elementScale;
            return \`translate(\${x}, \${y}) scale(\${elementScale})\`;
          });
        
      }
      
      
      // Create a map of directory -> files for radial positioning
      const dirToFiles = new Map();
      const dirNodeMap = new Map(); // Map dirPath -> directory node
      
      // First pass: map directory nodes and pre-calculate their dimensions
      nodes.forEach(node => {
        if (node.type === 'directory') {
          dirNodeMap.set(node.path, node);
          
          // Pre-calculate directory dimensions (same logic as when creating rects)
          const fontSize = getDirFontSize(node.depth || 0);
          const MIN_DIR_WIDTH = 120;
          const width = Math.max(MIN_DIR_WIDTH, getTextWidth(node.label, fontSize));
          const height = fontSize * 1.8;
          node.baseWidth = width;
          node.baseHeight = height;
        }
      });
      
      // Second pass: group files by parent directory
      nodes.forEach(node => {
        if (node.type === 'file') {
          let fileDir = node.path.substring(0, node.path.lastIndexOf('/'));
          // Root-level files have empty fileDir, map them to '.'
          if (!fileDir || fileDir === '') {
            fileDir = '.';
          }
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
          // The root directory (path === '.') has no parent
          if (node.path === '.') {
            rootDirs.push(node);
            return;
          }
          
          // Find parent path - for top-level dirs like 'src', parent is '.'
          let parentPath = node.path.substring(0, node.path.lastIndexOf('/'));
          if (!parentPath || parentPath === '') {
            parentPath = '.'; // Top-level directories have root as parent
          }
          
          if (dirNodeMap.has(parentPath)) {
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
      
      // Position directories with spacing based on their file grid height
      const BASE_DIR_RADIUS = 400; // Base vertical spacing between directories
      const DIRS_PER_LAYER = 8;
      
      // Skyline Bottom-Left bin packing algorithm
      // Places rectangles freely in 2D space, finding the lowest available position
      // All files have fixed width, variable height based on line count
      // Returns { width, height, placements: Map<file, {x, y}> }
      function skylinePack(files, spacing) {
        if (files.length === 0) return { width: 0, height: 0, placements: new Map() };
        
        // Sort by height descending for better packing (tallest first)
        const sortedFiles = [...files].sort((a, b) => b.height - a.height);
        
        // Calculate container width based on total area
        // With fixed width, we can calculate optimal columns
        const fileWidth = files[0]?.size || 120;
        const totalArea = files.reduce((sum, f) => sum + (f.size + spacing) * (f.height + spacing), 0);
        // Aim for roughly square aspect ratio
        let containerWidth = Math.max(Math.sqrt(totalArea * 1.2), fileWidth + spacing);
        
        // Skyline: array of {x, y, width} segments representing the top edge
        // Initially one segment at y=0 spanning the full width
        let skyline = [{ x: 0, y: 0, width: containerWidth }];
        const placements = new Map();
        
        // Find the lowest position where a rectangle of given size can fit
        function findPosition(w, h) {
          let bestX = -1;
          let bestY = Infinity;
          let bestIndex = -1;
          
          // Try each skyline segment as a potential left edge
          for (let i = 0; i < skyline.length; i++) {
            const seg = skyline[i];
            
            // Check if rectangle fits starting at this segment
            if (seg.x + w > containerWidth) continue;
            
            // Find the maximum y across all segments this rectangle would span
            let maxY = seg.y;
            let spanWidth = 0;
            for (let j = i; j < skyline.length && spanWidth < w; j++) {
              maxY = Math.max(maxY, skyline[j].y);
              spanWidth += skyline[j].width;
            }
            
            // Check if we have enough width
            if (spanWidth < w && seg.x + spanWidth < containerWidth) continue;
            
            // This is a valid position - check if it's the best (lowest)
            if (maxY < bestY) {
              bestY = maxY;
              bestX = seg.x;
              bestIndex = i;
            }
          }
          
          return { x: bestX, y: bestY, index: bestIndex };
        }
        
        // Update skyline after placing a rectangle
        function updateSkyline(x, y, w, h) {
          const newY = y + h;
          const rightEdge = x + w;
          
          // Build new skyline
          const newSkyline = [];
          
          for (const seg of skyline) {
            const segRight = seg.x + seg.width;
            
            if (segRight <= x || seg.x >= rightEdge) {
              // Segment doesn't overlap with placed rectangle
              newSkyline.push(seg);
            } else {
              // Segment overlaps - need to split/modify
              
              // Part before the rectangle
              if (seg.x < x) {
                newSkyline.push({ x: seg.x, y: seg.y, width: x - seg.x });
              }
              
              // The rectangle's top edge (only add once)
              const existingNew = newSkyline.find(s => s.x === x && s.y === newY);
              if (!existingNew) {
                newSkyline.push({ x: x, y: newY, width: w });
              }
              
              // Part after the rectangle
              if (segRight > rightEdge) {
                newSkyline.push({ x: rightEdge, y: seg.y, width: segRight - rightEdge });
              }
            }
          }
          
          // Sort by x and merge adjacent segments at same height
          newSkyline.sort((a, b) => a.x - b.x);
          
          const merged = [];
          for (const seg of newSkyline) {
            if (merged.length > 0) {
              const last = merged[merged.length - 1];
              if (Math.abs(last.x + last.width - seg.x) < 0.1 && Math.abs(last.y - seg.y) < 0.1) {
                last.width += seg.width;
                continue;
              }
            }
            merged.push({ ...seg });
          }
          
          skyline = merged;
        }
        
        // Place each file
        for (const file of sortedFiles) {
          const w = file.size + spacing;
          const h = file.height + spacing;
          
          let pos = findPosition(w, h);
          
          // If doesn't fit, expand container width
          if (pos.x < 0) {
            containerWidth += w;
            skyline.push({ x: containerWidth - w, y: 0, width: w });
            pos = findPosition(w, h);
          }
          
          if (pos.x >= 0) {
            placements.set(file, { x: pos.x, y: pos.y });
            updateSkyline(pos.x, pos.y, w, h);
          }
        }
        
        // Calculate actual bounds
        let maxX = 0, maxY = 0;
        for (const [file, pos] of placements) {
          maxX = Math.max(maxX, pos.x + file.size + spacing);
          maxY = Math.max(maxY, pos.y + file.height + spacing);
        }
        
        return { 
          width: maxX - spacing, 
          height: maxY - spacing,
          placements 
        };
      }
      
      // Layout calculation helper for bounding box (must match actual layout)
      function calculateSkylineLayout(files, spacing) {
        if (files.length === 0) return { width: 0, height: 0 };
        const { width, height } = skylinePack(files, spacing);
        return { width, height };
      }
      
      // Calculate required vertical space for a directory's file grid
      // This MUST match the actual grid layout calculation
      function calculateFileSpace(dirPath, dirNode) {
        const files = dirToFiles.get(dirPath) || [];
        if (files.length === 0) return 0;
        
        const { height } = calculateSkylineLayout(files, FILE_GRID_SPACING);
        return height + 10; // +10 for DIR_FILE_GAP
      }
      
      // TOP-DOWN TREE LAYOUT
      // Position directories in a hierarchical tree structure (root at top, children below)
      const VERTICAL_SPACING = 180; // Vertical gap between directory levels (increased)
      const HORIZONTAL_SPACING = 20; // Minimum horizontal gap between sibling bounding boxes
      const ROOT_Y = 150; // Y position for root directories
      const FILE_GRID_SPACING = 4; // Must match FILE_SPACING used in file grid layout
      
      // Calculate the bounding box dimensions for a directory (dir box + file grid)
      // This MUST match the actual grid layout calculation in the file positioning code
      function calculateBoundingBox(dirNode) {
        const files = dirToFiles.get(dirNode.path) || [];
        const dirWidth = dirNode.baseWidth || 200;
        const dirHeight = dirNode.baseHeight || 100;
        
        if (files.length === 0) {
          return { width: dirWidth, height: dirHeight };
        }
        
        const { width: fileGridWidth, height: fileGridHeight } = calculateSkylineLayout(files, FILE_GRID_SPACING);
        
        // Bounding box is the max width and combined height
        // Add margin to prevent any overlap between siblings
        return {
          width: Math.max(dirWidth, fileGridWidth) + 40,
          height: dirHeight + fileGridHeight + 10 // +10 for DIR_FILE_GAP
        };
      }
      
      // Calculate the width needed for a subtree (bounding box + all descendants)
      function calculateSubtreeWidth(dirNode) {
        const childDirs = dirHierarchy.get(dirNode.path) || [];
        const bbox = calculateBoundingBox(dirNode);
        
        if (childDirs.length === 0) {
          // Leaf directory: width is just this directory's bounding box
          return bbox.width;
        }
        
        // Sum of all children's subtree widths + spacing between them
        let totalChildrenWidth = 0;
        childDirs.forEach((child, i) => {
          totalChildrenWidth += calculateSubtreeWidth(child);
          if (i > 0) totalChildrenWidth += HORIZONTAL_SPACING;
        });
        
        // Return the larger of: own bounding box width or total children width
        return Math.max(bbox.width, totalChildrenWidth);
      }
      
      // Position a directory and all its descendants in top-down tree layout
      function positionTreeRecursively(dirNode, centerX, y) {
        // Skip if directory has a saved position
        if (dirNode.fx !== undefined && dirNode.fy !== undefined) {
          dirNode.x = dirNode.fx;
          dirNode.y = dirNode.fy;
        } else {
          dirNode.x = centerX;
          dirNode.y = y;
          dirNode.fx = dirNode.x;
          dirNode.fy = dirNode.y;
        }
        
        const childDirs = dirHierarchy.get(dirNode.path) || [];
        if (childDirs.length === 0) return;
        
        // Calculate file grid height for this directory
        const fileGridHeight = dirNode.fileGridHeight || calculateFileSpace(dirNode.path, dirNode);
        const dirHeight = dirNode.baseHeight || 100;
        
        // Position children below this directory (after its files)
        const childY = dirNode.y + dirHeight / 2 + fileGridHeight + VERTICAL_SPACING;
        
        // Calculate total width needed for all children
        const childWidths = childDirs.map(child => calculateSubtreeWidth(child));
        const totalChildrenWidth = childWidths.reduce((sum, w) => sum + w, 0) + 
                                   (childDirs.length - 1) * HORIZONTAL_SPACING;
        
        // Start positioning children from the left
        let childX = centerX - totalChildrenWidth / 2;
        
        childDirs.forEach((child, i) => {
          const childWidth = childWidths[i];
          const childCenterX = childX + childWidth / 2;
          
          positionTreeRecursively(child, childCenterX, childY);
          
          childX += childWidth + HORIZONTAL_SPACING;
        });
      }
      
      // Position root directories
      if (rootDirs.length === 1) {
        // Single root - center it at top
        const rootDir = rootDirs[0];
        positionTreeRecursively(rootDir, width / 2, ROOT_Y);
      } else {
        // Multiple roots - position them horizontally at top
        const rootWidths = rootDirs.map(root => calculateSubtreeWidth(root));
        const totalRootsWidth = rootWidths.reduce((sum, w) => sum + w, 0) + 
                                (rootDirs.length - 1) * HORIZONTAL_SPACING * 4; // Extra spacing between roots
        
        let rootX = width / 2 - totalRootsWidth / 2;
        
        rootDirs.forEach((rootDir, i) => {
          // Skip if root has a saved position
          if (rootDir.fx !== undefined && rootDir.fy !== undefined) {
            rootDir.x = rootDir.fx;
            rootDir.y = rootDir.fy;
            // Still position children relative to saved position
            const childDirs = dirHierarchy.get(rootDir.path) || [];
            if (childDirs.length > 0) {
              const fileGridHeight = rootDir.fileGridHeight || calculateFileSpace(rootDir.path, rootDir);
              const dirHeight = rootDir.baseHeight || 100;
              const childY = rootDir.y + dirHeight / 2 + fileGridHeight + VERTICAL_SPACING;
              
              const childWidths = childDirs.map(child => calculateSubtreeWidth(child));
              const totalChildrenWidth = childWidths.reduce((sum, w) => sum + w, 0) + 
                                         (childDirs.length - 1) * HORIZONTAL_SPACING;
              let childX = rootDir.x - totalChildrenWidth / 2;
              
              childDirs.forEach((child, j) => {
                const childWidth = childWidths[j];
                positionTreeRecursively(child, childX + childWidth / 2, childY);
                childX += childWidth + HORIZONTAL_SPACING;
              });
            }
          } else {
            const rootWidth = rootWidths[i];
            const rootCenterX = rootX + rootWidth / 2;
            positionTreeRecursively(rootDir, rootCenterX, ROOT_Y);
            rootX += rootWidth + HORIZONTAL_SPACING * 4;
          }
        });
      }
      
      // Position files using Skyline Bottom-Left bin packing
      // Free 2D placement for optimal space utilization
      const FILE_SPACING = 4; // Gap between files
      const DIR_FILE_GAP = 10; // Gap between directory box and file grid
      
      dirToFiles.forEach((files, dirPath) => {
        const parentDir = dirNodeMap.get(dirPath);
        
        if (!parentDir) {
          files.forEach(file => {
            file.parentDir = null;
            file.x = width / 2 + (Math.random() - 0.5) * 200;
            file.y = height / 2 + (Math.random() - 0.5) * 200;
          });
          return;
        }
        
        const dirHeight = parentDir.baseHeight || 100;
        const fileCount = files.length;
        
        if (fileCount === 0) {
          parentDir.fileGridHeight = 0;
          return;
        }
        
        // Run Skyline packing algorithm
        const { width: gridWidth, height: gridHeight, placements } = skylinePack(files, FILE_SPACING);
        
        // Convert placements to grid offsets (centered under directory)
        files.forEach(file => {
          const pos = placements.get(file);
          if (!pos) return;
          
          const fileWidth = file.size;
          const fileHeight = file.height;
          
          // pos.x/pos.y are top-left, convert to center and center the grid
          const gridOffsetX = -gridWidth / 2 + pos.x + fileWidth / 2;
          const gridOffsetY = dirHeight / 2 + DIR_FILE_GAP + pos.y + fileHeight / 2;
          
          file.parentDir = parentDir;
          file.gridOffsetX = gridOffsetX;
          file.gridOffsetY = gridOffsetY;
          
          file.x = parentDir.x + file.gridOffsetX;
          file.y = parentDir.y + file.gridOffsetY;
        });
        
        // Store the total height of the file grid for child directory positioning
        parentDir.fileGridHeight = gridHeight + DIR_FILE_GAP;
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
        .force('grid', alpha => {
          // Skip grid force during resize to prevent files from flying away
          if (isResizing) return;
          
          // Custom force to keep files in their grid positions below parent directory
          nodes.forEach(node => {
            if (node.type !== 'file' || !node.parentDir) return;
            if (node.gridOffsetX === undefined || node.gridOffsetY === undefined) return;
            
            // Calculate position relative to parent directory's current position
            const targetX = node.parentDir.x + node.gridOffsetX;
            const targetY = node.parentDir.y + node.gridOffsetY;
            
            node.x = targetX;
            node.y = targetY;
            node.vx = 0;
            node.vy = 0;
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
          const source = d.source;
          const target = d.target;
          if (source.type === 'directory' && target.type === 'directory') {
            return '#888'; // Visible gray for directory hierarchy
          }
          return '#444'; // Darker gray for directory-to-file
        })
        .style('stroke-width', d => {
          const source = d.source;
          const target = d.target;
          if (source.type === 'directory' && target.type === 'directory') {
            return 2; // Thicker for directory hierarchy
          }
          return 0.5; // Very thin for directory-to-file
        })
        .style('opacity', d => {
          const source = d.source;
          const target = d.target;
          if (source.type === 'directory' && target.type === 'directory') {
            return 0.7; // More visible for directory hierarchy
          }
          return 0.3; // Very subtle for directory-to-file
        })
        .style('fill', 'none');
      
      // Create nodes
      const nodeGroup = g.append('g').attr('class', 'nodes');
      
      // Separate file and directory nodes for proper layering
      const fileNodes = nodes.filter(n => n.type === 'file');
      const dirNodes = nodes.filter(n => n.type === 'directory');
      
      // Sort directories by depth (descending) so parent dirs render on top of child dirs
      // Higher depth = deeper in hierarchy = render first (behind)
      // Lower depth = parent = render last (on top)
      dirNodes.sort((a, b) => (b.depth || 0) - (a.depth || 0));
      
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
      
      // Add rectangles for files (size based on line count)
      console.log('[Files Map Webview] Creating file rectangles for', fileElements.size(), 'files');
      
      const fileRects = fileElements
        .append('rect')
        .attr('width', d => d.size)
        .attr('height', d => d.height)
        .attr('x', d => -d.size / 2)
        .attr('y', d => -d.height / 2)
        .attr('class', 'file-rect')
        .style('fill', d => getFileColor(d))
        .style('stroke', '#333')
        .style('stroke-width', 1);
      
      console.log('[Files Map Webview] File rectangles created:', fileRects.size());

      // Add square shapes for directories
      const dirRects = dirElements
        .append('rect')
        .each(function(d) {
          const fontSize = getDirFontSize(d.depth || 0);
          const MIN_DIR_WIDTH = 120; // Minimum width for directory boxes
          const width = Math.max(MIN_DIR_WIDTH, getTextWidth(d.label, fontSize));
          const height = fontSize * 1.8; // Height proportional to font size
          
          // Store the base width and height on the node for use in zoom updates
          d.baseWidth = width;
          d.baseHeight = height;
        })
        .attr('x', d => -d.baseWidth / 2)
        .attr('y', d => -d.baseHeight / 2)
        .attr('width', d => d.baseWidth)
        .attr('height', d => d.baseHeight)
        .attr('class', 'dir-rect')
        .style('fill', d => getDirBoxColor(d.path))
        .style('stroke', 'none');
      
      // Add line count badge for files (small, at top center inside the box)
      
      // Add background rectangle for line count
      fileElements.append('rect')
        .attr('class', 'line-count-badge')
        .attr('width', d => {
          const text = String(d.lines);
          return Math.max(14, text.length * 4 + 4);
        })
        .attr('height', 9)
        .attr('x', d => -Math.max(14, String(d.lines).length * 4 + 4) / 2) // Center horizontally
        .attr('y', d => -d.height / 2 + 3) // Position at top inside the box
        .attr('rx', 2)
        .attr('ry', 2)
        .style('fill', 'rgba(0, 0, 0, 0.5)')
        .style('stroke', 'none');
      
      // Add line count text
      fileElements.append('text')
        .attr('class', 'node-sublabel')
        .attr('x', 0) // Center horizontally
        .attr('y', d => -d.height / 2 + 7.5) // Center vertically in badge (3 + 9/2 = 7.5)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .style('font-size', '6px')
        .style('fill', '#fff')
        .text(d => d.lines);
      
      // Add yellow triangles for functions (bottom-right inside the box)
      const functionsTriangle = fileElements.append('g')
        .attr('class', d => {
          const baseClass = 'symbol-triangle functions-triangle';
          return d.functions.length === 0 ? baseClass + ' empty' : baseClass;
        })
        .attr('transform', d => {
          // Position at bottom-right inside the box (with padding from edge)
          const x = d.size / 2 - 10;
          const y = d.height / 2 - 10;
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
        .attr('x', -5)
        .attr('y', -5)
        .attr('width', 10)
        .attr('height', 10)
        .attr('rx', 2)
        .attr('ry', 2);
      
      // Add 'f' label to functions square
      functionsTriangle.append('text')
        .attr('x', 0)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', '7px')
        .style('font-weight', 'bold')
        .style('fill', '#000')
        .style('pointer-events', 'none')
        .text('f');
      
      // Add yellow triangles for variables (bottom-left inside the box)
      const variablesTriangle = fileElements.append('g')
        .attr('class', d => {
          const baseClass = 'symbol-triangle variables-triangle';
          return d.variables.length === 0 ? baseClass + ' empty' : baseClass;
        })
        .attr('transform', d => {
          // Position at bottom-left inside the box (with padding from edge)
          const x = -d.size / 2 + 10;
          const y = d.height / 2 - 10;
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
        .attr('x', -5)
        .attr('y', -5)
        .attr('width', 10)
        .attr('height', 10)
        .attr('rx', 2)
        .attr('ry', 2);
      
      // Add 'v' label to variables square
      variablesTriangle.append('text')
        .attr('x', 0)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', '7px')
        .style('font-weight', 'bold')
        .style('fill', '#000')
        .style('pointer-events', 'none')
        .text('v');
      
      // Add rounded square for types (bottom-center inside the box)
      const typesTriangle = fileElements.append('g')
        .attr('class', d => {
          const baseClass = 'symbol-triangle types-triangle';
          return d.types.length === 0 ? baseClass + ' empty' : baseClass;
        })
        .attr('transform', d => {
          // Position at bottom-center inside the box (with padding from edge)
          const x = 0;
          const y = d.height / 2 - 10;
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
        .attr('x', -5)
        .attr('y', -5)
        .attr('width', 10)
        .attr('height', 10)
        .attr('rx', 2)
        .attr('ry', 2);
      
      // Add 't' label to types square
      typesTriangle.append('text')
        .attr('x', 0)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', '7px')
        .style('font-weight', 'bold')
        .style('fill', '#000')
        .style('pointer-events', 'none')
        .text('t');
      
      // Add copy button group (icon only) at top-right corner inside the box
      const copyButtonGroup = fileElements.append('g')
        .attr('class', 'copy-button')
        .attr('transform', d => {
          // Position at top-right corner inside the file box (with padding from edge)
          const x = d.size / 2 - 10;
          const y = -d.height / 2 + 10;
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
        .attr('x', -3)
        .attr('y', -2)
        .attr('width', 5)
        .attr('height', 6)
        .attr('rx', 1)
        .attr('ry', 1)
        .style('fill', 'none')
        .style('stroke', '#fff')
        .style('stroke-width', 1);
      
      // Front rectangle (outline only)
      copyButtonGroup.append('rect')
        .attr('class', 'copy-button-icon')
        .attr('x', -1)
        .attr('y', -4)
        .attr('width', 5)
        .attr('height', 6)
        .attr('rx', 1)
        .attr('ry', 1)
        .style('fill', 'none')
        .style('stroke', '#fff')
        .style('stroke-width', 1);
      
      // Add directory name label (centered, with text clipping)
      dirElements
        .append('text')
        .attr('class', 'node-label directory-name')
        .attr('x', 0)
        .attr('y', 0)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('font-size', d => {
          const fontSizes = [56, 40, 26, 16];
          const fontSize = fontSizes[Math.min(d.depth || 0, fontSizes.length - 1)];
          return \`\${fontSize}px\`;
        })
        .style('fill', '#000')
        .style('font-weight', 'bold')
        .style('overflow', 'hidden')
        .style('text-overflow', 'ellipsis')
        .style('white-space', 'nowrap')
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
        .style('pointer-events', 'none')
        .text(d => d.label)
        .each(function(d) {
          // Dynamically adjust font size to fit the box (both width and height)
          const textElement = this;
          const marginX = 4; // Small margin on left and right
          const marginY = 2; // Small margin on top and bottom
          const availableWidth = d.size - (marginX * 2);
          const availableHeight = d.height - (marginY * 2);
          
          // Start with font size that fits height (font size ≈ line height)
          let maxFontSize = Math.min(availableHeight * 0.9, 14); // Cap at 14px max
          const minFontSize = 4; // Allow very small text for small files
          
          // Binary search for optimal font size that fits within available width
          let low = minFontSize;
          let high = maxFontSize;
          
          while (high - low > 0.5) {
            const fontSize = (low + high) / 2;
            textElement.style.fontSize = fontSize + 'px';
            const textWidth = textElement.getComputedTextLength();
            
            if (textWidth > availableWidth) {
              high = fontSize;
            } else {
              low = fontSize;
            }
          }
          
          // Use the largest font size that fits
          textElement.style.fontSize = low + 'px';
        });
      
      // Update positions on tick
      simulation.on('tick', () => {
        // When resizing, directly lock files to their grid positions
        // This prevents files from flying away during resize
        if (isResizing) {
          nodes.forEach(node => {
            if (node.type === 'file' && node.parentDir && node.gridOffsetX !== undefined && node.gridOffsetY !== undefined) {
              node.x = node.parentDir.x + node.gridOffsetX;
              node.y = node.parentDir.y + node.gridOffsetY;
              node.vx = 0;
              node.vy = 0;
            }
          });
        }
        
        edgeElements.attr('d', d => {
          // Guard against undefined coordinates
          if (d.source.x === undefined || d.source.y === undefined || 
              d.target.x === undefined || d.target.y === undefined) {
            return null;
          }
          // Use orthogonal (square) connectors: down from source, horizontal, then down to target
          const sourceY = d.source.y + (d.source.baseHeight || 50) / 2; // Bottom of source box
          const targetY = d.target.y - (d.target.baseHeight || 50) / 2; // Top of target box
          const midY = (sourceY + targetY) / 2; // Midpoint for horizontal segment
          
          return \`M\${d.source.x},\${sourceY} L\${d.source.x},\${midY} L\${d.target.x},\${midY} L\${d.target.x},\${targetY}\`;
        });
        
        nodeElements.attr('transform', d => {
          if (d.x === undefined || d.y === undefined) return null;
          return \`translate(\${d.x},\${d.y})\`;
        });
        
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
        case 'index:complete':
          // Re-enable the index button and hide spinner
          const indexBtn = document.getElementById('index-project-btn');
          const btnText = document.getElementById('index-btn-text');
          const spinner = document.getElementById('index-spinner');
          if (indexBtn) indexBtn.disabled = false;
          if (btnText) btnText.textContent = 'Index Project';
          if (spinner) spinner.style.display = 'none';
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
        
        // Restore directory sizes based on current zoom level
        if (updateDirectorySizes && svg) {
          const currentTransform = d3.zoomTransform(svg.node());
          updateDirectorySizes(currentTransform.k);
        }
        
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
    
    // Handle window resize - just update SVG dimensions, keep nodes in place
    window.addEventListener('resize', () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      svg.attr('width', width).attr('height', height);
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


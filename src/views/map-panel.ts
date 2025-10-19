import * as vscode from 'vscode';
import { GraphStore, Node, Edge } from '../store/schema';
import { RadiumConfigLoader } from '../config/radium-config';
import { GitDiffTracker } from '../git/git-diff-tracker';

export class MapPanel {
  public static currentPanel: MapPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private static outputChannel: vscode.OutputChannel;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private store: GraphStore,
    private configLoader: RadiumConfigLoader,
    private gitDiffTracker?: GitDiffTracker
  ) {
    this.panel = panel;
    
    // Listen for messages from webview BEFORE setting HTML
    MapPanel.outputChannel.appendLine('Registering message handler');
    this.panel.webview.onDidReceiveMessage(
      message => {
        MapPanel.outputChannel.appendLine(`Message received: ${message.type}`);
        this.handleMessage(message);
      },
      null,
      this.disposables
    );

    // Set HTML content after registering listener
    this.panel.webview.html = this.getHtmlContent(extensionUri);

    // Clean up when panel is closed
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Send initial data
    this.updateGraph();
  }

  public static createOrShow(extensionUri: vscode.Uri, store: GraphStore, configLoader: RadiumConfigLoader, gitDiffTracker?: GitDiffTracker) {
    // Initialize output channel if needed
    if (!MapPanel.outputChannel) {
      MapPanel.outputChannel = vscode.window.createOutputChannel('Radium Map');
    }
    
    MapPanel.outputChannel.appendLine('createOrShow called');
    
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (MapPanel.currentPanel) {
      MapPanel.outputChannel.appendLine('Panel already exists, revealing');
      // Update the git diff tracker if provided
      if (gitDiffTracker) {
        MapPanel.currentPanel.gitDiffTracker = gitDiffTracker;
      }
      MapPanel.currentPanel.panel.reveal(column);
      return;
    }
    
    MapPanel.outputChannel.appendLine('Creating new panel');

    const panel = vscode.window.createWebviewPanel(
      'vibeMap',
      'Radium Map',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    MapPanel.currentPanel = new MapPanel(panel, extensionUri, store, configLoader, gitDiffTracker);
  }

  private async handleMessage(message: any) {
    console.log('[Radium] Received message:', message.type);
    switch (message.type) {
      case 'node:selected':
        await this.handleNodeSelected(message.nodeId);
        break;
      case 'file:open':
        await this.handleFileOpen(message.filePath);
        break;
      case 'edge:path':
        await this.handleEdgePath(message.srcId, message.dstId);
        break;
      case 'overlay:toggle':
        await this.handleOverlayToggle(message.layer, message.enabled);
        break;
      case 'request:recent-changes':
        console.log('[Radium] Handling request:recent-changes');
        await this.handleShowRecentChanges();
        break;
      case 'ready':
        this.updateGraph();
        break;
      default:
        console.log('[Radium] Unknown message type:', message.type);
    }
  }

  private async handleShowRecentChanges() {
    MapPanel.outputChannel.appendLine('handleShowRecentChanges called');
    
    if (!this.gitDiffTracker) {
      MapPanel.outputChannel.appendLine('ERROR: Git diff tracker not available');
      vscode.window.showWarningMessage('Git diff tracker not available');
      return;
    }

    MapPanel.outputChannel.appendLine('Creating session from git changes (working directory)...');
    
    // Create session from uncommitted changes in working directory
    const sessionId = await this.gitDiffTracker.createSessionFromGitChanges();
    
    MapPanel.outputChannel.appendLine(`Session ID: ${sessionId}`);
    
    if (!sessionId) {
      vscode.window.showInformationMessage('No uncommitted changes found');
      return;
    }

    const changes = this.store.getChangesBySession(sessionId);
    MapPanel.outputChannel.appendLine(`Showing ${changes.length} uncommitted changes`);
    
    // Log details about the changes
    const allFiles = this.store.getAllFiles();
    MapPanel.outputChannel.appendLine(`Total files in index: ${allFiles.length}`);
    MapPanel.outputChannel.appendLine(`Changed files:`);
    changes.forEach(c => {
      const hunks = JSON.parse(c.hunks_json);
      MapPanel.outputChannel.appendLine(`  - ${hunks.filePath || 'unknown'}`);
    });
    
    // Update overlay to show changes with connected components
    this.updateOverlay(sessionId, true);
  }

  private async handleFileOpen(filePath: string) {
    console.log(`[Radium] Opening file: ${filePath}`);
    try {
      // Resolve relative path to absolute path
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open');
      }
      
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      console.log(`[Radium] Workspace root: ${workspaceRoot}`);
      
      // If path is relative (doesn't start with workspace root), join it
      let absolutePath: string;
      if (filePath.startsWith(workspaceRoot)) {
        // Already absolute
        absolutePath = filePath;
      } else {
        // Relative path - join with workspace root
        // Remove leading slash if present
        const relativePath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
        absolutePath = `${workspaceRoot}/${relativePath}`;
      }
      
      console.log(`[Radium] Resolved path: ${absolutePath}`);
      const uri = vscode.Uri.file(absolutePath);
      await vscode.window.showTextDocument(uri);
    } catch (error) {
      console.error(`[Radium] Failed to open file:`, error);
      vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
    }
  }

  private async handleNodeSelected(nodeId: number) {
    const node = this.store.getNodeById(nodeId);
    if (!node) return;

    // Open file at node location
    const uri = vscode.Uri.file(node.path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    const startPos = doc.positionAt(node.range_start);
    const endPos = doc.positionAt(node.range_end);
    const range = new vscode.Range(startPos, endPos);

    editor.selection = new vscode.Selection(startPos, startPos);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  private async handleEdgePath(srcId: number, dstId: number) {
    // Compute shortest path using BFS
    const path = this.findPath(srcId, dstId);
    
    this.panel.webview.postMessage({
      type: 'path:result',
      path
    });
  }

  private findPath(srcId: number, dstId: number): number[] {
    const allEdges = this.store.getAllEdges();
    const adjacency = new Map<number, number[]>();

    // Build adjacency list
    for (const edge of allEdges) {
      if (!adjacency.has(edge.src)) {
        adjacency.set(edge.src, []);
      }
      adjacency.get(edge.src)!.push(edge.dst);
    }

    // BFS
    const queue: [number, number[]][] = [[srcId, [srcId]]];
    const visited = new Set<number>([srcId]);

    while (queue.length > 0) {
      const [current, path] = queue.shift()!;

      if (current === dstId) {
        return path;
      }

      const neighbors = adjacency.get(current) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([neighbor, [...path, neighbor]]);
        }
      }
    }

    return [];
  }

  private async handleOverlayToggle(layer: string, enabled: boolean) {
    // Handle overlay visibility
    console.log(`Toggle ${layer}: ${enabled}`);
  }

  public updateGraph() {
    const allNodes = this.store.getAllNodes();
    const allEdges = this.store.getAllEdges();
    const allFiles = this.store.getAllFiles();

    // Build hierarchical structure
    const graphData = this.buildHierarchicalGraph(allNodes, allEdges, allFiles);

    this.panel.webview.postMessage({
      type: 'graph:update',
      data: graphData
    });
  }

  private buildComponentBasedGraph(allNodes: any[], allEdges: any[], allFiles: any[], config: any) {
    const nodes: any[] = [];
    const edges: any[] = [];
    const nodeMap = new Map<string, number>();
    let nodeId = 1;

    // Hash function to generate consistent colors for component names
    const hashStringToColor = (str: string): string => {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      
      // Generate HSL color with good saturation and lightness for visibility
      const hue = Math.abs(hash % 360);
      const saturation = 65 + (Math.abs(hash >> 8) % 20); // 65-85%
      const lightness = 50 + (Math.abs(hash >> 16) % 15); // 50-65%
      
      return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    };

    // Map to store component colors
    const componentColors = new Map<string, string>();

    // Group files by component
    const filesByComponent = new Map<string, any[]>();
    const unmatchedFiles: any[] = [];

    for (const file of allFiles) {
      const componentInfo = this.configLoader.getComponentForFile(file.path);
      if (componentInfo) {
        if (!filesByComponent.has(componentInfo.key)) {
          filesByComponent.set(componentInfo.key, []);
        }
        filesByComponent.get(componentInfo.key)!.push(file);
      } else {
        unmatchedFiles.push(file);
      }
    }

    // Create component nodes with unique colors
    const componentNodes = new Map<string, number>();
    const externalNodes = new Map<string, number>();
    
    for (const [componentKey, files] of filesByComponent.entries()) {
      if (files.length === 0) continue;
      
      const component = config.projectSpec.components[componentKey];
      const componentId = nodeId++;
      const componentColor = hashStringToColor(component.name);
      
      componentNodes.set(componentKey, componentId);
      nodeMap.set(`component:${componentKey}`, componentId);
      componentColors.set(componentKey, componentColor);

      nodes.push({
        id: componentId,
        name: component.name,
        kind: 'component',
        path: componentKey,
        size: files.length,
        description: component.description,
        fullPath: componentKey,
        color: componentColor,
        componentKey: componentKey
      });
      
      console.log(`[Radium] Created component node: ${component.name}, ID: ${componentId}, color: ${componentColor}`);
      
      // Create external object nodes for this component
      if (component.external && component.external.length > 0) {
        for (const external of component.external) {
          const externalId = nodeId++;
          const externalKey = `${componentKey}:${external.name}`;
          externalNodes.set(externalKey, externalId);
          nodeMap.set(`external:${externalKey}`, externalId);
          
          nodes.push({
            id: externalId,
            name: external.name,
            kind: 'external',
            path: externalKey,
            externalType: external.type,
            description: external.description,
            fullPath: externalKey,
            componentKey: componentKey
          });
          
          // Create edge from component to external object
          edges.push({
            source: componentId,
            target: externalId,
            kind: 'uses',
            weight: 1.0,
            color: componentColor
          });
          
          console.log(`[Radium] Created external node: ${external.name} (${external.type}), ID: ${externalId}`);
        }
      }
    }

    // Create file nodes and connect to components
    const fileNodes = new Map<string, number>();
    const fileNodeObjects: any[] = [];
    
    for (const file of allFiles) {
      const fileId = nodeId++;
      fileNodes.set(file.path, fileId);
      nodeMap.set(`file:${file.path}`, fileId);

      // Determine component color for this file
      const componentInfo = this.configLoader.getComponentForFile(file.path);
      const fileColor = componentInfo ? componentColors.get(componentInfo.key) : undefined;

      const fileName = file.path.split('/').pop() || file.path;
      const fileNode = {
        id: fileId,
        name: fileName,
        kind: 'file',
        path: file.path,
        lang: file.lang,
        size: file.size,
        functions: [] as any[],
        componentColor: fileColor
      };
      fileNodeObjects.push(fileNode);
      nodes.push(fileNode);

      // Connect file to component
      if (componentInfo) {
        const componentId = componentNodes.get(componentInfo.key);
        if (componentId) {
          edges.push({
            source: componentId,
            target: fileId,
            kind: 'contains',
            weight: 0.5,
            color: fileColor
          });
        }
      }
    }

    // Note: Classes, interfaces, types, and functions are not displayed as separate nodes
    // Only files, components, and their relationships are shown

    // Add file-to-file edges for imports
    const fileImports = new Map<string, Set<string>>();
    for (const edge of allEdges) {
      if (edge.kind === 'imports') {
        const srcNode = allNodes.find(n => n.id === edge.src);
        const dstNode = allNodes.find(n => n.id === edge.dst);
        if (srcNode && dstNode && srcNode.path !== dstNode.path) {
          if (!fileImports.has(srcNode.path)) {
            fileImports.set(srcNode.path, new Set());
          }
          fileImports.get(srcNode.path)!.add(dstNode.path);
        }
      }
    }

    for (const [srcPath, dstPaths] of fileImports.entries()) {
      const srcFileId = fileNodes.get(srcPath);
      if (!srcFileId) continue;

      // Get the source file's component color
      const componentInfo = this.configLoader.getComponentForFile(srcPath);
      const edgeColor = componentInfo ? componentColors.get(componentInfo.key) : undefined;

      for (const dstPath of dstPaths) {
        const dstFileId = fileNodes.get(dstPath);
        if (dstFileId) {
          edges.push({
            source: srcFileId,
            target: dstFileId,
            kind: 'imports',
            weight: 1.5,
            color: edgeColor
          });
        }
      }
    }

    return { nodes, edges };
  }

  private buildHierarchicalGraph(allNodes: any[], allEdges: any[], allFiles: any[]) {
    const nodes: any[] = [];
    const edges: any[] = [];
    const nodeMap = new Map<string, number>();
    let nodeId = 1;

    const config = this.configLoader.getConfig();
    
    // If radium-components.yaml exists, use component-based grouping
    if (config) {
      return this.buildComponentBasedGraph(allNodes, allEdges, allFiles, config);
    }

    // Without radium-components.yaml, display files without grouping
    // (directories are not displayed)

    // Create file nodes (no directory grouping)
    const fileNodes = new Map<string, number>();
    const fileNodeObjects: any[] = [];
    for (const file of allFiles) {
      const fileId = nodeId++;
      fileNodes.set(file.path, fileId);
      nodeMap.set(`file:${file.path}`, fileId);

      const fileName = file.path.split('/').pop() || file.path;
      const fileNode = {
        id: fileId,
        name: fileName,
        kind: 'file',
        path: file.path,
        lang: file.lang,
        size: file.size,
        functions: [] as any[]
      };
      fileNodeObjects.push(fileNode);
      nodes.push(fileNode);
    }

    // Note: Classes, interfaces, types, and functions are not displayed as separate nodes
    // Only files and their relationships are shown (no directories)

    // Add file-to-file edges for imports
    const fileImports = new Map<string, Set<string>>();
    for (const edge of allEdges) {
      if (edge.kind === 'imports') {
        const srcNode = allNodes.find(n => n.id === edge.src);
        const dstNode = allNodes.find(n => n.id === edge.dst);
        if (srcNode && dstNode && srcNode.path !== dstNode.path) {
          if (!fileImports.has(srcNode.path)) {
            fileImports.set(srcNode.path, new Set());
          }
          fileImports.get(srcNode.path)!.add(dstNode.path);
        }
      }
    }

    for (const [srcPath, dstPaths] of fileImports.entries()) {
      const srcFileId = fileNodes.get(srcPath);
      if (!srcFileId) continue;

      for (const dstPath of dstPaths) {
        const dstFileId = fileNodes.get(dstPath);
        if (dstFileId) {
          edges.push({
            source: srcFileId,
            target: dstFileId,
            kind: 'imports',
            weight: 1.5
          });
        }
      }
    }

    return { nodes, edges };
  }

  public updateOverlay(sessionId: number, filterToChangedOnly: boolean = true) {
    const changes = this.store.getChangesBySession(sessionId);
    const allFiles = this.store.getAllFiles();
    
    console.log(`[Radium] updateOverlay: sessionId=${sessionId}, changes count=${changes.length}`);
    
    // Map file IDs to file paths
    const changedFiles = changes.map(c => {
      const file = allFiles.find(f => f.id === c.file_id);
      const hunksData = JSON.parse(c.hunks_json);
      console.log(`[Radium] Change: fileId=${c.file_id}, file=${file?.path}, hunksPath=${hunksData.filePath}`);
      
      return {
        filePath: hunksData.filePath || file?.path || '',
        fileId: c.file_id,
        summary: c.summary,
        hunks: hunksData
      };
    }).filter(c => c.filePath);

    console.log(`[Radium] Changed file paths:`, changedFiles.map(c => c.filePath));

    // If filtering, rebuild graph with only changed files
    if (filterToChangedOnly && changedFiles.length > 0) {
      this.updateGraphWithChangesOnly(changedFiles.map(c => c.filePath));
    }

    this.panel.webview.postMessage({
      type: 'overlay:session',
      sessionId,
      changes: changedFiles,
      filterToChangedOnly
    });
  }

  private updateGraphWithChangesOnly(changedFilePaths: string[]) {
    const allNodes = this.store.getAllNodes();
    const allEdges = this.store.getAllEdges();
    const allFiles = this.store.getAllFiles();

    console.log(`[Radium] updateGraphWithChangesOnly: ${changedFilePaths.length} changed files`);

    // Filter to only changed files
    const changedFileSet = new Set(changedFilePaths);
    const filteredFiles = allFiles.filter(f => changedFileSet.has(f.path));

    console.log(`[Radium] Filtered files: ${filteredFiles.length}`, filteredFiles.map(f => f.path));

    if (filteredFiles.length === 0) {
      console.warn('[Radium] No files matched! Check path format.');
      return;
    }

    const config = this.configLoader.getConfig();
    
    // If radium-components.yaml exists, show changed files WITH their parent components
    if (config) {
      // Build component-based graph showing only changed files and their components
      const graphData = this.buildComponentBasedGraphForChanges(allNodes, allEdges, filteredFiles, config, changedFileSet);
      
      console.log(`[Radium] Graph built: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);

      this.panel.webview.postMessage({
        type: 'graph:update',
        data: graphData,
        filtered: true
      });
    } else {
      // Without radium-components.yaml, just show the changed files
      const graphData = this.buildChangesGraph(allNodes, allEdges, filteredFiles);

      console.log(`[Radium] Graph built: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);

      this.panel.webview.postMessage({
        type: 'graph:update',
        data: graphData,
        filtered: true
      });
    }
  }

  private buildComponentBasedGraphForChanges(allNodes: any[], allEdges: any[], changedFiles: any[], config: any, changedFileSet: Set<string>) {
    const nodes: any[] = [];
    const edges: any[] = [];
    const nodeMap = new Map<string, number>();
    let nodeId = 1;

    // Hash function to generate consistent colors for component names
    const hashStringToColor = (str: string): string => {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      
      const hue = Math.abs(hash % 360);
      const saturation = 65 + (Math.abs(hash >> 8) % 20);
      const lightness = 50 + (Math.abs(hash >> 16) % 15);
      
      return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    };

    const componentColors = new Map<string, string>();
    
    // Determine which components contain changed files
    const componentsWithChanges = new Set<string>();
    for (const file of changedFiles) {
      const componentInfo = this.configLoader.getComponentForFile(file.path);
      if (componentInfo) {
        componentsWithChanges.add(componentInfo.key);
      }
    }

    // Create component nodes for components with changes
    const componentNodes = new Map<string, number>();
    const externalNodes = new Map<string, number>();
    
    for (const componentKey of componentsWithChanges) {
      const component = config.projectSpec.components[componentKey];
      const componentId = nodeId++;
      const componentColor = hashStringToColor(component.name);
      
      componentNodes.set(componentKey, componentId);
      nodeMap.set(`component:${componentKey}`, componentId);
      componentColors.set(componentKey, componentColor);

      nodes.push({
        id: componentId,
        name: component.name,
        kind: 'component',
        path: componentKey,
        size: changedFiles.filter(f => {
          const info = this.configLoader.getComponentForFile(f.path);
          return info?.key === componentKey;
        }).length,
        description: component.description,
        fullPath: componentKey,
        color: componentColor,
        componentKey: componentKey
      });
      
      // Create external object nodes for this component
      if (component.external && component.external.length > 0) {
        for (const external of component.external) {
          const externalId = nodeId++;
          const externalKey = `${componentKey}:${external.name}`;
          externalNodes.set(externalKey, externalId);
          nodeMap.set(`external:${externalKey}`, externalId);
          
          nodes.push({
            id: externalId,
            name: external.name,
            kind: 'external',
            path: externalKey,
            externalType: external.type,
            description: external.description,
            fullPath: externalKey,
            componentKey: componentKey
          });
          
          // Create edge from component to external object
          edges.push({
            source: componentId,
            target: externalId,
            kind: 'uses',
            weight: 1.0,
            color: componentColor
          });
        }
      }
    }

    // Create file nodes for changed files
    const fileNodes = new Map<string, number>();
    
    for (const file of changedFiles) {
      const fileId = nodeId++;
      fileNodes.set(file.path, fileId);
      nodeMap.set(`file:${file.path}`, fileId);

      const componentInfo = this.configLoader.getComponentForFile(file.path);
      const fileColor = componentInfo ? componentColors.get(componentInfo.key) : undefined;

      const fileName = file.path.split('/').pop() || file.path;
      const fileNode = {
        id: fileId,
        name: fileName,
        kind: 'file',
        path: file.path,
        lang: file.lang,
        size: file.size,
        functions: [] as any[],
        componentColor: fileColor
      };
      nodes.push(fileNode);

      // Connect file to its component
      if (componentInfo) {
        const componentId = componentNodes.get(componentInfo.key);
        if (componentId) {
          edges.push({
            source: componentId,
            target: fileId,
            kind: 'contains',
            weight: 0.5,
            color: fileColor
          });
        }
      }
    }

    // Add file-to-file edges for imports (only between changed files)
    const fileImports = new Map<string, Set<string>>();
    for (const edge of allEdges) {
      if (edge.kind === 'imports') {
        const srcNode = allNodes.find(n => n.id === edge.src);
        const dstNode = allNodes.find(n => n.id === edge.dst);
        if (srcNode && dstNode && srcNode.path !== dstNode.path) {
          // Only include imports between changed files
          if (changedFileSet.has(srcNode.path) && changedFileSet.has(dstNode.path)) {
            if (!fileImports.has(srcNode.path)) {
              fileImports.set(srcNode.path, new Set());
            }
            fileImports.get(srcNode.path)!.add(dstNode.path);
          }
        }
      }
    }

    for (const [srcPath, dstPaths] of fileImports.entries()) {
      const srcFileId = fileNodes.get(srcPath);
      if (!srcFileId) continue;

      const componentInfo = this.configLoader.getComponentForFile(srcPath);
      const edgeColor = componentInfo ? componentColors.get(componentInfo.key) : undefined;

      for (const dstPath of dstPaths) {
        const dstFileId = fileNodes.get(dstPath);
        if (dstFileId) {
          edges.push({
            source: srcFileId,
            target: dstFileId,
            kind: 'imports',
            weight: 1.5,
            color: edgeColor
          });
        }
      }
    }

    return { nodes, edges };
  }

  private buildChangesGraph(allNodes: any[], allEdges: any[], allFiles: any[]) {
    const nodes: any[] = [];
    const edges: any[] = [];
    const nodeMap = new Map<string, number>();
    let nodeId = 1;

    // Group files by directory
    const filesByDir = new Map<string, any[]>();
    for (const file of allFiles) {
      const parts = file.path.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
      if (!filesByDir.has(dir)) {
        filesByDir.set(dir, []);
      }
      filesByDir.get(dir)!.push(file);
    }

    // Create directory nodes
    const dirNodes = new Map<string, number>();
    for (const [dir, files] of filesByDir.entries()) {
      if (files.length === 0) continue;
      
      const dirId = nodeId++;
      dirNodes.set(dir, dirId);
      nodeMap.set(`dir:${dir}`, dirId);

      nodes.push({
        id: dirId,
        name: dir.split('/').pop() || dir,
        kind: 'directory',
        path: dir,
        size: files.length,
        fullPath: dir
      });
    }

    // Create file nodes
    const fileNodes = new Map<string, number>();
    for (const file of allFiles) {
      const fileId = nodeId++;
      fileNodes.set(file.path, fileId);
      nodeMap.set(`file:${file.path}`, fileId);

      const fileName = file.path.split('/').pop() || file.path;
      nodes.push({
        id: fileId,
        name: fileName,
        kind: 'file',
        path: file.path,
        lang: file.lang,
        size: file.size
      });

      // Connect file to directory
      const parts = file.path.split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
      const dirId = dirNodes.get(dir);
      if (dirId) {
        edges.push({
          source: dirId,
          target: fileId,
          kind: 'contains',
          weight: 0.5
        });
      }
    }

    // Group symbols by file - show ALL symbols (classes, functions, interfaces)
    const symbolsByFile = new Map<string, any[]>();
    for (const node of allNodes) {
      // Show classes, interfaces, types, AND functions for changed files
      if (['class', 'interface', 'type', 'function'].includes(node.kind)) {
        if (!symbolsByFile.has(node.path)) {
          symbolsByFile.set(node.path, []);
        }
        symbolsByFile.get(node.path)!.push(node);
      }
    }

    // Create symbol nodes
    for (const [filePath, symbols] of symbolsByFile.entries()) {
      const fileNodeId = fileNodes.get(filePath);
      if (!fileNodeId) continue;

      for (const symbol of symbols) {
        const symbolId = nodeId++;
        nodeMap.set(`symbol:${symbol.id}`, symbolId);

        nodes.push({
          id: symbolId,
          name: symbol.name,
          kind: symbol.kind,
          path: filePath,
          fqname: symbol.fqname,
          originalId: symbol.id
        });

        // Connect symbol to file
        edges.push({
          source: fileNodeId,
          target: symbolId,
          kind: 'defines',
          weight: 0.3
        });
      }
    }

    // Add edges between symbols
    for (const edge of allEdges) {
      const srcKey = `symbol:${edge.src}`;
      const dstKey = `symbol:${edge.dst}`;
      const srcId = nodeMap.get(srcKey);
      const dstId = nodeMap.get(dstKey);

      if (srcId && dstId && edge.kind !== 'defines') {
        edges.push({
          source: srcId,
          target: dstId,
          kind: edge.kind,
          weight: edge.weight
        });
      }
    }

    return { nodes, edges };
  }

  public dispose() {
    MapPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private getHtmlContent(extensionUri: vscode.Uri): string {
    // Generate nonce for inline scripts
    const nonce = this.getNonce();
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://d3js.org; connect-src 'none';">
  <title>Radium Map</title>
  <style>
    body { 
      margin: 0; 
      padding: 0; 
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
    #map { 
      width: 100vw; 
      height: 100vh;
    }
    .controls {
      position: absolute;
      top: 10px;
      right: 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
      border-radius: 4px;
    }
    .control-button {
      display: block;
      margin: 5px 0;
      padding: 5px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }
    .control-button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .legend {
      position: absolute;
      bottom: 10px;
      left: 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
      border-radius: 4px;
      font-size: 12px;
    }
    .legend-item {
      margin: 5px 0;
      display: flex;
      align-items: center;
    }
    .legend-color {
      width: 12px;
      height: 12px;
      margin-right: 8px;
      border-radius: 2px;
    }
    .node {
      cursor: pointer;
      stroke: var(--vscode-editor-foreground);
      stroke-width: 1.5px;
    }
    .node:hover {
      stroke-width: 3px;
    }
    .file-box {
      cursor: pointer;
      stroke: var(--vscode-editor-foreground);
      stroke-width: 2px;
      fill: var(--vscode-editor-background);
      rx: 4;
      ry: 4;
    }
    .file-box:hover {
      stroke-width: 3px;
      fill: var(--vscode-list-hoverBackground);
    }
    .file-title {
      font-size: 12px;
      font-weight: bold;
      fill: var(--vscode-editor-foreground);
      pointer-events: none;
    }
    .function-item {
      font-size: 10px;
      fill: var(--vscode-editor-foreground);
      pointer-events: none;
    }
    .link {
      stroke-opacity: 0.6;
      stroke-width: 1.5px;
    }
    .node-label {
      font-size: 10px;
      pointer-events: none;
      fill: var(--vscode-editor-foreground);
    }
    .directory-label {
      font-size: 14px;
      font-weight: bold;
      fill: var(--vscode-editor-foreground);
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="controls">
    <button class="control-button" id="reset-view-btn">Reset View</button>
    <button class="control-button" id="show-all-btn" style="display: none;">Show All Files</button>
    <button class="control-button" id="structure-btn">Structure</button>
    <button class="control-button" id="relations-btn">Relations</button>
    <button class="control-button" id="changes-btn">Changes</button>
  </div>
  <div class="legend">
    <div class="legend-item">
      <div class="legend-color" style="background: linear-gradient(135deg, #FF6B6B, #4ECDC4, #45B7D1, #96CEB4);"></div>
      <span>Component (color-coded)</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #78909C;"></div>
      <span>File</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #FFFFFF; border: 1px solid #000000;"></div>
      <span>External Object</span>
    </div>
  </div>

  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    
    let graphData = { nodes: [], edges: [] };
    let simulation = null;
    let svg = null;
    let g = null;
    let width = 0;
    let height = 0;
    let zoom = null;
    let activeOverlay = null;
    let changedFilePaths = new Set();
    let isFilteredView = false;
    let fullGraphData = null;

    const colorMap = {
      'component': '#00BCD4',
      'directory': '#607D8B',
      'file': '#78909C',
      'class': '#2196F3',
      'interface': '#FF9800',
      'type': '#9C27B0',
      'function': '#4CAF50',
      'variable': '#F44336',
      'constant': '#E91E63',
      'external': '#FFFFFF'
    };

    const sizeMap = {
      'component': 22,
      'directory': 20,
      'file': 12,
      'class': 10,
      'interface': 10,
      'type': 8,
      'function': 6,
      'external': 16
    };

    function initVisualization() {
      const container = d3.select('#map');
      width = window.innerWidth;
      height = window.innerHeight;
      
      console.log('[Radium Map] Viewport size:', width, 'x', height);

      svg = container.append('svg')
        .attr('width', width)
        .attr('height', height);

      g = svg.append('g');

      zoom = d3.zoom()
        .scaleExtent([0.1, 10])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });

      svg.call(zoom);

      // Initialize the simulation (will be populated with nodes later)
      simulation = d3.forceSimulation()
        .force('link', d3.forceLink().id(d => d.id).distance(d => {
          // Distances based on relationship type
          if (d.kind === 'contains') return 100;
          if (d.kind === 'defines') return 70;
          if (d.kind === 'imports') return 250;
          return 120;
        }).strength(d => {
          // Weak links so clustering dominates
          if (d.kind === 'contains') return 0.2;
          if (d.kind === 'defines') return 0.3;
          return 0.05;
        }))
        .force('charge', d3.forceManyBody().strength(d => {
          if (d.kind === 'component') return -4000; // Stronger repulsion for larger components
          if (d.kind === 'external') return -1500; // Medium repulsion for external objects
          if (d.kind === 'file') return -1200;
          return -800;
        }))
        .force('collision', d3.forceCollide().radius(d => {
          if (d.kind === 'component') return 150; // Larger for bigger component boxes
          if (d.kind === 'external') return 80; // Medium size for external ellipses
          if (d.kind === 'file') return 60;
          return 30;
        }).strength(1.0).iterations(3))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .alphaDecay(0.02);
    }

    function applyClusterLayout(data) {
      // Ensure width/height are set
      if (width === 0 || height === 0) {
        width = window.innerWidth || 1200;
        height = window.innerHeight || 800;
        console.warn('[Radium Map] Width/height were 0, using:', width, 'x', height);
      }

      console.log('[Radium Map] Applying cluster layout with dimensions:', width, 'x', height);

      // Create clusters for components only (no directories)
      const clusterNodes = data.nodes.filter(n => n.kind === 'component');
      const clusterPositions = new Map();

      // Handle case when there are no components
      let cols, rows, cellWidth, cellHeight;
      if (clusterNodes.length === 0) {
        // No components - use simple grid for files
        cols = 1;
        rows = 1;
        cellWidth = width / 2;
        cellHeight = height / 2;
      } else {
        cols = Math.ceil(Math.sqrt(clusterNodes.length));
        rows = Math.ceil(clusterNodes.length / cols);
        cellWidth = width / (cols + 1);
        cellHeight = height / (rows + 1);
      }

      console.log('[Radium Map] Grid layout:', cols, 'cols x', rows, 'rows, cell:', cellWidth, 'x', cellHeight);
      
      clusterNodes.forEach((cluster, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        clusterPositions.set(cluster.id, {
          x: cellWidth * (col + 1),
          y: cellHeight * (row + 1)
        });
      });

      // Assign each file to its parent component position
      // AND initialize random positions near component center
      data.nodes.forEach(node => {
        if (node.kind === 'component') {
          // Initialize component at its position
          if (clusterPositions.has(node.id)) {
            const pos = clusterPositions.get(node.id);
            node.x = pos.x + (Math.random() - 0.5) * 50;
            node.y = pos.y + (Math.random() - 0.5) * 50;
          }
        } else if (node.kind === 'file') {
          // Find parent component
          const parentEdge = data.edges.find(e => e.target === node.id && e.kind === 'contains');
          if (parentEdge) {
            const parentComponent = data.nodes.find(n => n.id === parentEdge.source);
            if (parentComponent && clusterPositions.has(parentComponent.id)) {
              node._clusterPos = clusterPositions.get(parentComponent.id);
              // Initialize near component center with more spread
              node.x = node._clusterPos.x + (Math.random() - 0.5) * 150;
              node.y = node._clusterPos.y + (Math.random() - 0.5) * 150;
            }
          } else {
            // Files without components get random positions
            node.x = Math.random() * width;
            node.y = Math.random() * height;
          }
        }
        
        // Fallback: random position if no cluster assigned
        if (node.x === undefined) {
          node.x = Math.random() * width;
          node.y = Math.random() * height;
        }
      });

      // Debug: Log some initial positions
      const sampleNodes = data.nodes.slice(0, 5);
      console.log('[Radium Map] Sample initial positions:', sampleNodes.map(n => ({
        id: n.id,
        name: n.name,
        kind: n.kind,
        x: n.x,
        y: n.y
      })));

      // Update simulation forces to use component positions
      simulation
        .force('x', d3.forceX(d => {
          if (d.kind === 'component' && clusterPositions.has(d.id)) {
            return clusterPositions.get(d.id).x;
          }
          if (d._clusterPos) {
            return d._clusterPos.x;
          }
          return width / 2;
        }).strength(0.2))
        .force('y', d3.forceY(d => {
          if (d.kind === 'component' && clusterPositions.has(d.id)) {
            return clusterPositions.get(d.id).y;
          }
          if (d._clusterPos) {
            return d._clusterPos.y;
          }
          return height / 2;
        }).strength(0.2));

      return clusterPositions;
    }

    function updateGraph(data, filtered = false) {
      try {
        console.log('[Radium Map] updateGraph called with', data.nodes.length, 'nodes');
        graphData = data;
        
        // Save full graph if not filtered
        if (!filtered) {
          fullGraphData = data;
          isFilteredView = false;
          document.getElementById('show-all-btn').style.display = 'none';
        } else {
          isFilteredView = true;
          document.getElementById('show-all-btn').style.display = 'block';
        }

        // Apply clustering and position initialization
        console.log('[Radium Map] Applying cluster layout...');
        applyClusterLayout(data);

        // Clear existing
        console.log('[Radium Map] Clearing existing graph...');
        g.selectAll('*').remove();

      // Create links - color will be set in tick function after simulation processes nodes
      const links = g.append('g')
        .selectAll('line')
        .data(data.edges)
        .join('line')
        .attr('class', 'link')
        .attr('stroke-width', d => {
          if (d.kind === 'contains') return 18;
          if (d.kind === 'defines') return 1.5;
          return d.weight * 2;
        })
        .attr('stroke-opacity', d => {
          if (d.kind === 'contains') return 0.5;
          if (d.kind === 'defines') return 0.4;
          return 0.7;
        })
        .style('cursor', 'pointer');

      // Only display files, components, and external objects (no directories)
      // Filter out files that are not connected to any component
      const fileIdsConnectedToComponents = new Set(
        data.edges
          .filter(e => e.kind === 'contains')
          .map(e => e.target)
      );
      
      const fileNodes = data.nodes.filter(d => 
        d.kind === 'file' && fileIdsConnectedToComponents.has(d.id)
      );
      const componentNodes = data.nodes.filter(d => d.kind === 'component');
      const externalNodes = data.nodes.filter(d => d.kind === 'external');
      
      console.log('[Radium Map] Node counts - Files:', fileNodes.length, 'Components:', componentNodes.length, 'External:', externalNodes.length);

      // Create file boxes
      const fileGroups = g.append('g')
        .selectAll('g')
        .data(fileNodes)
        .join('g')
        .attr('class', 'file-group')
        .call(drag(simulation));

      // Calculate box dimensions based on content
      fileNodes.forEach(file => {
        const functions = file.functions || [];
        file._functions = functions;
        file._width = Math.max(100, file.name.length * 7 + 20);
        file._height = 30; // Fixed height, no function list
      });

      // Draw file boxes with component-colored borders
      fileGroups.append('rect')
        .attr('class', 'file-box')
        .attr('width', d => d._width)
        .attr('height', d => d._height)
        .attr('x', d => -d._width / 2)
        .attr('y', d => -d._height / 2)
        .attr('stroke', d => d.componentColor || 'var(--vscode-editor-foreground)')
        .attr('stroke-width', d => d.componentColor ? 3 : 2)
        .on('click', (event, d) => {
          console.log('[Radium Map] File box clicked:', d.path);
          vscode.postMessage({
            type: 'file:open',
            filePath: d.path
          });
        });

      // Add file name (centered in box)
      fileGroups.append('text')
        .attr('class', 'file-title')
        .attr('x', 0)
        .attr('y', 4)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11px')
        .text(d => d.name);

      // Create component boxes (twice as large as before)
      componentNodes.forEach(component => {
        component._width = Math.max(300, component.name.length * 20 + 80);
        component._height = 90;
      });

      const componentGroups = g.append('g')
        .selectAll('g')
        .data(componentNodes)
        .join('g')
        .attr('class', 'component-group')
        .call(drag(simulation));

      componentGroups.append('rect')
        .attr('class', 'component-box')
        .attr('width', d => d._width)
        .attr('height', d => d._height)
        .attr('x', d => -d._width / 2)
        .attr('y', d => -d._height / 2)
        .attr('stroke-width', 3)
        .attr('stroke', d => d.color)
        .attr('fill', d => d.color)
        .attr('fill-opacity', 0.85)
        .attr('rx', 8)
        .attr('ry', 8)
        .on('click', (event, d) => {
          vscode.postMessage({
            type: 'node:selected',
            nodeId: d.originalId || d.id
          });
        });

      // Add description as tooltip for component boxes
      componentGroups.append('title')
        .text(d => d.description || d.name);

      componentGroups.append('text')
        .attr('class', 'component-label')
        .attr('x', 0)
        .attr('y', 10)
        .attr('text-anchor', 'middle')
        .attr('font-size', '28px')
        .attr('font-weight', 'bold')
        .attr('fill', '#FFFFFF')
        .attr('text-shadow', '2px 2px 4px rgba(0,0,0,0.5)')
        .text(d => d.name);

      // Create external object rounded rectangles
      externalNodes.forEach(external => {
        external._width = Math.max(120, external.name.length * 8 + 40);
        external._height = 60;
      });

      const externalGroups = g.append('g')
        .selectAll('g')
        .data(externalNodes)
        .join('g')
        .attr('class', 'external-group')
        .call(drag(simulation));

      // Draw white rounded rectangles with black stroke
      externalGroups.append('rect')
        .attr('class', 'external-rect')
        .attr('width', d => d._width)
        .attr('height', d => d._height)
        .attr('x', d => -d._width / 2)
        .attr('y', d => -d._height / 2)
        .attr('rx', 12)
        .attr('ry', 12)
        .attr('fill', '#FFFFFF')
        .attr('stroke', '#000000')
        .attr('stroke-width', 2)
        .style('cursor', 'pointer');

      // Add external object name (black text)
      externalGroups.append('text')
        .attr('class', 'external-label')
        .attr('x', 0)
        .attr('y', -5)
        .attr('text-anchor', 'middle')
        .attr('font-size', '14px')
        .attr('font-weight', 'bold')
        .attr('fill', '#000000')
        .text(d => d.name);

      // Add external object type (smaller, below name)
      externalGroups.append('text')
        .attr('class', 'external-type')
        .attr('x', 0)
        .attr('y', 12)
        .attr('text-anchor', 'middle')
        .attr('font-size', '11px')
        .attr('fill', '#666666')
        .text(d => d.externalType);

      // Add description as tooltip for external objects
      externalGroups.append('title')
        .text(d => d.description || (d.name + ' (' + d.externalType + ')'));

      // Debug logging
      console.log('[Radium Map] Graph data:', {
        nodeCount: data.nodes.length,
        edgeCount: data.edges.length,
        components: data.nodes.filter(n => n.kind === 'component').length,
        directories: data.nodes.filter(n => n.kind === 'directory').length,
        files: data.nodes.filter(n => n.kind === 'file').length,
        external: data.nodes.filter(n => n.kind === 'external').length
      });

      // Update simulation
      simulation.nodes(data.nodes)
        .on('tick', () => {
          try {
            links
              .attr('x1', d => d.source.x)
              .attr('y1', d => d.source.y)
              .attr('x2', d => d.target.x)
              .attr('y2', d => d.target.y)
              .attr('stroke', d => {
                // Color lines based on their source node
                // For 'contains' edges (component → file), use component color
                if (d.kind === 'contains' && d.source.color) {
                  return d.source.color;
                }
                // For 'imports' edges (file → file), use file's component color
                if (d.kind === 'imports' && d.source.componentColor) {
                  return d.source.componentColor;
                }
                // For other edges from components, use component color
                if (d.source.color) {
                  return d.source.color;
                }
                // For other edges from files, use component color
                if (d.source.componentColor) {
                  return d.source.componentColor;
                }
                // Fallback to default colors
                return '#555';
              });

            // Position file boxes
            fileGroups
              .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');

            // Position component boxes
            componentGroups
              .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');

            // Position external object ellipses
            externalGroups
              .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
          } catch (error) {
            console.error('[Radium Map] Error in tick:', error);
          }
        });

      // Connect edges to the simulation
      simulation.force('link').links(data.edges);
      
      // Add hover events after links are connected to simulation (source/target are now objects)
      links
        .on('mouseover', function(event, d) {
          if (d.kind === 'contains') {
            // d.source is now the actual node object with properties
            const componentName = d.source && d.source.name ? d.source.name : 'Component';
            
            // Create tooltip
            d3.select('body').append('div')
              .attr('class', 'edge-tooltip')
              .style('position', 'fixed')
              .style('left', event.clientX + 10 + 'px')
              .style('top', event.clientY + 10 + 'px')
              .style('background', 'var(--vscode-editorHoverWidget-background)')
              .style('color', 'var(--vscode-editorHoverWidget-foreground)')
              .style('border', '1px solid var(--vscode-editorHoverWidget-border)')
              .style('padding', '8px 12px')
              .style('border-radius', '4px')
              .style('font-size', '12px')
              .style('pointer-events', 'none')
              .style('z-index', '1000')
              .style('box-shadow', '0 2px 8px rgba(0,0,0,0.3)')
              .text(componentName);
            
            // Highlight the line
            d3.select(this)
              .attr('stroke-opacity', 0.9)
              .attr('stroke-width', 22);
          }
        })
        .on('mousemove', function(event) {
          d3.select('.edge-tooltip')
            .style('left', event.clientX + 10 + 'px')
            .style('top', event.clientY + 10 + 'px');
        })
        .on('mouseout', function(event, d) {
          // Remove tooltip
          d3.select('.edge-tooltip').remove();
          
          // Reset line appearance
          d3.select(this)
            .attr('stroke-opacity', d.kind === 'contains' ? 0.5 : (d.kind === 'defines' ? 0.4 : 0.7))
            .attr('stroke-width', d => {
              if (d.kind === 'contains') return 18;
              if (d.kind === 'defines') return 1.5;
              return d.weight * 2;
            });
        });
      
      console.log('[Radium Map] Starting simulation with', data.nodes.length, 'nodes and', data.edges.length, 'edges');
      simulation.alpha(1).restart();
      console.log('[Radium Map] updateGraph completed successfully');
      } catch (error) {
        console.error('[Radium Map] Error in updateGraph:', error);
        console.error(error.stack);
      }
    }

    function drag(simulation) {
      function dragstarted(event) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }

      function dragged(event) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      }

      function dragended(event) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      }

      return d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);
    }

    function resetView() {
      svg.transition()
        .duration(750)
        .call(zoom.transform, d3.zoomIdentity);
    }

    function showAllFiles() {
      if (fullGraphData) {
        isFilteredView = false;
        document.getElementById('show-all-btn').style.display = 'none';
        updateGraph(fullGraphData, false);
        clearOverlays();
      }
    }

    function toggleLayer(layer) {
      console.log('[Radium Map] toggleLayer called with:', layer);
      if (layer === 'changes') {
        // Request to show changes
        console.log('[Radium Map] Sending request:recent-changes message');
        vscode.postMessage({
          type: 'request:recent-changes'
        });
        console.log('[Radium Map] Message sent');
      } else {
        vscode.postMessage({
          type: 'overlay:toggle',
          layer,
          enabled: true
        });
      }
    }

    function highlightChangedFiles(changes) {
      changedFilePaths.clear();
      
      // Extract file paths from changes
      changes.forEach(change => {
        changedFilePaths.add(change.filePath);
      });

      // Update node styling to highlight changed files
      g.selectAll('.node')
        .attr('stroke', d => {
          if (d.kind === 'file' && changedFilePaths.has(d.path)) {
            return '#FF5722'; // Orange/red for changed files
          }
          return 'var(--vscode-editor-foreground)';
        })
        .attr('stroke-width', d => {
          if (d.kind === 'file' && changedFilePaths.has(d.path)) {
            return 4;
          }
          if (d.kind === 'directory') return 3;
          if (d.kind === 'file') return 2;
          return 1.5;
        })
        .attr('fill', d => {
          if (d.kind === 'file' && changedFilePaths.has(d.path)) {
            return '#FF5722'; // Highlight changed files
          }
          return colorMap[d.kind] || '#999';
        });

      // Add glow effect to changed files
      g.selectAll('.node')
        .filter(d => d.kind === 'file' && changedFilePaths.has(d.path))
        .attr('filter', 'url(#glow)');
    }

    function clearOverlays() {
      changedFilePaths.clear();
      g.selectAll('.node')
        .attr('stroke', 'var(--vscode-editor-foreground)')
        .attr('stroke-width', d => {
          if (d.kind === 'directory') return 3;
          if (d.kind === 'file') return 2;
          return 1.5;
        })
        .attr('fill', d => colorMap[d.kind] || '#999')
        .attr('filter', null);
    }

    // Listen for messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'graph:update':
          updateGraph(message.data, message.filtered || false);
          break;
        case 'overlay:session':
          activeOverlay = message.sessionId;
          if (!message.filterToChangedOnly) {
            highlightChangedFiles(message.changes);
          }
          break;
        case 'overlay:clear':
          activeOverlay = null;
          clearOverlays();
          if (fullGraphData) {
            updateGraph(fullGraphData, false);
          }
          break;
        case 'path:result':
          // Highlight path
          console.log('Path:', message.path);
          break;
      }
    });

    // Initialize
    initVisualization();
    
    // Notify extension that webview is ready
    vscode.postMessage({ type: 'ready' });

    // Handle resize
    window.addEventListener('resize', () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      svg.attr('width', width).attr('height', height);
      simulation.force('center', d3.forceCenter(width / 2, height / 2));
      simulation.alpha(0.3).restart();
    });

    // Add event listeners for control buttons
    document.getElementById('reset-view-btn')?.addEventListener('click', resetView);
    document.getElementById('show-all-btn')?.addEventListener('click', showAllFiles);
    document.getElementById('structure-btn')?.addEventListener('click', () => toggleLayer('structure'));
    document.getElementById('relations-btn')?.addEventListener('click', () => toggleLayer('relations'));
    document.getElementById('changes-btn')?.addEventListener('click', () => {
      console.log('[Radium Map] Changes button clicked');
      toggleLayer('changes');
    });
  </script>
</body>
</html>`;
  }
}


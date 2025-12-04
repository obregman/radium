import * as vscode from 'vscode';
import { GraphStore, Node, Edge } from '../store/schema';
import { RadiumConfigLoader } from '../config/radium-config';
import { GitDiffTracker } from '../git/git-diff-tracker';
import * as path from 'path';

export class MapPanel {
  public static currentPanel: MapPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private static outputChannel: vscode.OutputChannel;
  private changeCheckTimer?: NodeJS.Timeout;
  private readonly CHANGE_CHECK_INTERVAL = 60000; // 1 minute in milliseconds
  private newFilePaths: Set<string> = new Set(); // Track new files to display in "New Files" component
  private fileWatcher?: vscode.FileSystemWatcher;

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

    // Check for changes when panel becomes visible
    this.panel.onDidChangeViewState(
      e => {
        if (e.webviewPanel.visible) {
          MapPanel.outputChannel.appendLine('Panel became visible, checking for changes');
          this.checkForChanges();
        }
      },
      null,
      this.disposables
    );

    // Note: Initial data will be sent when webview sends 'ready' message
    // See handleMessage case 'ready'
    
    // Start automatic change checking
    this.startChangeChecking();
    
    // File watching will be started when auto-focus is enabled
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
      // Check for changes when panel is revealed
      MapPanel.outputChannel.appendLine('Panel revealed, checking for changes');
      MapPanel.currentPanel.checkForChanges();
      return;
    }
    
    MapPanel.outputChannel.appendLine('Creating new panel');

    const panel = vscode.window.createWebviewPanel(
      'vibeMap',
      'Radium: Codebase Map',
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
      case 'file:preview':
        await this.handleFilePreview(message.filePath);
        break;
      case 'external:focus':
        await this.handleExternalFocus(message.filePaths);
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
      case 'autoFocus:toggle':
        this.handleAutoFocusToggle(message.enabled);
        break;
      case 'ready':
        this.updateGraph();
        break;
      default:
        console.log('[Radium] Unknown message type:', message.type);
    }
  }

  private handleAutoFocusToggle(enabled: boolean) {
    MapPanel.outputChannel.appendLine(`Auto-focus ${enabled ? 'enabled' : 'disabled'}`);
    if (enabled) {
      this.startFileWatching();
    } else {
      this.stopFileWatching();
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
      // Clear any existing highlights
      this.panel.webview.postMessage({
        type: 'overlay:clear'
      });
      return;
    }

    const changes = this.store.getChangesBySession(sessionId);
    MapPanel.outputChannel.appendLine(`Showing ${changes.length} uncommitted changes`);
    
    if (changes.length === 0) {
      vscode.window.showInformationMessage('No changes found in session');
      // Clear any existing highlights
      this.panel.webview.postMessage({
        type: 'overlay:clear'
      });
      return;
    }
    
    // Log details about the changes
    const allFiles = this.store.getAllFiles();
    MapPanel.outputChannel.appendLine(`Total files in index: ${allFiles.length}`);
    MapPanel.outputChannel.appendLine(`Changed files:`);
    changes.forEach(c => {
      const hunks = JSON.parse(c.hunks_json);
      MapPanel.outputChannel.appendLine(`  - ${hunks.filePath || 'unknown'}`);
    });
    
    // Update overlay to show changes (don't filter, show all files with highlights)
    this.updateOverlay(sessionId, false);
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

  private async handleFilePreview(filePath: string) {
    console.log(`[Radium] Previewing file: ${filePath}`);
    try {
      // Resolve relative path to absolute path
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open');
      }
      
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      
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
      
      console.log(`[Radium] Reading file for preview: ${absolutePath}`);
      const uri = vscode.Uri.file(absolutePath);
      const document = await vscode.workspace.openTextDocument(uri);
      
      // Get first 20 lines
      const lineCount = Math.min(20, document.lineCount);
      const lines: string[] = [];
      for (let i = 0; i < lineCount; i++) {
        lines.push(document.lineAt(i).text);
      }
      
      // Send preview content back to webview
      this.panel.webview.postMessage({
        type: 'file:preview-content',
        filePath: filePath,
        content: lines.join('\n'),
        totalLines: document.lineCount
      });
    } catch (error) {
      console.error(`[Radium] Failed to preview file:`, error);
      this.panel.webview.postMessage({
        type: 'file:preview-content',
        filePath: filePath,
        content: null,
        error: 'Failed to read file'
      });
    }
  }

  private async handleExternalFocus(filePaths: string[]) {
    console.log(`[Radium] Focusing external source with files:`, filePaths);
    try {
      if (!filePaths || filePaths.length === 0) {
        console.log('[Radium] No files to focus');
        return;
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open');
      }
      
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      
      // Find the common parent folder of all files
      const absolutePaths = filePaths.map(filePath => {
        if (filePath.startsWith(workspaceRoot)) {
          return filePath;
        } else {
          const relativePath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
          return `${workspaceRoot}/${relativePath}`;
        }
      });

      // Extract directory paths
      const dirPaths = absolutePaths.map(path => {
        const parts = path.split('/');
        return parts.slice(0, -1).join('/');
      });

      // Find common parent directory
      let commonDir = dirPaths[0];
      if (dirPaths.length > 1) {
        const parts = commonDir.split('/');
        for (let i = parts.length; i > 0; i--) {
          const testDir = parts.slice(0, i).join('/');
          if (dirPaths.every(dir => dir.startsWith(testDir))) {
            commonDir = testDir;
            break;
          }
        }
      }

      console.log(`[Radium] Common directory: ${commonDir}`);

      // Reveal the common directory in the explorer
      const uri = vscode.Uri.file(commonDir);
      await vscode.commands.executeCommand('revealInExplorer', uri);
      
      // Also reveal in the file explorer view
      await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
      
      MapPanel.outputChannel.appendLine(`Focused folder: ${commonDir}`);
    } catch (error) {
      console.error(`[Radium] Failed to focus external source:`, error);
      MapPanel.outputChannel.appendLine(`Error focusing folder: ${error}`);
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

    // Predefined palette of 16 distinct colors for components
    // Diverse, distinguishable colors with good contrast
    const componentColorPalette = [
      '#E57373', // Coral Red
      '#64B5F6', // Sky Blue
      '#81C784', // Light Green
      '#FFB74D', // Orange
      '#BA68C8', // Purple
      '#4DB6AC', // Teal
      '#F06292', // Pink
      '#7986CB', // Indigo
      '#AED581', // Lime Green
      '#FFD54F', // Amber
      '#9575CD', // Deep Purple
      '#4DD0E1', // Cyan
      '#FF8A65', // Deep Orange
      '#A1887F', // Brown
      '#90A4AE', // Blue Grey
      '#DCE775'  // Yellow Green
    ];
    
    // Hash function to consistently assign colors from palette
    const hashStringToColor = (str: string): string => {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      
      // Use hash to select from palette
      const index = Math.abs(hash) % componentColorPalette.length;
      return componentColorPalette[index];
    };

    // Map to store component colors
    const componentColors = new Map<string, string>();

    // Group files by component, separating new files
    const filesByComponent = new Map<string, any[]>();
    const unmatchedFiles: any[] = [];
    const newFiles: any[] = [];
    
    // Create a set of all indexed file paths for quick lookup
    const indexedFilePaths = new Set(allFiles.map(f => f.path));
    
    // Add files explicitly listed in component definitions that aren't indexed
    const syntheticFileId = -1000; // Use negative IDs for synthetic files
    let syntheticId = syntheticFileId;
    const syntheticFiles: any[] = [];
    
    for (const componentKey in config.projectSpec.components) {
      const component = config.projectSpec.components[componentKey];
      if (component.files && Array.isArray(component.files)) {
        for (const filePath of component.files) {
          // Normalize the path
          const normalizedPath = filePath.replace(/\\/g, '/');
          
          // Filter out glob patterns and unwanted file types
          if (normalizedPath.endsWith('**') || normalizedPath.endsWith('*')) {
            continue; // Skip glob patterns
          }
          
          // Filter out markdown and text files
          if (normalizedPath.endsWith('.md') || normalizedPath.endsWith('.txt')) {
            continue;
          }
          
          // Filter out image files
          const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp', '.webp', '.ico'];
          if (imageExtensions.some(ext => normalizedPath.toLowerCase().endsWith(ext))) {
            continue;
          }
          
          // If this file isn't already indexed, create a synthetic file record
          if (!indexedFilePaths.has(normalizedPath)) {
            syntheticFiles.push({
              id: syntheticId--,
              path: normalizedPath,
              hash: '',
              indexed_at: Date.now(),
              isSynthetic: true // Mark as synthetic for identification
            });
            indexedFilePaths.add(normalizedPath);
          }
        }
      }
    }
    
    // Merge synthetic files with indexed files
    const allFilesWithSynthetic = [...allFiles, ...syntheticFiles];

    for (const file of allFilesWithSynthetic) {
      // Check if this is a new file
      if (this.newFilePaths.has(file.path)) {
        newFiles.push(file);
        continue; // Don't add to regular components
      }

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

    // Create "New Files" component if there are new files
    if (newFiles.length > 0) {
      filesByComponent.set('__new_files__', newFiles);
    }

    // Ensure all components from config are included, even if they have no files
    for (const componentKey in config.projectSpec.components) {
      if (!filesByComponent.has(componentKey)) {
        filesByComponent.set(componentKey, []);
      }
    }

    // Create component nodes with unique colors
    const componentNodes = new Map<string, number>();
    const externalNodes = new Map<string, number>();
    
    for (const [componentKey, files] of filesByComponent.entries()) {
      
      // Handle special "New Files" component
      if (componentKey === '__new_files__') {
        const componentId = nodeId++;
        const componentColor = '#90EE90'; // Light green for new files
        
        componentNodes.set(componentKey, componentId);
        nodeMap.set(`component:${componentKey}`, componentId);
        componentColors.set(componentKey, componentColor);

        nodes.push({
          id: componentId,
          name: 'New Files',
          kind: 'component',
          path: componentKey,
          size: files.length,
          description: 'Newly added files',
          fullPath: componentKey,
          color: componentColor,
          componentKey: componentKey
        });
        
        console.log(`[Radium] Created "New Files" component node, ID: ${componentId}, ${files.length} files`);
        continue;
      }

      const component = config.projectSpec.components[componentKey];
      
      // Filter out components with no files and no external sources
      const hasFiles = files.length > 0;
      const hasExternal = component.external && component.external.length > 0;
      
      if (!hasFiles && !hasExternal) {
        console.log(`[Radium] Skipping component ${component.name} - no files or external sources`);
        continue;
      }
      
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
            componentKey: componentKey,
            usedBy: external.usedBy || []
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
    
    for (const file of allFilesWithSynthetic) {
      const fileId = nodeId++;
      fileNodes.set(file.path, fileId);
      nodeMap.set(`file:${file.path}`, fileId);

      // Check if this is a new file
      const isNewFile = this.newFilePaths.has(file.path);
      
      // Determine component color for this file
      let componentInfo = this.configLoader.getComponentForFile(file.path);
      let fileColor: string | undefined;
      let componentKey: string | undefined;

      if (isNewFile) {
        // New files belong to "New Files" component
        componentKey = '__new_files__';
        fileColor = componentColors.get('__new_files__');
      } else if (componentInfo) {
        componentKey = componentInfo.key;
        fileColor = componentColors.get(componentInfo.key);
      }

      const fileName = file.path.split('/').pop() || file.path;
      const fileNode = {
        id: fileId,
        name: fileName,
        kind: 'file',
        path: file.path,
        lang: file.lang,
        size: file.size,
        functions: [] as any[],
        componentColor: fileColor,
        componentKey: componentKey
      };
      fileNodeObjects.push(fileNode);
      nodes.push(fileNode);

      // Connect file to component
      if (componentKey) {
        const componentId = componentNodes.get(componentKey);
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

    // Create edges from external objects to files based on explicit configuration
    for (const [componentKey, files] of filesByComponent.entries()) {
      const component = config.projectSpec.components[componentKey];
      if (component && component.external && component.external.length > 0) {
        for (const external of component.external) {
          const externalKey = `${componentKey}:${external.name}`;
          const externalId = externalNodes.get(externalKey);
          
          if (externalId && external.usedBy && external.usedBy.length > 0) {
            // Connect to specific files listed in usedBy
            for (const filePath of external.usedBy) {
              const fileId = fileNodes.get(filePath);
              if (fileId) {
                const fileColor = componentColors.get(componentKey);
                edges.push({
                  source: externalId,
                  target: fileId,
                  kind: 'external-uses',
                  weight: 0.3,
                  color: fileColor
                });
              }
            }
          }
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
    
    // Map file IDs to file paths and identify new files
    const changedFiles = changes.map(c => {
      const file = allFiles.find(f => f.id === c.file_id);
      const hunksData = JSON.parse(c.hunks_json);
      console.log(`[Radium] Change: fileId=${c.file_id}, file=${file?.path}, hunksPath=${hunksData.filePath}`);
      
      return {
        filePath: hunksData.filePath || file?.path || '',
        fileId: c.file_id,
        summary: c.summary,
        hunks: hunksData,
        isNew: c.summary?.startsWith('added:')
      };
    }).filter(c => c.filePath);

    console.log(`[Radium] Changed file paths:`, changedFiles.map(c => c.filePath));

    // Separate new files from modified files
    const newFilePaths = changedFiles.filter(c => c.isNew).map(c => c.filePath);
    const allChangedPaths = changedFiles.map(c => c.filePath);

    // Track new files for display in full graph
    this.newFilePaths = new Set(newFilePaths);
    console.log(`[Radium] Tracking ${this.newFilePaths.size} new files for display`);

    // If filtering, rebuild graph with only changed files
    if (filterToChangedOnly && changedFiles.length > 0) {
      this.updateGraphWithChangesOnly(allChangedPaths, newFilePaths);
    } else if (this.newFilePaths.size > 0) {
      // Rebuild full graph to include "New Files" component
      this.updateGraph();
    }

    this.panel.webview.postMessage({
      type: 'overlay:session',
      sessionId,
      changes: changedFiles,
      filterToChangedOnly
    });
  }

  private updateGraphWithChangesOnly(changedFilePaths: string[], newFilePaths: string[] = []) {
    const allNodes = this.store.getAllNodes();
    const allEdges = this.store.getAllEdges();
    const allFiles = this.store.getAllFiles();

    console.log(`[Radium] updateGraphWithChangesOnly: ${changedFilePaths.length} changed files, ${newFilePaths.length} new files`);

    // Filter to only changed files
    const changedFileSet = new Set(changedFilePaths);
    const newFileSet = new Set(newFilePaths);
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
      const graphData = this.buildComponentBasedGraphForChanges(allNodes, allEdges, filteredFiles, config, changedFileSet, newFileSet);
      
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

  private buildComponentBasedGraphForChanges(allNodes: any[], allEdges: any[], changedFiles: any[], config: any, changedFileSet: Set<string>, newFileSet: Set<string> = new Set()) {
    const nodes: any[] = [];
    const edges: any[] = [];
    const nodeMap = new Map<string, number>();
    let nodeId = 1;

    // Predefined palette of 16 distinct colors for components
    // Diverse, distinguishable colors with good contrast
    const componentColorPalette = [
      '#E57373', // Coral Red
      '#64B5F6', // Sky Blue
      '#81C784', // Light Green
      '#FFB74D', // Orange
      '#BA68C8', // Purple
      '#4DB6AC', // Teal
      '#F06292', // Pink
      '#7986CB', // Indigo
      '#AED581', // Lime Green
      '#FFD54F', // Amber
      '#9575CD', // Deep Purple
      '#4DD0E1', // Cyan
      '#FF8A65', // Deep Orange
      '#A1887F', // Brown
      '#90A4AE', // Blue Grey
      '#DCE775'  // Yellow Green
    ];
    
    // Hash function to consistently assign colors from palette
    const hashStringToColor = (str: string): string => {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
      }
      
      // Use hash to select from palette
      const index = Math.abs(hash) % componentColorPalette.length;
      return componentColorPalette[index];
    };

    const componentColors = new Map<string, string>();
    
    // Separate new files from modified files
    const newFiles = changedFiles.filter(f => newFileSet.has(f.path));
    const modifiedFiles = changedFiles.filter(f => !newFileSet.has(f.path));
    
    // Determine which components contain changed files (excluding new files)
    const componentsWithChanges = new Set<string>();
    for (const file of modifiedFiles) {
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
            componentKey: componentKey,
            usedBy: external.usedBy || []
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

    // Create file nodes for modified files (not new files)
    const fileNodes = new Map<string, number>();
    
    for (const file of modifiedFiles) {
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
        componentColor: fileColor,
        componentKey: componentInfo ? componentInfo.key : undefined
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

    // Create "New Files" component if there are new files
    if (newFiles.length > 0) {
      const newFilesComponentId = nodeId++;
      const newFilesColor = '#90EE90'; // Light green for new files
      
      componentNodes.set('__new_files__', newFilesComponentId);
      nodeMap.set('component:__new_files__', newFilesComponentId);
      componentColors.set('__new_files__', newFilesColor);

      nodes.push({
        id: newFilesComponentId,
        name: 'New Files',
        kind: 'component',
        path: '__new_files__',
        size: newFiles.length,
        description: 'Newly added files',
        fullPath: '__new_files__',
        color: newFilesColor,
        componentKey: '__new_files__'
      });

      // Create file nodes for new files
      for (const file of newFiles) {
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
          functions: [] as any[],
          componentColor: newFilesColor,
          componentKey: '__new_files__'
        };
        nodes.push(fileNode);

        // Connect new file to "New Files" component
        edges.push({
          source: newFilesComponentId,
          target: fileId,
          kind: 'contains',
          weight: 0.5,
          color: newFilesColor
        });
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

  private startChangeChecking() {
    if (!this.gitDiffTracker) {
      MapPanel.outputChannel.appendLine('Change checking disabled: no git diff tracker');
      return;
    }

    MapPanel.outputChannel.appendLine('Starting automatic change checking (every 1 minute)');
    
    // Check immediately on start
    this.checkForChanges();
    
    // Set up periodic checking
    this.changeCheckTimer = setInterval(() => {
      this.checkForChanges();
    }, this.CHANGE_CHECK_INTERVAL);
  }

  private stopChangeChecking() {
    if (this.changeCheckTimer) {
      MapPanel.outputChannel.appendLine('Stopping automatic change checking');
      clearInterval(this.changeCheckTimer);
      this.changeCheckTimer = undefined;
    }
  }

  private startFileWatching() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      MapPanel.outputChannel.appendLine('File watching disabled: no workspace folder');
      return;
    }

    MapPanel.outputChannel.appendLine('Starting file watching for real-time updates');
    
    // Watch for changes in source files
    const pattern = new vscode.RelativePattern(
      workspaceFolders[0],
      '**/*.{ts,tsx,js,jsx,py,go,cs}'
    );
    
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    
    // Handle file changes
    this.fileWatcher.onDidChange(uri => {
      MapPanel.outputChannel.appendLine(`File changed: ${uri.fsPath}`);
      const relativePath = path.relative(workspaceFolders[0].uri.fsPath, uri.fsPath);
      this.checkForChanges(relativePath);
    });
    
    // Handle file creation
    this.fileWatcher.onDidCreate(uri => {
      MapPanel.outputChannel.appendLine(`File created: ${uri.fsPath}`);
      const relativePath = path.relative(workspaceFolders[0].uri.fsPath, uri.fsPath);
      this.newFilePaths.add(relativePath);
      this.checkForChanges();
    });
    
    // Handle file deletion
    this.fileWatcher.onDidDelete(uri => {
      MapPanel.outputChannel.appendLine(`File deleted: ${uri.fsPath}`);
      this.checkForChanges();
    });
    
    this.disposables.push(this.fileWatcher);
  }

  private stopFileWatching() {
    if (this.fileWatcher) {
      MapPanel.outputChannel.appendLine('Stopping file watching');
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
  }

  private getCommentOverlayStyles(): string {
    return `
    .comment-overlay {
      position: fixed;
      background-color: rgba(216, 191, 216, 0.95);
      color: #000000;
      padding: 12px 16px;
      border-radius: 4px;
      font-size: 20px;
      font-weight: 400;
      font-style: italic;
      max-width: 400px;
      text-align: left;
      z-index: 10000;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      pointer-events: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
      line-height: 1.4;
      transition: opacity 0.3s ease;
    }
    .comment-overlay.fading {
      animation: commentFadeOut 0.5s ease-in-out forwards;
    }
    @keyframes commentFadeOut {
      0% { opacity: 1; transform: translateY(0); }
      100% { opacity: 0; transform: translateY(-5px); }
    }
    .file-box-changed {
      animation: orangeBlink 3s ease-in-out;
    }
    @keyframes orangeBlink {
      0%, 100% { stroke: var(--vscode-editor-foreground); stroke-width: 2px; }
      10%, 30%, 50%, 70%, 90% { stroke: #FFA500; stroke-width: 4px; }
      20%, 40%, 60%, 80% { stroke: var(--vscode-editor-foreground); stroke-width: 2px; }
    }
    `;
  }

  private getDisplayCommentsFunction(): string {
    return `
    function displayComments(fileNode, comments) {
      var cleanedComments = comments.map(function(comment) {
        return comment.replace(/^[\\s]*[\\/\\*]+[\\s]*/, '');
      });
      var commentText = cleanedComments.join('\\n');
      
      var overlay = document.createElement('div');
      overlay.className = 'comment-overlay';
      overlay.textContent = commentText;
      
      var charCount = commentText.length;
      var duration = Math.min(8000, Math.max(4000, 4000 + (charCount / 150) * 1000));
      
      var isHovering = false;
      var hideTimeout = null;
      
      overlay.addEventListener('mouseenter', function() {
        isHovering = true;
        if (hideTimeout) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
        overlay.classList.remove('fading');
      });
      
      overlay.addEventListener('mouseleave', function() {
        isHovering = false;
        overlay.classList.add('fading');
        setTimeout(function() {
          overlay.remove();
        }, 500);
      });
      
      var screenX = fileNode.x * transform.k + transform.x;
      var screenY = fileNode.y * transform.k + transform.y;
      
      overlay.style.left = screenX + 'px';
      overlay.style.top = (screenY + 60) + 'px';
      
      document.body.appendChild(overlay);
      
      console.log('[Radium Map] Displaying comments at:', screenX, screenY + 60);
      
      hideTimeout = setTimeout(function() {
        if (!isHovering) {
          overlay.classList.add('fading');
          setTimeout(function() {
            overlay.remove();
          }, 500);
        }
      }, duration);
    }
    `;
  }

  private extractCommentsFromDiff(diff: string, filePath: string): string[] {
    const newComments: string[] = [];
    const oldComments = new Set<string>();
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    
    const lines = diff.split('\n');
    const addedLines = new Map<number, string>();
    const deletedLines = new Map<number, string>();
    let currentLineNumber = 0;
    
    // Parse diff to extract added and deleted lines
    for (const line of lines) {
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          currentLineNumber = parseInt(match[1], 10);
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        addedLines.set(currentLineNumber, line.substring(1));
        currentLineNumber++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletedLines.set(currentLineNumber, line.substring(1));
      } else if (!line.startsWith('\\')) {
        currentLineNumber++;
      }
    }
    
    // Helper function to extract comment text from a line
    const extractCommentText = (trimmed: string): string | null => {
      // JavaScript/TypeScript/C-style comments
      if (['js', 'ts', 'jsx', 'tsx', 'c', 'cpp', 'java', 'cs', 'go', 'rs', 'swift'].includes(ext)) {
        // Single-line comments (handles // and ///)
        if (trimmed.startsWith('//')) {
          // Remove all leading slashes and trim
          const comment = trimmed.replace(/^\/+\s*/, '').trim();
          if (comment.length > 0) return comment;
        }
        // Multi-line comments (handles /* and /**)
        const multiLineMatch = trimmed.match(/\/\*+\s*(.+?)\s*\*\//);
        if (multiLineMatch) {
          // Remove any leading * characters
          const comment = multiLineMatch[1].replace(/^\*+\s*/, '').trim();
          if (comment.length > 0) return comment;
        }
      }
      
      // Python/Ruby/Shell comments
      if (['py', 'rb', 'sh', 'bash'].includes(ext)) {
        if (trimmed.startsWith('#')) {
          // Remove all leading # and trim
          const comment = trimmed.replace(/^#+\s*/, '').trim();
          if (comment.length > 0 && !comment.startsWith('!')) return comment;
        }
      }
      
      // HTML/XML comments
      if (['html', 'xml', 'svg', 'xaml'].includes(ext)) {
        const htmlCommentMatch = trimmed.match(/<!--\s*(.+?)\s*-->/);
        if (htmlCommentMatch) return htmlCommentMatch[1].trim();
      }
      
      return null;
    };
    
    // Collect comments from deleted lines
    for (const [, lineContent] of deletedLines) {
      const comment = extractCommentText(lineContent.trim());
      if (comment) oldComments.add(comment);
    }
    
    // Collect only NEW comments from added lines
    for (const [, lineContent] of addedLines) {
      const comment = extractCommentText(lineContent.trim());
      if (comment && !oldComments.has(comment)) {
        newComments.push(comment);
      }
    }
    
    return newComments;
  }

  private async checkForChanges(specificFilePath?: string) {
    if (!this.gitDiffTracker) {
      return;
    }

    try {
      MapPanel.outputChannel.appendLine('Checking for changed files...');
      
      // Create session from git changes
      const sessionId = await this.gitDiffTracker.createSessionFromGitChanges();
      
      if (!sessionId) {
        MapPanel.outputChannel.appendLine('No changes detected');
        return;
      }

      const changes = this.store.getChangesBySession(sessionId);
      MapPanel.outputChannel.appendLine(`Found ${changes.length} changed files`);
      
      if (changes.length === 0) {
        return;
      }
      
      // Update overlay to show changes
      this.updateOverlay(sessionId, false);
      
      // Send message to webview to focus on changed files (if auto-focus is enabled)
      const allFiles = this.store.getAllFiles();
      const changedFilePaths = changes.map(c => {
        const file = allFiles.find(f => f.id === c.file_id);
        return file?.path;
      }).filter(path => path !== undefined);
      
      // Extract comments from the specific file if provided
      let comments: string[] = [];
      if (specificFilePath && changedFilePaths.includes(specificFilePath)) {
        // Get the diff from git for the specific file
        try {
          const gitChanges = await this.gitDiffTracker.getCurrentBranchChanges();
          const gitChange = gitChanges.find(gc => gc.filePath === specificFilePath);
          if (gitChange?.diff) {
            comments = this.extractCommentsFromDiff(gitChange.diff, specificFilePath);
            MapPanel.outputChannel.appendLine(`Extracted ${comments.length} comments from ${specificFilePath}`);
          }
        } catch (error) {
          MapPanel.outputChannel.appendLine(`Error extracting comments: ${error}`);
        }
      }
      
      if (changedFilePaths.length > 0) {
        this.panel.webview.postMessage({
          type: 'files:changed',
          filePaths: changedFilePaths,
          specificFile: specificFilePath,
          comments: comments.length > 0 ? comments : undefined
        });
      }
    } catch (error) {
      MapPanel.outputChannel.appendLine(`Error checking for changes: ${error}`);
    }
  }

  public dispose() {
    MapPanel.currentPanel = undefined;

    // Stop change checking
    this.stopChangeChecking();
    
    // Stop file watching
    this.stopFileWatching();

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
  <title>Radium: Codebase Map v2</title>
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
    #map svg {
      display: block;
      cursor: grab;
    }
    #map svg:active {
      cursor: grabbing;
    }
    .search-bar {
      position: absolute;
      top: 10px;
      left: 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 8px;
      border-radius: 4px;
      z-index: 1000;
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .search-input {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 13px;
      width: 250px;
      outline: none;
    }
    .search-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .search-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .clear-search-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
    }
    .clear-search-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .search-results {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      white-space: nowrap;
    }
    .controls {
      position: absolute;
      top: 10px;
      right: 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
      border-radius: 4px;
      z-index: 1000;
      pointer-events: auto;
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
      right: 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
      border-radius: 4px;
      font-size: 12px;
      z-index: 1000;
      pointer-events: auto;
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
    .component-container {
      pointer-events: none;
    }
    .new-files-container {
      fill: #3a3a3a !important;
      stroke: #5a5a5a !important;
    }
    .component-label {
      pointer-events: none;
    }
    .file-title {
      pointer-events: none;
    }
    .function-item {
      pointer-events: none;
    }
    .external-label, .external-type, .external-icon {
      pointer-events: none;
    }
    .external-link {
      pointer-events: none;
    }
    .file-diff-tooltip {
      overflow-y: auto !important; /* allow native scrollbars */
      overflow-x: auto !important;
      max-height: 400px; /* ensure we have a fixed viewport height */
      overscroll-behavior: contain; /* keep wheel inside tooltip */
      scrollbar-width: auto !important;
      scrollbar-color: rgba(121, 121, 121, 0.8) rgba(40, 40, 40, 0.5) !important;
    }
    .file-diff-tooltip::-webkit-scrollbar {
      width: 16px !important;
      height: 16px !important;
      background: rgba(40, 40, 40, 0.5) !important;
    }
    .file-diff-tooltip::-webkit-scrollbar-track {
      background: rgba(40, 40, 40, 0.5) !important;
      border-radius: 0 !important;
    }
    .file-diff-tooltip::-webkit-scrollbar-thumb {
      background: rgba(121, 121, 121, 0.8) !important;
      border-radius: 2px !important;
      border: 3px solid rgba(40, 40, 40, 0.5) !important;
      min-height: 50px !important;
    }
    .file-diff-tooltip::-webkit-scrollbar-thumb:hover {
      background: rgba(150, 150, 150, 0.9) !important;
    }
    .file-diff-tooltip::-webkit-scrollbar-thumb:active {
      background: rgba(170, 170, 170, 1) !important;
    }
    .file-diff-tooltip::-webkit-scrollbar-corner {
      background: rgba(40, 40, 40, 0.5) !important;
    }
    .file-diff-tooltip::-webkit-scrollbar-button {
      display: block !important;
      height: 16px !important;
      background: rgba(60, 60, 60, 0.7) !important;
    }
    #auto-focus-toggle {
      position: fixed;
      bottom: 20px;
      left: 20px;
      padding: 8px 12px;
      background-color: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 12px;
      font-weight: 400;
      cursor: pointer;
      z-index: 1000;
      transition: all 0.15s ease;
      opacity: 0.6;
      display: flex;
      align-items: center;
      gap: 6px;
      pointer-events: auto;
    }
    #auto-focus-toggle:hover {
      opacity: 1;
      border-color: var(--vscode-focusBorder);
    }
    #auto-focus-toggle.active {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
      opacity: 1;
    }
    ${this.getCommentOverlayStyles()}
    .toggle-checkbox {
      width: 12px;
      height: 12px;
      border: 1px solid currentColor;
      border-radius: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="search-bar">
    <input type="text" class="search-input" id="search-input" placeholder="Search components, files, external sources...">
    <button class="clear-search-btn" id="clear-search-btn">Clear</button>
    <span class="search-results" id="search-results"></span>
  </div>
  <div class="controls">
    <button class="control-button" id="reset-view-btn">Reset View</button>
    <button class="control-button" id="show-all-btn" style="display: none;">Show All Files</button>
    <button class="control-button" id="changes-btn">Changes</button>
  </div>
  <button id="auto-focus-toggle" title="Auto-focus on changes">
    <span class="toggle-checkbox"></span>
    <span>Auto-focus on changes</span>
  </button>

  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script nonce="${nonce}">
    // Version: 2024-11-10-v3
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
    let currentZoomLevel = 1;
    let searchQuery = '';
    let filteredNodeIds = new Set();
    const ZOOM_THRESHOLD = 0.3; // Below this zoom level, show only components
    let autoFocusEnabled = false; // Auto-focus disabled by default
    let transform = { k: 1, x: 0, y: 0 }; // Pan/zoom transform state
    let lastFocusedFilePath = null; // Track the last file that was auto-focused

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

    function getExternalIcon(type) {
      if (!type) return '📦';
      
      const typeLower = type.toLowerCase();
      
      // Database types
      if (typeLower.includes('sql') || typeLower.includes('database') || typeLower.includes('db')) {
        return '🗄️';
      }
      
      // API types
      if (typeLower.includes('api') || typeLower.includes('rest') || typeLower.includes('graphql')) {
        return '🌐';
      }
      
      // File types
      if (typeLower.includes('file') || typeLower.includes('storage') || typeLower.includes('filesystem')) {
        return '📁';
      }
      
      // Cache types
      if (typeLower.includes('cache') || typeLower.includes('redis') || typeLower.includes('memcache')) {
        return '⚡';
      }
      
      // Queue/Message types
      if (typeLower.includes('queue') || typeLower.includes('message') || typeLower.includes('kafka') || typeLower.includes('rabbitmq')) {
        return '📬';
      }
      
      // Service types
      if (typeLower.includes('service') || typeLower.includes('microservice')) {
        return '⚙️';
      }
      
      // Cloud/External service
      if (typeLower.includes('cloud') || typeLower.includes('aws') || typeLower.includes('azure') || typeLower.includes('gcp')) {
        return '☁️';
      }
      
      // Authentication
      if (typeLower.includes('auth') || typeLower.includes('oauth') || typeLower.includes('identity')) {
        return '🔐';
      }
      
      // Default
      return '📦';
    }

    function initVisualization() {
      const container = d3.select('#map');
      width = window.innerWidth;
      height = window.innerHeight;
      
      console.log('[Radium Map] Viewport size:', width, 'x', height);

      svg = container.append('svg')
        .attr('width', width)
        .attr('height', height)
        .style('touch-action', 'none'); // Enable touch/pointer events for panning

      g = svg.append('g');
      
      // Add a large background rect INSIDE g to capture pan events everywhere
      g.append('rect')
        .attr('class', 'zoom-background')
        .attr('width', 100000)
        .attr('height', 100000)
        .attr('x', -50000)
        .attr('y', -50000)
        .attr('fill', 'transparent')
        .lower(); // Ensure it's behind everything

      // Manual pan/zoom implementation (more reliable in VS Code webviews)
      // transform is now at top-level scope for access by focusOnChangedFiles
      let isPanning = false;
      let startPoint = { x: 0, y: 0 };
      
      function updateTransform() {
        g.attr('transform', 'translate(' + transform.x + ',' + transform.y + ') scale(' + transform.k + ')');
        currentZoomLevel = transform.k;
        updateVisibilityByZoom();
      }
      
      // Mouse wheel zoom
      svg.on('wheel', (event) => {
        event.preventDefault();
        console.log('[Radium Map] Wheel event detected');
        
        const delta = -event.deltaY;
        // Reduced zoom speed for smoother experience, especially on Mac trackpads
        // When Shift is held, zoom three times as fast
        const baseScaleBy = delta > 0 ? 1.03 : 0.97;
        const scaleBy = event.shiftKey ? (delta > 0 ? 1.09 : 0.91) : baseScaleBy;
        const newScale = Math.max(0.1, Math.min(10, transform.k * scaleBy));
        
        // Zoom towards mouse position
        const rect = svg.node().getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        
        const factor = newScale / transform.k;
        transform.x = mouseX - (mouseX - transform.x) * factor;
        transform.y = mouseY - (mouseY - transform.y) * factor;
        transform.k = newScale;
        
        updateTransform();
      });
      
      // Mouse pan
      svg.on('mousedown', (event) => {
        if (event.button !== 0) return; // Only left click
        console.log('[Radium Map] Mouse down - starting pan');
        isPanning = true;
        startPoint = { x: event.clientX - transform.x, y: event.clientY - transform.y };
        svg.style('cursor', 'grabbing');
      });
      
      svg.on('mousemove', (event) => {
        if (!isPanning) return;
        transform.x = event.clientX - startPoint.x;
        transform.y = event.clientY - startPoint.y;
        updateTransform();
      });
      
      svg.on('mouseup', () => {
        if (isPanning) {
          console.log('[Radium Map] Mouse up - ending pan');
          isPanning = false;
          svg.style('cursor', 'grab');
        }
      });
      
      svg.on('mouseleave', () => {
        if (isPanning) {
          isPanning = false;
          svg.style('cursor', 'grab');
        }
      });
      
      // Store zoom object for reset functionality
      zoom = {
        transform: () => ({ k: transform.k, x: transform.x, y: transform.y }),
        scaleTo: (selection, k) => {
          transform.k = k;
          updateTransform();
        },
        translateTo: (selection, x, y) => {
          transform.x = x;
          transform.y = y;
          updateTransform();
        }
      };
      
      console.log('[Radium Map] Manual pan/zoom initialized');

      // Initialize the simulation (will be populated with nodes later)
      simulation = d3.forceSimulation()
        .force('link', d3.forceLink().id(d => d.id).distance(d => {
          // Distances based on relationship type
          if (d.kind === 'contains') return 100;
          if (d.kind === 'defines') return 70;
          if (d.kind === 'external-uses') return 80;
          if (d.kind === 'imports') return 250;
          return 120;
        }).strength(d => {
          // Weak links so clustering dominates
          if (d.kind === 'contains') return 0.2;
          if (d.kind === 'defines') return 0.3;
          if (d.kind === 'external-uses') return 0.15;
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

    function applyStaticLayout(data) {
      // Ensure width/height are set
      if (width === 0 || height === 0) {
        width = window.innerWidth || 1200;
        height = window.innerHeight || 800;
        console.warn('[Radium Map] Width/height were 0, using:', width, 'x', height);
      }

      console.log('[Radium Map] Applying static layout with dimensions:', width, 'x', height);

      // Get all components
      const componentNodes = data.nodes.filter(n => n.kind === 'component');
      
      if (componentNodes.length === 0) {
        console.log('[Radium Map] No components found');
        return;
      }

      // Define spacing based on design
      const headerHeight = 50;
      const contentPadding = 15;
      const fileBoxHeight = 30;
      const externalBoxWidth = 140;
      const externalBoxHeight = 50;
      const fileSpacingX = 10;
      const fileSpacingY = 10;
      const externalSpacingY = 65;
      const filesStartX = contentPadding;
      const filesStartY = headerHeight + contentPadding;
      const minComponentWidth = 300;
      const minComponentHeight = 200;
      
      // First pass: Calculate size for each component based on its children
      componentNodes.forEach((component) => {
        // Get all files and external objects for this component
        const children = data.edges
          .filter(e => e.source === component.id && (e.kind === 'contains' || e.kind === 'uses'))
          .map(e => ({
            node: data.nodes.find(n => n.id === e.target),
            kind: e.kind
          }))
          .filter(c => c.node);
        
        const files = children.filter(c => c.node.kind === 'file').map(c => c.node);
        const externals = children.filter(c => c.node.kind === 'external').map(c => c.node);
        
        console.log('[Radium Map] Component ' + component.name + ': ' + files.length + ' files, ' + externals.length + ' externals');
        
        // Calculate file box widths based on filename length
        files.forEach(file => {
          const charWidth = 7; // Approximate character width
          const padding = 20;
          file._width = Math.max(80, file.name.length * charWidth + padding);
          file._height = fileBoxHeight;
        });
        
        // Calculate how many columns of files we need (max 4 columns)
        const maxFileCols = 4;
        const fileCols = Math.min(maxFileCols, Math.max(2, Math.ceil(Math.sqrt(files.length))));
        const fileRows = Math.ceil(files.length / fileCols);
        
        // Calculate max file width in each column
        const fileColWidths = [];
        for (let col = 0; col < fileCols; col++) {
          let maxWidth = 80;
          for (let row = 0; row < fileRows; row++) {
            const idx = row * fileCols + col;
            if (idx < files.length) {
              maxWidth = Math.max(maxWidth, files[idx]._width);
            }
          }
          fileColWidths.push(maxWidth);
        }
        
        // Calculate files area width and height
        const filesAreaWidth = fileColWidths.reduce((sum, w) => sum + w, 0) + (fileCols - 1) * fileSpacingX;
        const filesAreaHeight = fileRows * (fileBoxHeight + fileSpacingY);
        
        // Store file column widths for positioning later
        component._fileColWidths = fileColWidths;
        
        // Calculate externals area height
        const externalsAreaHeight = externals.length * externalBoxHeight + (externals.length - 1) * (externalSpacingY - externalBoxHeight);
        
        // Component width: files area + spacing + externals area + padding
        const componentBoxWidth = Math.max(
          minComponentWidth,
          filesAreaWidth + 20 + externalBoxWidth + contentPadding * 2
        );
        
        // Component height: max of files height and externals height + header + padding
        const componentBoxHeight = Math.max(
          minComponentHeight,
          headerHeight + Math.max(filesAreaHeight, externalsAreaHeight) + contentPadding * 2
        );
        
        // Store calculated dimensions
        component._boxWidth = componentBoxWidth;
        component._boxHeight = componentBoxHeight;
        component._fileCols = fileCols;
        component._files = files;
        component._externals = externals;
      });
      
      // Brick-packing layout algorithm
      // Separate "New Files" component from regular components
      const newFilesComponent = componentNodes.find(c => c.componentKey === '__new_files__');
      const regularComponents = componentNodes.filter(c => c.componentKey !== '__new_files__');
      
      // Sort regular components by width first (wider first), then by area for better horizontal packing
      const sortedComponents = [...regularComponents].sort((a, b) => {
        // Prioritize width over height
        const widthDiff = b._boxWidth - a._boxWidth;
        if (Math.abs(widthDiff) > 50) {
          return widthDiff;
        }
        // If widths are similar, sort by area
        return (b._boxWidth * b._boxHeight) - (a._boxWidth * a._boxHeight);
      });
      
      const componentGapX = 60; // Horizontal gap
      const componentGapY = 60; // Vertical gap
      const startX = 40;
      const startY = 40;
      
      console.log('[Radium Map] Applying brick-packing layout for', sortedComponents.length, 'components');
      
      // Track occupied spaces as rectangles
      const occupiedSpaces = [];
      
      // Helper function to check if a position overlaps with any occupied space
      const isOverlapping = (x, y, width, height) => {
        for (const space of occupiedSpaces) {
          if (!(x + width + componentGapX <= space.x || 
                x >= space.x + space.width + componentGapX ||
                y + height + componentGapY <= space.y || 
                y >= space.y + space.height + componentGapY)) {
            return true;
          }
        }
        return false;
      };
      
      // Helper function to calculate layout bounds
      const getLayoutBounds = () => {
        if (occupiedSpaces.length === 0) {
          return { maxX: startX, maxY: startY };
        }
        let maxX = startX;
        let maxY = startY;
        for (const space of occupiedSpaces) {
          maxX = Math.max(maxX, space.x + space.width);
          maxY = Math.max(maxY, space.y + space.height);
        }
        return { maxX, maxY };
      };
      
      // Helper function to find the best position for a component
      const findBestPosition = (width, height) => {
        let bestX = startX;
        let bestY = startY;
        let bestScore = Infinity;
        
        // Try positions in a grid pattern
        const maxSearchWidth = 2500;
        const maxSearchHeight = 3000;
        const searchStep = 20;
        
        for (let y = startY; y < maxSearchHeight; y += searchStep) {
          for (let x = startX; x < maxSearchWidth; x += searchStep) {
            if (!isOverlapping(x, y, width, height)) {
              // Calculate what the layout bounds would be with this placement
              const bounds = getLayoutBounds();
              const newMaxX = Math.max(bounds.maxX, x + width);
              const newMaxY = Math.max(bounds.maxY, y + height);
              
              // Calculate aspect ratio (prefer wider layouts)
              const layoutWidth = newMaxX - startX;
              const layoutHeight = newMaxY - startY;
              const aspectRatio = layoutHeight / Math.max(layoutWidth, 1);
              
              // Score based on:
              // 1. Prefer positions that keep layout wide (low aspect ratio)
              // 2. Prefer top-left positions
              // 3. Heavily penalize tall/narrow layouts
              const aspectPenalty = aspectRatio > 1 ? aspectRatio * 1000 : aspectRatio * 200;
              const positionScore = y * 2 + x * 0.5;
              const score = aspectPenalty + positionScore;
              
              if (score < bestScore) {
                bestScore = score;
                bestX = x;
                bestY = y;
              }
              
              // Early exit if we found a good wide position
              if (aspectRatio < 0.7 && y < startY + 200 && x < startX + 300) {
                return { x: bestX, y: bestY };
              }
            }
          }
        }
        
        return { x: bestX, y: bestY };
      };
      
      // Place each component using brick-packing
      sortedComponents.forEach((component, index) => {
        const width = component._boxWidth;
        const height = component._boxHeight;
        
        let position;
        if (index === 0) {
          // First component at start position
          position = { x: startX, y: startY };
        } else {
          // Find best position for this component
          position = findBestPosition(width, height);
        }
        
        const boxX = position.x;
        const boxY = position.y;
        
        // Store box position
        component._boxX = boxX;
        component._boxY = boxY;
        
        // Mark this space as occupied
        occupiedSpaces.push({
          x: boxX,
          y: boxY,
          width: width,
          height: height
        });
        
        // Position component header at the top of the box
        component.x = boxX + component._boxWidth / 2;
        component.y = boxY + headerHeight / 2;
        component.fx = component.x;
        component.fy = component.y;
        
        const files = component._files;
        const externals = component._externals;
        const fileCols = component._fileCols;
        const fileColWidths = component._fileColWidths;
        
        // Calculate externals start position (right side)
        const externalsStartX = component._boxWidth - externalBoxWidth - contentPadding;
        
        // Position files in grid on the left side inside the box
        files.forEach((file, idx) => {
          const fileCol = idx % fileCols;
          const fileRow = Math.floor(idx / fileCols);
          
          // Calculate X position based on column widths
          let fileX = boxX + filesStartX;
          for (let c = 0; c < fileCol; c++) {
            fileX += fileColWidths[c] + fileSpacingX;
          }
          
          // Position at center of file box
          file.x = fileX + file._width / 2;
          file.y = boxY + filesStartY + fileRow * (fileBoxHeight + fileSpacingY) + fileBoxHeight / 2;
          file.fx = file.x;
          file.fy = file.y;
        });
        
        // Position external objects on the right side inside the box
        externals.forEach((external, idx) => {
          // Position at center of external box
          external.x = boxX + externalsStartX + externalBoxWidth / 2;
          external.y = boxY + filesStartY + idx * externalSpacingY + externalBoxHeight / 2;
          external.fx = external.x;
          external.fy = external.y;
          external._width = externalBoxWidth;
          external._height = externalBoxHeight;
        });
      });

      // Place "New Files" component at the bottom if it exists
      if (newFilesComponent) {
        const bounds = getLayoutBounds();
        const newFilesBoxX = startX;
        const newFilesBoxY = bounds.maxY + componentGapY;
        
        // Store box position
        newFilesComponent._boxX = newFilesBoxX;
        newFilesComponent._boxY = newFilesBoxY;
        
        // Position component header at the top of the box
        newFilesComponent.x = newFilesBoxX + newFilesComponent._boxWidth / 2;
        newFilesComponent.y = newFilesBoxY + headerHeight / 2;
        newFilesComponent.fx = newFilesComponent.x;
        newFilesComponent.fy = newFilesComponent.y;
        
        const files = newFilesComponent._files;
        const externals = newFilesComponent._externals;
        const fileCols = newFilesComponent._fileCols;
        const fileColWidths = newFilesComponent._fileColWidths;
        
        // Calculate externals start position (right side)
        const externalsStartX = newFilesComponent._boxWidth - externalBoxWidth - contentPadding;
        
        // Position files in grid on the left side inside the box
        files.forEach((file, idx) => {
          const fileCol = idx % fileCols;
          const fileRow = Math.floor(idx / fileCols);
          
          // Calculate X position based on column widths
          let fileX = newFilesBoxX + filesStartX;
          for (let c = 0; c < fileCol; c++) {
            fileX += fileColWidths[c] + fileSpacingX;
          }
          
          // Position at center of file box
          file.x = fileX + file._width / 2;
          file.y = newFilesBoxY + filesStartY + fileRow * (fileBoxHeight + fileSpacingY) + fileBoxHeight / 2;
          file.fx = file.x;
          file.fy = file.y;
        });
        
        // Position external objects on the right side inside the box
        externals.forEach((external, idx) => {
          // Position at center of external box
          external.x = newFilesBoxX + externalsStartX + externalBoxWidth / 2;
          external.y = newFilesBoxY + filesStartY + idx * externalSpacingY + externalBoxHeight / 2;
          external.fx = external.x;
          external.fy = external.y;
          external._width = externalBoxWidth;
          external._height = externalBoxHeight;
        });
      }

      // Ensure all nodes have positions
      data.nodes.forEach(node => {
        if (node.x === undefined || node.y === undefined) {
          node.x = width / 2;
          node.y = height / 2;
          node.fx = node.x;
          node.fy = node.y;
        }
      });

      console.log('[Radium Map] Static layout applied');
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

        // Apply static layout
        console.log('[Radium Map] Applying static layout...');
        applyStaticLayout(data);

        // Clear existing
        console.log('[Radium Map] Clearing existing graph...');
        g.selectAll('*').remove();

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

      // Build visible node id set and filter edges accordingly to avoid stray lines
      const visibleIds = new Set([
        ...fileNodes.map(n => n.id),
        ...componentNodes.map(n => n.id),
        ...externalNodes.map(n => n.id)
      ]);

      const getId = (v) => (typeof v === 'object' && v !== null ? v.id : v);
      const filteredEdges = data.edges.filter(e => visibleIds.has(getId(e.source)) && visibleIds.has(getId(e.target)));

      // Function to check if a point is inside a box
      const isPointInBox = (px, py, box) => {
        const margin = 5; // Add small margin around boxes
        return px >= box.x - box.width / 2 - margin &&
               px <= box.x + box.width / 2 + margin &&
               py >= box.y - box.height / 2 - margin &&
               py <= box.y + box.height / 2 + margin;
      };

      // Function to create elbow connector path that avoids overlapping boxes
      const createElbowPath = (sourceNode, targetNode, allNodes) => {
        const x1 = sourceNode.x - (sourceNode._width || 140) / 2; // Left edge of external box
        const y1 = sourceNode.y;
        const x2 = targetNode.x + (targetNode._width || 100) / 2; // Right edge of file box
        const y2 = targetNode.y;
        
        // Collect all boxes that could be obstacles (except source and target)
        const obstacles = allNodes
          .filter(n => n.id !== sourceNode.id && n.id !== targetNode.id)
          .filter(n => n.kind === 'file' || n.kind === 'external')
          .map(n => ({
            x: n.x,
            y: n.y,
            width: n._width || (n.kind === 'external' ? 140 : 100),
            height: n._height || (n.kind === 'external' ? 50 : 30)
          }));
        
        // Try different routing strategies
        // Strategy 1: Simple midpoint (original)
        let midX = (x1 + x2) / 2;
        let path = 'M ' + x1 + ' ' + y1 + ' L ' + midX + ' ' + y1 + ' L ' + midX + ' ' + y2 + ' L ' + x2 + ' ' + y2;
        
        // Check if the vertical segment intersects any obstacles
        let hasCollision = false;
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        
        for (const box of obstacles) {
          // Check if vertical line at midX intersects this box
          if (midX >= box.x - box.width / 2 - 5 && 
              midX <= box.x + box.width / 2 + 5) {
            // Check if box is in the Y range of our vertical segment
            if ((box.y - box.height / 2 <= maxY && box.y + box.height / 2 >= minY)) {
              hasCollision = true;
              break;
            }
          }
        }
        
        // If collision detected, try routing around obstacles
        if (hasCollision) {
          // Strategy 2: Route above or below obstacles
          // Find the topmost and bottommost obstacles in our path
          let topY = y1;
          let bottomY = y1;
          
          for (const box of obstacles) {
            if (midX >= box.x - box.width / 2 - 5 && 
                midX <= box.x + box.width / 2 + 5) {
              topY = Math.min(topY, box.y - box.height / 2 - 10);
              bottomY = Math.max(bottomY, box.y + box.height / 2 + 10);
            }
          }
          
          // Choose to route above or below based on which is closer
          const routeAbove = Math.abs(topY - y1) < Math.abs(bottomY - y1);
          const routeY = routeAbove ? topY : bottomY;
          
          // Create path that goes horizontal, then vertical to route point, then horizontal to target X, then vertical to target
          path = 'M ' + x1 + ' ' + y1 + 
                 ' L ' + midX + ' ' + y1 + 
                 ' L ' + midX + ' ' + routeY + 
                 ' L ' + midX + ' ' + y2 + 
                 ' L ' + x2 + ' ' + y2;
        }
        
        return path;
      };

      // Store external edges for later rendering (after component boxes but before file/external boxes)
      const externalUsesEdges = filteredEdges.filter(e => e.kind === 'external-uses');

      // FIRST: Draw all component container boxes (background layer)
      // Draw directly to main g element, not in groups
      g.selectAll('.component-container')
        .data(componentNodes)
        .join('rect')
        .attr('class', d => d.componentKey === '__new_files__' ? 'component-container new-files-container' : 'component-container')
        .attr('x', d => d._boxX)
        .attr('y', d => d._boxY)
        .attr('width', d => d._boxWidth)
        .attr('height', d => d._boxHeight)
        .attr('fill', d => d.componentKey === '__new_files__' ? '#3a3a3a' : 'var(--vscode-editor-background)')
        .attr('stroke', d => d.componentKey === '__new_files__' ? '#5a5a5a' : d.color)
        .attr('stroke-width', 3)
        .attr('rx', 8)
        .attr('ry', 8);

      // Draw the header bars for each component
      const componentHeaders = g.selectAll('.component-header')
        .data(componentNodes)
        .join('rect')
        .attr('class', d => d.componentKey === '__new_files__' ? 'component-header new-files-header' : 'component-header')
        .attr('x', d => d._boxX)
        .attr('y', d => d._boxY)
        .attr('width', d => d._boxWidth)
        .attr('height', 50)
        .attr('fill', d => d.componentKey === '__new_files__' ? '#5a5a5a' : d.color)
        .attr('fill-opacity', 0.9)
        .attr('rx', 8)
        .attr('ry', 8)
        .on('click', (event, d) => {
          // Only handle click if it wasn't a drag
          if (event.defaultPrevented) return;
          event.stopPropagation();
          
          // Auto-focus on the clicked component
          if (autoFocusEnabled && d._boxX !== undefined && d._boxY !== undefined) {
            const centerX = d._boxX + d._boxWidth / 2;
            const centerY = d._boxY + d._boxHeight / 2;
            
            // Calculate the transform needed to center this component
            const targetX = width / 2 - centerX * transform.k;
            const targetY = height / 2 - centerY * transform.k;
            
            // Smoothly transition to the new position
            svg.transition()
              .duration(750)
              .call(zoom.transform, d3.zoomIdentity.translate(targetX, targetY).scale(transform.k));
          }
          
          vscode.postMessage({
            type: 'node:selected',
            nodeId: d.originalId || d.id
          });
        })
        .style('cursor', 'pointer');
      
      // Add tooltip to component headers
      componentHeaders.append('title')
        .text(d => d.description || d.name);

      // Add component name text in headers
      g.selectAll('.component-label')
        .data(componentNodes)
        .join('text')
        .attr('class', 'component-label')
        .attr('x', d => d._boxX + d._boxWidth / 2)
        .attr('y', d => d._boxY + 33)
        .attr('text-anchor', 'middle')
        .attr('font-size', '18px')
        .attr('font-weight', 'bold')
        .attr('fill', '#FFFFFF')
        .text(d => d.name)
        .append('title')
        .text(d => d.description || d.name);

      // Note: External source connections are not visually rendered to avoid clutter
      // The relationship data is maintained in the graph model but not displayed
      // This keeps the component boxes clean and focused on the file structure

      // SECOND: Create file boxes (inside component containers)
      const fileGroups = g.append('g')
        .selectAll('g')
        .data(fileNodes)
        .join('g')
        .attr('class', 'file-group');
      // No dragging for files

      // Draw file boxes with fixed size and component-colored borders
      let tooltipTimeout = null;
      fileGroups.append('rect')
        .attr('class', 'file-box')
        .attr('width', d => d._width || 100)
        .attr('height', d => d._height || 30)
        .attr('x', d => -(d._width || 100) / 2)
        .attr('y', d => -(d._height || 30) / 2)
        .attr('fill', 'var(--vscode-editor-background)')
        .attr('stroke', d => d.componentColor || 'var(--vscode-editor-foreground)')
        .attr('stroke-width', 2)
        .attr('rx', 3)
        .attr('ry', 3)
        .on('click', (event, d) => {
          // Only handle click if it wasn't a drag
          if (event.defaultPrevented) return;
          event.stopPropagation();
          console.log('[Radium Map] File box clicked:', d.path);
          
          // Auto-focus on the clicked file
          if (autoFocusEnabled && d.x !== undefined && d.y !== undefined) {
            // Calculate the transform needed to center this file
            const targetX = width / 2 - d.x * transform.k;
            const targetY = height / 2 - d.y * transform.k;
            
            // Smoothly transition to the new position
            svg.transition()
              .duration(750)
              .call(zoom.transform, d3.zoomIdentity.translate(targetX, targetY).scale(transform.k));
          }
          
          vscode.postMessage({
            type: 'file:open',
            filePath: d.path
          });
        })
        .on('mouseover', function(event, d) {
          // Clear any existing timeout
          if (tooltipTimeout) {
            clearTimeout(tooltipTimeout);
          }
          
          // Set a timeout to show tooltip after 0.5 seconds
          tooltipTimeout = setTimeout(() => {
          // Show diff tooltip if file has changes, otherwise show file preview
          if (d._changeInfo) {
            const tooltip = d3.select('body').append('div')
              .attr('class', 'file-diff-tooltip')
              .style('position', 'fixed')
              .style('left', event.clientX + 10 + 'px')
              .style('top', event.clientY + 10 + 'px')
              .style('background', 'var(--vscode-editorHoverWidget-background)')
              .style('color', 'var(--vscode-editorHoverWidget-foreground)')
              .style('border', '1px solid var(--vscode-editorHoverWidget-border)')
              .style('padding', '10px')
              .style('border-radius', '4px')
              .style('font-family', 'monospace')
              .style('font-size', '12px')
              .style('width', '600px')
              .style('max-height', '400px')
              .style('overflow-y', 'auto')
              .style('overflow-x', 'auto')
              .style('pointer-events', 'auto')
              .style('z-index', '10000')
              .style('box-shadow', '0 2px 8px rgba(0,0,0,0.3)');
            
            // Format diff with colored backgrounds
            let diffHtml = '<div style="font-weight: bold; margin-bottom: 8px;">📝 ' + d.path + '</div>';
            
            // Check if we have actual diff content
            const hunks = d._changeInfo.hunks;
            let diffText = '';
            
            if (hunks && hunks.diff) {
              // We have the actual git diff
              diffText = hunks.diff;
            } else if (hunks && hunks.hunks && hunks.hunks.length > 0) {
              // We have detailed hunks
              hunks.hunks.forEach(hunk => {
                if (hunk.header) {
                  diffText += hunk.header + '\\n';
                }
                if (hunk.lines) {
                  hunk.lines.forEach(line => {
                    diffText += line + '\\n';
                  });
                }
                diffText += '\\n';
              });
            } else if (d._changeInfo.summary) {
              // Show summary if available
              diffText = d._changeInfo.summary;
            } else {
              // Show basic stats
              diffText = '✏️  File has uncommitted changes\\n';
              if (hunks && hunks.hunks && hunks.hunks[0]) {
                const stats = hunks.hunks[0];
                if (stats.end - stats.start > 0) {
                  diffText += '\\nModified lines: ' + (stats.end - stats.start);
                }
              }
            }
            
            // Parse diff and apply colors
            if (diffText) {
              const lines = diffText.split('\\n');
              lines.forEach(line => {
                const escapedLine = line
                  .replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/ /g, '&nbsp;');
                
                if (line.startsWith('+') && !line.startsWith('+++')) {
                  // Addition - green background
                  diffHtml += '<div style="background-color: rgba(0, 255, 0, 0.2); padding: 2px 4px; white-space: pre;">' + escapedLine + '</div>';
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                  // Deletion - red background
                  diffHtml += '<div style="background-color: rgba(255, 0, 0, 0.2); padding: 2px 4px; white-space: pre;">' + escapedLine + '</div>';
                } else {
                  // Context or header line
                  diffHtml += '<div style="padding: 2px 4px; white-space: pre; opacity: 0.7;">' + escapedLine + '</div>';
                }
              });
            }
            
            tooltip.html(diffHtml);
            
            // Get the actual DOM element for native event handling
            const tooltipElement = tooltip.node();
            
            // Handle wheel inside tooltip: scroll tooltip, never zoom canvas
            tooltipElement.addEventListener('wheel', function(e) {
              // Stop zoom/pan handlers outside the tooltip
              e.stopImmediatePropagation();
              // Manually scroll the tooltip to ensure it always scrolls
              const deltaY = e.deltaY || 0;
              const deltaX = e.deltaX || 0;
              if (e.shiftKey) {
                // Shift-scroll scrolls horizontally
                tooltipElement.scrollLeft += deltaY !== 0 ? deltaY : deltaX;
              } else {
                tooltipElement.scrollTop += deltaY;
              }
              // Prevent default to avoid any outer scroll/zoom behavior
              e.preventDefault();
            }, { passive: false });
            
            // Make tooltip sticky and dismiss only on explicit mouseout from file and tooltip
            tooltip.on('mouseenter', function() {
              d3.select(this).classed('tooltip-hovered', true);
            });
            tooltip.on('mouseleave', function() {
              d3.select(this).classed('tooltip-hovered', false);
              // Delay removal slightly to allow pointer to re-enter from minor gaps
              setTimeout(() => {
                const self = d3.select(this);
                if (!self.classed('tooltip-hovered')) {
                  self.remove();
                }
              }, 150);
            });
          } else {
            // For unchanged files, show file preview
            // Create a placeholder tooltip immediately
            const tooltip = d3.select('body').append('div')
              .attr('class', 'file-preview-tooltip')
              .style('position', 'fixed')
              .style('left', event.clientX + 10 + 'px')
              .style('top', event.clientY + 10 + 'px')
              .style('background', 'var(--vscode-editorHoverWidget-background)')
              .style('color', 'var(--vscode-editorHoverWidget-foreground)')
              .style('border', '1px solid var(--vscode-editorHoverWidget-border)')
              .style('padding', '10px')
              .style('border-radius', '4px')
              .style('font-family', 'monospace')
              .style('font-size', '12px')
              .style('width', '600px')
              .style('max-height', '400px')
              .style('overflow-y', 'auto')
              .style('overflow-x', 'auto')
              .style('white-space', 'pre')
              .style('pointer-events', 'auto')
              .style('z-index', '10000')
              .style('box-shadow', '0 2px 8px rgba(0,0,0,0.3)')
              .text('Loading preview...');
            
            // Store the file path on the tooltip for later reference
            tooltip.attr('data-filepath', d.path);
            
            // Request file preview from extension
            vscode.postMessage({
              type: 'file:preview',
              filePath: d.path
            });
            
            // Get the actual DOM element for native event handling
            const tooltipElement = tooltip.node();
            
            // Handle wheel inside tooltip: scroll tooltip, never zoom canvas
            tooltipElement.addEventListener('wheel', function(e) {
              e.stopImmediatePropagation();
              const deltaY = e.deltaY || 0;
              const deltaX = e.deltaX || 0;
              if (e.shiftKey) {
                tooltipElement.scrollLeft += deltaY !== 0 ? deltaY : deltaX;
              } else {
                tooltipElement.scrollTop += deltaY;
              }
              e.preventDefault();
            }, { passive: false });
            
            // Make tooltip sticky
            tooltip.on('mouseenter', function() {
              d3.select(this).classed('tooltip-hovered', true);
            });
            tooltip.on('mouseleave', function() {
              d3.select(this).classed('tooltip-hovered', false);
              // Remove tooltip after a delay
              setTimeout(() => {
                const self = d3.select(this);
                if (!self.classed('tooltip-hovered')) {
                  self.remove();
                }
              }, 150);
            });
          }
          }, 500); // 0.5 second delay
        })
        // Do not follow the cursor; keep tooltip fixed so the user can reach it
        .on('mousemove', function(event) { /* intentionally no-op */ })
        .on('mouseout', function(event) {
          // Clear the tooltip timeout if mouse leaves before tooltip appears
          if (tooltipTimeout) {
            clearTimeout(tooltipTimeout);
            tooltipTimeout = null;
          }
          
          // Use a small delay to allow moving to the tooltip
          setTimeout(() => {
            // Check if mouse is over any tooltip
            const elementAtPoint = document.elementFromPoint(event.clientX, event.clientY);
            const isOverTooltip = elementAtPoint && (
              elementAtPoint.classList.contains('file-diff-tooltip') ||
              elementAtPoint.classList.contains('file-preview-tooltip') ||
              elementAtPoint.closest('.file-diff-tooltip') ||
              elementAtPoint.closest('.file-preview-tooltip')
            );
            
            if (!isOverTooltip) {
              const diffTooltip = d3.select('.file-diff-tooltip');
              if (!diffTooltip.empty() && !diffTooltip.classed('tooltip-hovered')) {
                diffTooltip.remove();
              }
              const previewTooltip = d3.select('.file-preview-tooltip');
              if (!previewTooltip.empty() && !previewTooltip.classed('tooltip-hovered')) {
                previewTooltip.remove();
              }
            }
          }, 100);
        })
        .style('cursor', 'pointer');

      // Add file name (centered in box, full name)
      fileGroups.append('text')
        .attr('class', 'file-title')
        .attr('x', 0)
        .attr('y', 4)
        .attr('text-anchor', 'middle')
        .attr('font-size', '10px')
        .attr('fill', 'var(--vscode-editor-foreground)')
        .text(d => d.name);

      // THIRD: Create external object rounded rectangles (inside component containers)
      const externalGroups = g.append('g')
        .selectAll('g')
        .data(externalNodes)
        .join('g')
        .attr('class', 'external-group');
      // No dragging for externals

      // Draw white rounded rectangles with black stroke (fixed size)
      externalGroups.append('rect')
        .attr('class', 'external-rect')
        .attr('width', d => d._width || 140)
        .attr('height', d => d._height || 50)
        .attr('x', d => -(d._width || 140) / 2)
        .attr('y', d => -(d._height || 50) / 2)
        .attr('rx', 8)
        .attr('ry', 8)
        .attr('fill', '#FFFFFF')
        .attr('stroke', '#000000')
        .attr('stroke-width', 2)
        .style('cursor', 'pointer')
        .on('click', function(event, d) {
          // Focus the folder containing the files used by this external source
          if (d.usedBy && d.usedBy.length > 0) {
            event.stopPropagation();
            console.log('[Radium Map] External box clicked:', d.name, 'files:', d.usedBy);
            
            // Auto-focus on the clicked external source
            if (autoFocusEnabled && d.x !== undefined && d.y !== undefined) {
              // Calculate the transform needed to center this external source
              const targetX = width / 2 - d.x * transform.k;
              const targetY = height / 2 - d.y * transform.k;
              
              // Smoothly transition to the new position
              svg.transition()
                .duration(750)
                .call(zoom.transform, d3.zoomIdentity.translate(targetX, targetY).scale(transform.k));
            }
            
            vscode.postMessage({
              type: 'external:focus',
              filePaths: d.usedBy
            });
          }
        })
        .on('mouseover', function(event, d) {
          // Show tooltip with description and usedBy files
          const tooltip = d3.select('body').append('div')
            .attr('class', 'external-tooltip')
            .style('position', 'fixed')
            .style('left', event.clientX + 10 + 'px')
            .style('top', event.clientY + 10 + 'px')
            .style('background', 'var(--vscode-editorHoverWidget-background)')
            .style('color', 'var(--vscode-editorHoverWidget-foreground)')
            .style('border', '1px solid var(--vscode-editorHoverWidget-border)')
            .style('padding', '10px')
            .style('border-radius', '4px')
            .style('font-family', 'var(--vscode-font-family)')
            .style('font-size', '12px')
            .style('max-width', '400px')
            .style('z-index', '10000')
            .style('box-shadow', '0 2px 8px rgba(0,0,0,0.3)')
            .style('pointer-events', 'auto');
          
          // Add header with name and type
          tooltip.append('div')
            .style('font-weight', 'bold')
            .style('margin-bottom', '8px')
            .style('font-size', '13px')
            .text(d.name + ' (' + d.externalType + ')');
          
          // Add description if available
          if (d.description) {
            tooltip.append('div')
              .style('margin-bottom', '10px')
              .style('padding-bottom', '8px')
              .style('border-bottom', '1px solid var(--vscode-editorHoverWidget-border)')
              .style('color', 'var(--vscode-descriptionForeground)')
              .style('line-height', '1.4')
              .text(d.description);
          }
          
          // Add "Used By" section if there are files
          if (d.usedBy && d.usedBy.length > 0) {
            tooltip.append('div')
              .style('font-weight', 'bold')
              .style('margin-top', '8px')
              .style('margin-bottom', '6px')
              .style('font-size', '11px')
              .style('color', 'var(--vscode-descriptionForeground)')
              .text('Used by:');
            
            // Add file boxes
            const filesContainer = tooltip.append('div')
              .style('display', 'flex')
              .style('flex-direction', 'column')
              .style('gap', '4px');
            
            d.usedBy.forEach(filePath => {
              const fileName = filePath.split('/').pop() || filePath;
              filesContainer.append('div')
                .style('background', 'var(--vscode-input-background)')
                .style('border', '1px solid var(--vscode-input-border)')
                .style('padding', '4px 8px')
                .style('border-radius', '3px')
                .style('font-family', 'monospace')
                .style('font-size', '11px')
                .style('cursor', 'pointer')
                .style('transition', 'background 0.2s')
                .text(fileName)
                .attr('title', filePath)
                .on('mouseover', function() {
                  d3.select(this)
                    .style('background', 'var(--vscode-list-hoverBackground)')
                    .style('border-color', 'var(--vscode-focusBorder)');
                })
                .on('mouseout', function() {
                  d3.select(this)
                    .style('background', 'var(--vscode-input-background)')
                    .style('border-color', 'var(--vscode-input-border)');
                })
                .on('click', function() {
                  // Send message to open the file
                  vscode.postMessage({
                    type: 'file:open',
                    filePath: filePath
                  });
                  // Remove tooltip after click
                  d3.selectAll('.external-tooltip').remove();
                });
            });
          }
          
          // Make tooltip sticky - only remove when mouse leaves both the external box and tooltip
          let overTooltip = false;
          tooltip.on('mouseenter', function() {
            overTooltip = true;
          });
          tooltip.on('mouseleave', function() {
            overTooltip = false;
            setTimeout(() => {
              if (!overTooltip) {
                d3.select(this).remove();
              }
            }, 100);
          });
        })
        .on('mouseout', function() {
          // Delay removal to allow moving to tooltip
          setTimeout(() => {
            const tooltip = d3.select('.external-tooltip');
            if (!tooltip.empty()) {
              const tooltipNode = tooltip.node();
              const isHoveringTooltip = tooltipNode && tooltipNode.matches(':hover');
              if (!isHoveringTooltip) {
                tooltip.remove();
              }
            }
          }, 100);
        });

      // Add icon inside the box on the left
      externalGroups.append('text')
        .attr('class', 'external-icon')
        .attr('x', d => -(d._width || 140) / 2 + 20)
        .attr('y', 5)
        .attr('font-size', '24px')
        .text(d => getExternalIcon(d.externalType));

      // Add external object name (black text, to the right of icon)
      externalGroups.append('text')
        .attr('class', 'external-label')
        .attr('x', d => -(d._width || 140) / 2 + 55)
        .attr('y', -5)
        .attr('text-anchor', 'start')
        .attr('font-size', '11px')
        .attr('font-weight', 'bold')
        .attr('fill', '#000000')
        .text(d => {
          const name = d.name;
          return name.length > 12 ? name.substring(0, 10) + '...' : name;
        });

      // Add external object type (smaller, below name)
      externalGroups.append('text')
        .attr('class', 'external-type')
        .attr('x', d => -(d._width || 140) / 2 + 55)
        .attr('y', 10)
        .attr('text-anchor', 'start')
        .attr('font-size', '9px')
        .attr('fill', '#666666')
        .text(d => d.externalType);

      // Debug logging
      console.log('[Radium Map] Graph data:', {
        nodeCount: data.nodes.length,
        edgeCount: data.edges.length,
        components: data.nodes.filter(n => n.kind === 'component').length,
        directories: data.nodes.filter(n => n.kind === 'directory').length,
        files: data.nodes.filter(n => n.kind === 'file').length,
        external: data.nodes.filter(n => n.kind === 'external').length
      });

      // Update simulation with static positions (no movement)
      simulation.nodes(data.nodes);
      simulation.force('link').links([]);  // No links to draw
      simulation.alpha(0).stop();
      
      // Position file boxes
      fileGroups
        .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');

      // Position external object boxes
      externalGroups
        .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
      
      console.log('[Radium Map] Static layout applied with', data.nodes.length, 'nodes and', data.edges.length, 'edges');
      console.log('[Radium Map] updateGraph completed successfully');
      } catch (error) {
        console.error('[Radium Map] Error in updateGraph:', error);
        console.error(error.stack);
      }
    }

    function drag(simulation) {
      function dragstarted(event) {
        // Keep the node fixed at its current position
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }

      function dragged(event) {
        // Update fixed position while dragging
        event.subject.fx = event.x;
        event.subject.fy = event.y;
        event.subject.x = event.x;
        event.subject.y = event.y;
        
        // Manually update positions of this node's visual elements
        d3.select(event.sourceEvent.target.parentNode)
          .attr('transform', 'translate(' + event.x + ',' + event.y + ')');
        
        // Update connected edges
        g.selectAll('.link')
          .filter(d => d.source.id === event.subject.id || d.target.id === event.subject.id)
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        
        // Update external link positions (elbow connectors)
        // Note: createElbowPath is defined in the outer scope of updateGraph
        // We need to recreate the path calculation logic here for drag updates
        g.selectAll('.external-link')
          .filter(d => getId(d.source) === event.subject.id || getId(d.target) === event.subject.id)
          .attr('d', d => {
            const sourceNode = graphData.nodes.find(n => n.id === getId(d.source));
            const targetNode = graphData.nodes.find(n => n.id === getId(d.target));
            if (!sourceNode || !targetNode) return '';
            
            // Simplified routing during drag (use basic elbow for performance)
            const sourceX = sourceNode.x - (sourceNode._width || 140) / 2;
            const sourceY = sourceNode.y;
            const targetX = targetNode.x + (targetNode._width || 100) / 2;
            const targetY = targetNode.y;
            const midX = (sourceX + targetX) / 2;
            
            return 'M ' + sourceX + ' ' + sourceY + ' L ' + midX + ' ' + sourceY + ' L ' + midX + ' ' + targetY + ' L ' + targetX + ' ' + targetY;
          });
      }

      function dragended(event) {
        // Keep the node at its new fixed position
        // Don't set fx/fy to null - we want it to stay where dragged
      }

      return d3.drag()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);
    }

    function updateVisibilityByZoom() {
      const isZoomedOut = currentZoomLevel < ZOOM_THRESHOLD;
      
      // Hide/show file nodes and external nodes based on zoom level
      g.selectAll('.file-group')
        .style('display', isZoomedOut ? 'none' : 'block');
      
      g.selectAll('.external-group')
        .style('display', isZoomedOut ? 'none' : 'block');
      
      // Hide/show external links based on zoom level
      g.selectAll('.external-link')
        .style('display', isZoomedOut ? 'none' : 'block');
      
      // Adjust component appearance based on zoom
      if (isZoomedOut) {
        // Track tooltip timeout for each component
        let componentTooltipTimeout = null;
        
        // When zoomed out: Fill entire box with component color
        g.selectAll('.component-container')
          .attr('fill', d => d.componentKey === '__new_files__' ? '#3a3a3a' : d.color)
          .attr('fill-opacity', 0.9)
          .style('pointer-events', 'all')
          .style('cursor', 'pointer')
          .on('mouseenter', function(event, d) {
            // Clear any existing timeout
            if (componentTooltipTimeout) {
              clearTimeout(componentTooltipTimeout);
            }
            
            // Set timeout to show tooltip after 0.5 seconds
            componentTooltipTimeout = setTimeout(() => {
              // Show tooltip with component description
              if (d.description) {
                const tooltip = d3.select('body').append('div')
                  .attr('class', 'component-tooltip')
                  .style('position', 'fixed')
                  .style('left', event.clientX + 10 + 'px')
                  .style('top', event.clientY + 10 + 'px')
                  .style('background', 'var(--vscode-editorHoverWidget-background)')
                  .style('color', 'var(--vscode-editorHoverWidget-foreground)')
                  .style('border', '1px solid var(--vscode-editorHoverWidget-border)')
                  .style('padding', '10px')
                  .style('border-radius', '4px')
                  .style('font-family', 'var(--vscode-font-family)')
                  .style('font-size', '12px')
                  .style('max-width', '400px')
                  .style('z-index', '10000')
                  .style('box-shadow', '0 2px 8px rgba(0,0,0,0.3)')
                  .style('pointer-events', 'none');
                
                // Add component name as header
                tooltip.append('div')
                  .style('font-weight', 'bold')
                  .style('margin-bottom', '8px')
                  .style('font-size', '13px')
                  .text(d.name);
                
                // Add description
                tooltip.append('div')
                  .style('line-height', '1.4')
                  .text(d.description);
              }
            }, 500); // 0.5 second delay
          })
          .on('mouseleave', function() {
            // Clear the timeout if mouse leaves before tooltip appears
            if (componentTooltipTimeout) {
              clearTimeout(componentTooltipTimeout);
              componentTooltipTimeout = null;
            }
            // Remove any existing tooltips
            d3.selectAll('.component-tooltip').remove();
          });
        
        // Hide the header bar (it's redundant when box is filled)
        g.selectAll('.component-header')
          .style('display', 'none');
        
        // Enlarge and center the component label with multi-line support
        g.selectAll('.component-label')
          .each(function(d) {
            const textElement = d3.select(this);
            const name = d.name;
            const padding = 20;
            const availableWidth = d._boxWidth - padding * 2;
            const availableHeight = d._boxHeight - padding * 2;
            
            // Calculate optimal font size for 2 lines
            const heightBasedSize = Math.min(72, availableHeight / 3); // Allow space for 2 lines + spacing
            
            // Estimate if text fits in one line or needs two
            const avgCharWidth = 0.6; // Rough approximation
            const estimatedWidth = name.length * heightBasedSize * avgCharWidth;
            const needsTwoLines = estimatedWidth > availableWidth;
            
            let fontSize;
            if (needsTwoLines) {
              // For two lines, we can use larger font
              const twoLineWidthBasedSize = availableWidth / (name.length / 2 * avgCharWidth);
              fontSize = Math.min(heightBasedSize, twoLineWidthBasedSize, 72);
            } else {
              // Single line
              const widthBasedSize = availableWidth / (name.length * avgCharWidth);
              fontSize = Math.min(heightBasedSize * 1.5, widthBasedSize, 72); // Allow larger for single line
            }
            
            textElement.attr('font-size', fontSize + 'px');
            
            // Clear existing text and tspans
            textElement.text('');
            textElement.selectAll('tspan').remove();
            
            // Split text into words for wrapping
            const words = name.split(/\\s+/);
            const lineHeight = fontSize * 1.2;
            
            if (needsTwoLines && words.length > 1) {
              // Try to split into two balanced lines
              const midPoint = Math.ceil(words.length / 2);
              const line1 = words.slice(0, midPoint).join(' ');
              const line2 = words.slice(midPoint).join(' ');
              
              // Center vertically with two lines
              // For two lines, we need to position them so their visual center aligns with box center
              // The visual center of two lines is between them
              const centerY = d._boxY + d._boxHeight / 2;
              // Position first line above center, second line below center
              // Each line should be lineHeight/2 away from center (accounting for baseline offset)
              const firstLineY = centerY - lineHeight / 2 + fontSize * 0.35;
              const secondLineY = centerY + lineHeight / 2 + fontSize * 0.35;
              
              textElement.append('tspan')
                .attr('x', d._boxX + d._boxWidth / 2)
                .attr('y', firstLineY)
                .attr('text-anchor', 'middle')
                .text(line1);
              
              textElement.append('tspan')
                .attr('x', d._boxX + d._boxWidth / 2)
                .attr('y', secondLineY)
                .attr('text-anchor', 'middle')
                .text(line2);
            } else {
              // Single line - center both horizontally and vertically
              // For baseline positioning, we need to add ~0.35em (35% of font size) to center the text
              // This accounts for the fact that text baseline is not at the vertical center
              const centerY = d._boxY + d._boxHeight / 2;
              const baselineY = centerY + fontSize * 0.35;
              
              textElement.append('tspan')
                .attr('x', d._boxX + d._boxWidth / 2)
                .attr('y', baselineY)
                .attr('text-anchor', 'middle')
                .text(name);
            }
          });
      } else {
        // Restore normal appearance
        g.selectAll('.component-container')
          .attr('fill', d => d.componentKey === '__new_files__' ? '#3a3a3a' : 'var(--vscode-editor-background)')
          .attr('fill-opacity', 1)
          .style('pointer-events', 'none')
          .style('cursor', null)
          .on('mouseenter', null)
          .on('mouseleave', null);
        
        // Remove any lingering tooltips
        d3.selectAll('.component-tooltip').remove();
        
        // Show the header bar
        g.selectAll('.component-header')
          .style('display', 'block');
        
        // Restore normal label size and position (single line)
        g.selectAll('.component-label')
          .attr('font-size', '18px')
          .each(function(d) {
            const textElement = d3.select(this);
            textElement.text('');
            textElement.selectAll('tspan').remove();
            textElement.append('tspan')
              .attr('x', d._boxX + d._boxWidth / 2)
              .attr('y', d._boxY + 33)
              .attr('text-anchor', 'middle')
              .text(d.name);
          });
      }
    }

    function resetView() {
      console.log('[Radium Map] Reset view called');
      
      // Calculate bounding box of all components
      try {
        const bounds = g.node().getBBox();
        const fullWidth = bounds.width;
        const fullHeight = bounds.height;
        const midX = bounds.x + fullWidth / 2;
        const midY = bounds.y + fullHeight / 2;
        
        // Calculate scale to fit all components with some padding (0.8 = 80% of viewport)
        const scale = 0.8 / Math.max(fullWidth / width, fullHeight / height);
        const targetX = width / 2 - scale * midX;
        const targetY = height / 2 - scale * midY;
        
        // Get current transform
        const currentTransform = zoom.transform();
        
        // Animate to fit view
        const steps = 30;
        const duration = 750;
        const stepDuration = duration / steps;
        
        const startK = currentTransform.k;
        const startX = currentTransform.x;
        const startY = currentTransform.y;
        
        let step = 0;
        const interval = setInterval(() => {
          step++;
          const progress = step / steps;
          const eased = 1 - Math.pow(1 - progress, 3); // Ease out cubic
          
          const newK = startK + (scale - startK) * eased;
          const newX = startX + (targetX - startX) * eased;
          const newY = startY + (targetY - startY) * eased;
          
          // Update transform manually
          zoom.scaleTo(null, newK);
          zoom.translateTo(null, newX, newY);
          
          if (step >= steps) {
            clearInterval(interval);
          }
        }, stepDuration);
      } catch (error) {
        console.error('[Radium Map] Error calculating bounds for reset view:', error);
        // Fallback to simple reset
        zoom.scaleTo(null, 1);
        zoom.translateTo(null, 0, 0);
      }
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
      
      console.log('[Radium Map] highlightChangedFiles called with', changes.length, 'changes');
      
      // Create a map of file paths to change info
      const changeMap = new Map();
      changes.forEach(change => {
        console.log('[Radium Map] Adding changed file:', change.filePath);
        changedFilePaths.add(change.filePath);
        changeMap.set(change.filePath, change);
      });

      console.log('[Radium Map] Changed file paths:', Array.from(changedFilePaths));
      
      // Get all file paths in the graph for debugging
      const allFilePaths = [];
      g.selectAll('.file-box').each(function(d) {
        allFilePaths.push(d.path);
      });
      console.log('[Radium Map] All file paths in graph:', allFilePaths);

      // Update file box styling to highlight changed files with yellow
      let highlightCount = 0;
      let checkedCount = 0;
      g.selectAll('.file-box')
        .style('fill', function(d) {
          checkedCount++;
          const isChanged = changedFilePaths.has(d.path);
          if (checkedCount <= 5) {
            console.log('[Radium Map] Checking file:', d.path, 'changed:', isChanged);
          }
          if (isChanged) {
            highlightCount++;
            console.log('[Radium Map] ✓ HIGHLIGHTING:', d.path);
            return '#FFEB3B'; // Bright yellow for changed files
          }
          return null; // Use CSS default for unchanged files
        })
        .style('stroke', function(d) {
          if (changedFilePaths.has(d.path)) {
            return '#FF6B00'; // Bright orange border for changed files
          }
          return null; // Use CSS default
        })
        .style('stroke-width', function(d) {
          if (changedFilePaths.has(d.path)) {
            return '4px'; // Thicker border for visibility
          }
          return null; // Use CSS default
        });
      
      // Update file text color to black for highlighted files
      g.selectAll('.file-group text')
        .style('fill', function(d) {
          if (changedFilePaths.has(d.path)) {
            return '#000000'; // Black text for changed files
          }
          return null; // Use CSS default
        });
      
      console.log('[Radium Map] Checked', checkedCount, 'files, highlighted', highlightCount, 'files');
      
      // Store change info on file nodes for hover tooltip
      g.selectAll('.file-group')
        .each(function(d) {
          if (changedFilePaths.has(d.path)) {
            d._changeInfo = changeMap.get(d.path);
          } else {
            d._changeInfo = null;
          }
        });
    }

    function clearOverlays() {
      changedFilePaths.clear();
      
      // Reset file box styling - clear inline styles to use CSS defaults
      g.selectAll('.file-box')
        .style('fill', null)
        .style('stroke', null)
        .style('stroke-width', null);
      
      // Reset file text color
      g.selectAll('.file-group text')
        .style('fill', null);
      
      // Clear change info from file nodes
      g.selectAll('.file-group')
        .each(function(d) {
          d._changeInfo = null;
        });
    }

    ${this.getDisplayCommentsFunction()}

    // Function to focus on changed files
    function focusOnChangedFiles(filePaths, specificFile, comments) {
      if (!graphData || !graphData.nodes || filePaths.length === 0 || !svg || !g) {
        console.log('[Radium Map] Cannot focus - missing data or SVG not initialized');
        return;
      }
      
      let changedFileNode = null;
      
      // If a specific file was provided, try to focus on it
      if (specificFile) {
        changedFileNode = graphData.nodes.find(node => 
          node.kind === 'file' && 
          node.path && 
          (node.path === specificFile || node.path.includes(specificFile))
        );
      }
      
      // If no specific file or not found, find any changed file
      if (!changedFileNode) {
        changedFileNode = graphData.nodes.find(node => 
          node.kind === 'file' && 
          filePaths.some(fp => node.path && node.path.includes(fp))
        );
      }
      
      if (!changedFileNode || changedFileNode.x === undefined || changedFileNode.y === undefined) {
        console.log('[Radium Map] Could not find new changed file node to focus on');
        return;
      }
      
      // Update the last focused file
      lastFocusedFilePath = changedFileNode.path;
      
      console.log('[Radium Map] Focusing on file:', changedFileNode.path, 'at position:', changedFileNode.x, changedFileNode.y);
      
      // Add blinking yellow border animation
      var fileBoxes = svg.selectAll('.file-box');
      fileBoxes.each(function(d) {
        if (d === changedFileNode) {
          var box = d3.select(this);
          box.classed('file-box-changed', false);
          setTimeout(function() {
            box.classed('file-box-changed', true);
          }, 10);
          setTimeout(function() {
            box.classed('file-box-changed', false);
          }, 3000);
        }
      });
      
      // Calculate the target transform to center this file
      const targetX = width / 2 - changedFileNode.x * transform.k;
      const targetY = height / 2 - changedFileNode.y * transform.k;
      
      console.log('[Radium Map] Animating to:', targetX, targetY, 'scale:', transform.k);
      
      // Animate the transform
      const startX = transform.x;
      const startY = transform.y;
      const duration = 750;
      const startTime = Date.now();
      
      function animate() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Easing function (ease-out)
        const eased = 1 - Math.pow(1 - progress, 3);
        
        transform.x = startX + (targetX - startX) * eased;
        transform.y = startY + (targetY - startY) * eased;
        
        g.attr('transform', 'translate(' + transform.x + ',' + transform.y + ') scale(' + transform.k + ')');
        
        if (progress < 1) {
          requestAnimationFrame(animate);
        } else if (comments && comments.length > 0) {
          // After animation completes, display comments
          displayComments(changedFileNode, comments);
        }
      }
      
      animate();
    }

    // Listen for messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      console.log('[Radium Map] Received message:', message.type, message);
      switch (message.type) {
        case 'graph:update':
          updateGraph(message.data, message.filtered || false);
          break;
        case 'overlay:session':
          console.log('[Radium Map] overlay:session - sessionId:', message.sessionId, 'changes:', message.changes);
          activeOverlay = message.sessionId;
          // Always highlight changed files (don't filter graph)
          highlightChangedFiles(message.changes);
          break;
        case 'overlay:clear':
          activeOverlay = null;
          clearOverlays();
          lastFocusedFilePath = null; // Reset last focused file when overlay is cleared
          if (fullGraphData) {
            updateGraph(fullGraphData, false);
          }
          break;
        case 'files:changed':
          // Auto-focus on changed files if enabled
          if (autoFocusEnabled && message.filePaths && message.filePaths.length > 0) {
            console.log('[Radium Map] Auto-focusing on changed files:', message.filePaths, 'specific:', message.specificFile, 'comments:', message.comments);
            focusOnChangedFiles(message.filePaths, message.specificFile, message.comments);
          }
          break;
        case 'path:result':
          // Highlight path
          console.log('Path:', message.path);
          break;
        case 'file:preview-content':
          // Update the preview tooltip with the file content
          const previewTooltip = d3.select('.file-preview-tooltip[data-filepath="' + message.filePath + '"]');
          if (!previewTooltip.empty()) {
            if (message.error) {
              previewTooltip.text('📄 ' + message.filePath + '\\n\\n' + message.error);
            } else if (message.content) {
              let previewText = '📄 ' + message.filePath + '\\n';
              if (message.totalLines > 20) {
                previewText += '(Showing first 20 of ' + message.totalLines + ' lines)\\n';
              }
              previewText += '\\n' + message.content;
              previewTooltip.text(previewText);
            }
          }
          break;
      }
    });

    // Initialize
    initVisualization();
    
    // Notify extension that webview is ready
    vscode.postMessage({ type: 'ready' });

      // Handle resize
    window.addEventListener('resize', () => {
      width = window.innerWidth;
      height = window.innerHeight;
      svg.attr('width', width).attr('height', height);
      // Don't restart simulation - we have static layout
    });

      // Global wheel guard: if pointer is over tooltip, stop zoom
      window.addEventListener('wheel', (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && (el.classList.contains('file-diff-tooltip') || el.closest('.file-diff-tooltip') ||
                   el.classList.contains('file-preview-tooltip') || el.closest('.file-preview-tooltip'))) {
          e.stopPropagation();
        }
      }, { capture: true, passive: true });

    // Search functionality
    function performSearch(query) {
      searchQuery = query.toLowerCase().trim();
      filteredNodeIds.clear();
      
      if (!searchQuery) {
        // Clear search - show all nodes
        g.selectAll('.component-container, .component-header, .component-label').style('opacity', 1);
        g.selectAll('.file-group').style('opacity', 1);
        g.selectAll('.external-group').style('opacity', 1);
        document.getElementById('search-results').textContent = '';
        return;
      }
      
      // Find matching nodes
      let matchCount = 0;
      graphData.nodes.forEach(node => {
        const matches = 
          (node.name && node.name.toLowerCase().includes(searchQuery)) ||
          (node.path && node.path.toLowerCase().includes(searchQuery)) ||
          (node.description && node.description.toLowerCase().includes(searchQuery)) ||
          (node.externalType && node.externalType.toLowerCase().includes(searchQuery));
        
        if (matches) {
          filteredNodeIds.add(node.id);
          matchCount++;
        }
      });
      
      // Update visibility
      g.selectAll('.component-container, .component-header, .component-label')
        .style('opacity', d => filteredNodeIds.has(d.id) ? 1 : 0.15);
      
      g.selectAll('.file-group')
        .style('opacity', d => filteredNodeIds.has(d.id) ? 1 : 0.15);
      
      g.selectAll('.external-group')
        .style('opacity', d => filteredNodeIds.has(d.id) ? 1 : 0.15);
      
      // Update results text
      const resultsText = matchCount === 0 ? 'No matches' : 
                         matchCount === 1 ? '1 match' : 
                         matchCount + ' matches';
      document.getElementById('search-results').textContent = resultsText;
    }
    
    function clearSearch() {
      document.getElementById('search-input').value = '';
      performSearch('');
    }

    // Add event listeners for control buttons
    document.getElementById('reset-view-btn')?.addEventListener('click', resetView);
    document.getElementById('show-all-btn')?.addEventListener('click', showAllFiles);
    document.getElementById('changes-btn')?.addEventListener('click', () => {
      console.log('[Radium Map] Changes button clicked');
      toggleLayer('changes');
    });

    // Auto-focus toggle
    const autoFocusToggle = document.getElementById('auto-focus-toggle');
    const toggleCheckbox = autoFocusToggle?.querySelector('.toggle-checkbox');
    
    autoFocusToggle?.addEventListener('click', () => {
      autoFocusEnabled = !autoFocusEnabled;
      
      if (autoFocusEnabled) {
        autoFocusToggle.classList.add('active');
        if (toggleCheckbox) toggleCheckbox.textContent = '✓';
      } else {
        autoFocusToggle.classList.remove('active');
        if (toggleCheckbox) toggleCheckbox.textContent = '';
      }
      
      console.log('[Radium Map] Auto-focus', autoFocusEnabled ? 'enabled' : 'disabled');
      
      // Notify the extension about the toggle state
      vscode.postMessage({
        type: 'autoFocus:toggle',
        enabled: autoFocusEnabled
      });
    });
    
    // Add event listeners for search
    const searchInput = document.getElementById('search-input');
    searchInput?.addEventListener('input', (e) => {
      performSearch(e.target.value);
    });
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        clearSearch();
      }
    });
    document.getElementById('clear-search-btn')?.addEventListener('click', clearSearch);
  </script>
</body>
</html>`;
  }
}


import * as vscode from 'vscode';
import { GraphStore } from '../store/schema';
import * as path from 'path';
import { RadiumIgnore } from '../config/radium-ignore';

interface FileInfo {
  path: string;
  name: string;
  directory: string;
}

interface DirectoryNode {
  name: string;
  path: string;
  files: string[];
  subdirectories: Map<string, DirectoryNode>;
}

interface DirectoryStructure {
  root: DirectoryNode;
}

export class FileStructurePanel {
  public static currentPanel: FileStructurePanel | undefined;
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

    if (FileStructurePanel.currentPanel) {
      FileStructurePanel.currentPanel.panel.reveal(column);
      FileStructurePanel.currentPanel.updateStructure();
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'fileStructure',
      'Radium: File Structure',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    FileStructurePanel.currentPanel = new FileStructurePanel(
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
        this.updateStructure();
        break;
    }
  }

  private async handleFileOpen(filePath: string) {
    try {
      const fullPath = path.join(this.workspaceRoot, filePath);
      const doc = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(doc);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
    }
  }

  private updateStructure() {
    const structure = this.buildDirectoryStructure();
    // Convert Maps to plain objects for JSON serialization
    const serializedStructure = this.serializeStructure(structure);
    this.panel.webview.postMessage({
      type: 'structure:update',
      structure: serializedStructure
    });
  }

  private serializeStructure(structure: DirectoryStructure): any {
    const serializeNode = (node: DirectoryNode): any => {
      const subdirectories: { [key: string]: any } = {};
      node.subdirectories.forEach((subdir, name) => {
        subdirectories[name] = serializeNode(subdir);
      });
      
      return {
        name: node.name,
        path: node.path,
        files: node.files,
        subdirectories
      };
    };

    return {
      root: serializeNode(structure.root)
    };
  }

  private buildDirectoryStructure(): DirectoryStructure {
    const allFiles = this.store.getAllFiles();
    const workspaceName = path.basename(this.workspaceRoot);

    // Create root node
    const root: DirectoryNode = {
      name: workspaceName,
      path: '',
      files: [],
      subdirectories: new Map()
    };

    // Group files by their directory hierarchy
    for (const file of allFiles) {
      const relativePath = file.path;
      
      // Check if file should be ignored
      if (this.radiumIgnore.shouldIgnore(relativePath)) {
        continue;
      }

      const parts = relativePath.split('/');
      const fileName = parts[parts.length - 1];

      // Navigate/create the directory tree
      let currentNode = root;
      
      // Process each directory in the path
      for (let i = 0; i < parts.length - 1; i++) {
        const dirName = parts[i];
        const dirPath = parts.slice(0, i + 1).join('/');
        
        if (!currentNode.subdirectories.has(dirName)) {
          currentNode.subdirectories.set(dirName, {
            name: dirName,
            path: dirPath,
            files: [],
            subdirectories: new Map()
          });
        }
        
        currentNode = currentNode.subdirectories.get(dirName)!;
      }
      
      // Add file to the final directory
      currentNode.files.push(fileName);
    }

    return { root };
  }

  private dispose() {
    FileStructurePanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private getHtmlContent(extensionUri: vscode.Uri): string {
    const workspaceName = path.basename(this.workspaceRoot);
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Radium: File Structure</title>
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
    
    .root-box {
      stroke: #666;
      stroke-width: 3;
    }
    
    .root-label {
      fill: #fff;
      font-size: 24px;
      font-weight: bold;
      text-anchor: middle;
      pointer-events: none;
    }
    
    .category-box {
      stroke: #555;
      stroke-width: 2;
      cursor: pointer;
    }
    
    .category-label {
      fill: #fff;
      font-size: 16px;
      font-weight: 600;
      text-anchor: middle;
      pointer-events: none;
    }
    
    .subdir-box {
      stroke: #555;
      stroke-width: 2;
      cursor: pointer;
    }
    
    .subdir-label {
      fill: #d4d4d4;
      font-size: 14px;
      font-weight: 600;
      text-anchor: middle;
      pointer-events: none;
    }
    
    .file-box {
      fill: #2d2d2d;
      stroke: #555;
      stroke-width: 2;
      cursor: pointer;
    }
    
    .file-box:hover {
      fill: #3d3d3d;
    }
    
    .file-text {
      fill: #d4d4d4;
      font-size: 12px;
      cursor: pointer;
      text-anchor: start;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <svg id="graph"></svg>
  
  <script>
    const vscode = acquireVsCodeApi();
    let svg, g, zoom;
    
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
      
      g = svg.append('g');
      
      // Notify extension that webview is ready
      vscode.postMessage({ type: 'ready' });
    }
    
    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'structure:update':
          renderStructure(message.structure);
          break;
      }
    });
    
    function renderStructure(structure) {
      g.selectAll('*').remove();
      
      if (!structure || !structure.root) {
        return;
      }
      
      const root = structure.root;
      const boxWidth = 250;
      const boxHeight = 40;
      const fileBoxHeight = 35;
      const rootX = 100;
      const rootY = 50;
      
      // Calculate columns for top-level directories
      const topLevelDirs = Object.keys(root.subdirectories).sort();
      
      if (topLevelDirs.length === 0 && root.files.length === 0) {
        return;
      }
      
      // Helper function to calculate width recursively (bottom-up)
      function calculateWidth(dirNode) {
        const subdirNames = Object.keys(dirNode.subdirectories).sort();
        const hasFiles = dirNode.files.length > 0;
        
        // Calculate total width of all subdirectories (recursive)
        let totalSubdirWidth = 0;
        subdirNames.forEach((name) => {
          const subdir = dirNode.subdirectories[name];
          totalSubdirWidth += calculateWidth(subdir);
        });
        
        // Width = files column (if any) + sum of subdirectory widths
        const filesWidth = hasFiles ? boxWidth : 0;
        return Math.max(filesWidth + totalSubdirWidth, boxWidth);
      }
      
      // Calculate root width using the same recursive calculation
      const rootWidth = calculateWidth(root);
      const rootHeight = 60;
      
      // Draw root box
      g.append('rect')
        .attr('class', 'root-box')
        .attr('x', rootX)
        .attr('y', rootY)
        .attr('width', rootWidth)
        .attr('height', rootHeight)
        .attr('rx', 0)
        .attr('fill', '#c0c0c0');
      
      g.append('text')
        .attr('class', 'root-label')
        .attr('x', rootX + rootWidth / 2)
        .attr('y', rootY + rootHeight / 2 + 8)
        .text(root.name + '/');
      
      const contentStartY = rootY + rootHeight;
      
      // Recursive function to render a directory and its contents
      // Returns { width, height } - the dimensions this directory occupies
      function renderDirectory(dirNode, x, y, depth) {
        const subdirNames = Object.keys(dirNode.subdirectories).sort();
        const hasFiles = dirNode.files.length > 0;
        
        // Calculate directory box width recursively (bottom-up)
        const dirWidth = calculateWidth(dirNode);
        
        // Calculate gray shade based on depth (lighter = higher level)
        const grayShade = Math.max(160 - depth * 20, 80);
        const fillColor = \`rgb(\${grayShade}, \${grayShade}, \${grayShade})\`;
        
        // Draw directory box
        g.append('rect')
          .attr('class', depth === 0 ? 'category-box' : 'subdir-box')
          .attr('x', x)
          .attr('y', y)
          .attr('width', dirWidth)
          .attr('height', boxHeight)
          .attr('rx', 0)
          .attr('fill', fillColor);
        
        g.append('text')
          .attr('class', depth === 0 ? 'category-label' : 'subdir-label')
          .attr('x', x + dirWidth / 2)
          .attr('y', y + boxHeight / 2 + 5)
          .text(dirNode.name + '/');
        
        const contentY = y + boxHeight;
        let currentX = x;
        let maxHeight = 0;
        
        // Render files column (if there are files)
        if (hasFiles) {
          let fileY = contentY;
          dirNode.files.forEach((file) => {
            const fullPath = dirNode.path ? dirNode.path + '/' + file : file;
            
            g.append('rect')
              .attr('class', 'file-box')
              .attr('x', currentX)
              .attr('y', fileY)
              .attr('width', boxWidth)
              .attr('height', fileBoxHeight)
              .attr('rx', 0)
              .style('cursor', 'pointer')
              .on('click', () => {
                vscode.postMessage({ type: 'file:open', filePath: fullPath });
              });
            
            g.append('text')
              .attr('class', 'file-text')
              .attr('x', currentX + 10)
              .attr('y', fileY + fileBoxHeight / 2 + 4)
              .text(file)
              .style('cursor', 'pointer')
              .on('click', () => {
                vscode.postMessage({ type: 'file:open', filePath: fullPath });
              });
            
            fileY += fileBoxHeight;
          });
          
          maxHeight = fileY - contentY;
          currentX += boxWidth;
        }
        
        // Render subdirectories as columns (side by side with files column)
        subdirNames.forEach((name, index) => {
          const subdir = dirNode.subdirectories[name];
          const result = renderDirectory(subdir, currentX, contentY, depth + 1);
          maxHeight = Math.max(maxHeight, result.height);
          currentX += result.width; // Move to the right by the subdirectory's actual width
        });
        
        const totalHeight = boxHeight + maxHeight;
        return { width: dirWidth, height: totalHeight };
      }
      
      // Render root files and top-level directories as columns
      let currentX = rootX;
      let maxHeight = 0;
      
      // Render root files column if any
      if (root.files.length > 0) {
        let fileY = contentStartY;
        root.files.forEach((file) => {
          g.append('rect')
            .attr('class', 'file-box')
            .attr('x', currentX)
            .attr('y', fileY)
            .attr('width', boxWidth)
            .attr('height', fileBoxHeight)
            .attr('rx', 0)
            .style('cursor', 'pointer')
            .on('click', () => {
              vscode.postMessage({ type: 'file:open', filePath: file });
            });
          
          g.append('text')
            .attr('class', 'file-text')
            .attr('x', currentX + 10)
            .attr('y', fileY + fileBoxHeight / 2 + 4)
            .text(file)
            .style('cursor', 'pointer')
            .on('click', () => {
              vscode.postMessage({ type: 'file:open', filePath: file });
            });
          
          fileY += fileBoxHeight;
        });
        
        maxHeight = fileY - contentStartY;
        currentX += boxWidth;
      }
      
      // Render top-level directories as columns
      topLevelDirs.forEach((dirName) => {
        const dirNode = root.subdirectories[dirName];
        const result = renderDirectory(dirNode, currentX, contentStartY, 0);
        currentX += result.width; // Next top-level dir starts after this one
        maxHeight = Math.max(maxHeight, result.height);
      });
      
      // Center the view
      const bounds = g.node().getBBox();
      const fullWidth = bounds.width;
      const fullHeight = bounds.height;
      const midX = bounds.x + fullWidth / 2;
      const midY = bounds.y + fullHeight / 2;
      
      const scale = 0.9 / Math.max(fullWidth / window.innerWidth, fullHeight / window.innerHeight);
      const translate = [
        window.innerWidth / 2 - scale * midX,
        window.innerHeight / 2 - scale * midY
      ];
      
      svg.call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
    }
    
    // Initialize on load
    window.addEventListener('load', init);
  </script>
</body>
</html>`;
  }
}


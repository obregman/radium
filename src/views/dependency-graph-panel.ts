import * as vscode from 'vscode';
import { GraphStore, Node, Edge, FileRecord, EdgeKind } from '../store/schema';
import * as path from 'path';

interface DependencyNode {
  id: string;
  type: 'file';
  label: string;
  path: string;
  lang: string;
  size: number;
  inDegree: number;  // How many files depend on this
  outDegree: number; // How many files this depends on
}

interface DependencyEdge {
  source: string;
  target: string;
  type: EdgeKind;
  weight: number;
}

interface DependencyGraphData {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export class DependencyGraphPanel {
  public static currentPanel: DependencyGraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private static outputChannel: vscode.OutputChannel;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private store: GraphStore,
    private workspaceRoot: string
  ) {
    this.panel = panel;
    
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
    store: GraphStore,
    outputChannel: vscode.OutputChannel
  ) {
    DependencyGraphPanel.outputChannel = outputChannel;
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DependencyGraphPanel.currentPanel) {
      DependencyGraphPanel.currentPanel.panel.reveal(column);
      DependencyGraphPanel.currentPanel.updateGraph();
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('No workspace folder open');
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'radiumDependencyGraph',
      'Dependency Graph',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    DependencyGraphPanel.currentPanel = new DependencyGraphPanel(
      panel,
      extensionUri,
      store,
      workspaceFolders[0].uri.fsPath
    );

    DependencyGraphPanel.currentPanel.updateGraph();
  }

  private handleMessage(message: any) {
    switch (message.type) {
      case 'ready':
        this.updateGraph();
        break;
      case 'file:open':
        this.openFile(message.filePath);
        break;
      case 'file:copy':
        vscode.env.clipboard.writeText(message.filePath);
        vscode.window.showInformationMessage(`Copied: ${message.filePath}`);
        break;
    }
  }

  private openFile(filePath: string) {
    const fullPath = path.join(this.workspaceRoot, filePath);
    vscode.workspace.openTextDocument(fullPath).then(doc => {
      vscode.window.showTextDocument(doc);
    });
  }

  public updateGraph() {
    DependencyGraphPanel.outputChannel.appendLine('[DependencyGraphPanel] updateGraph called');
    const graphData = this.buildDependencyGraph();
    DependencyGraphPanel.outputChannel.appendLine(`[DependencyGraphPanel] Sending graph data: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);
    
    if (graphData.nodes.length === 0) {
      vscode.window.showWarningMessage(
        'No files found in the dependency graph. Make sure the project is indexed (Cmd/Ctrl+Shift+P → "Radium: Re-index Codebase")'
      );
    }
    
    this.panel.webview.postMessage({
      type: 'graph:update',
      data: graphData
    });
  }

  private buildDependencyGraph(): DependencyGraphData {
    const files = this.store.getAllFiles();
    const allNodes = this.store.getAllNodes();
    const allEdges = this.store.getAllEdges();
    
    DependencyGraphPanel.outputChannel.appendLine(`[DependencyGraphPanel] Store data: ${files.length} files, ${allNodes.length} nodes, ${allEdges.length} edges`);

    // Build a map of file paths to their nodes
    const fileNodeMap = new Map<string, Node[]>();
    for (const node of allNodes) {
      if (!fileNodeMap.has(node.path)) {
        fileNodeMap.set(node.path, []);
      }
      fileNodeMap.get(node.path)!.push(node);
    }

    // Build a map to track file-to-file dependencies
    const fileDependencies = new Map<string, Set<string>>();
    const fileInDegree = new Map<string, number>();
    const fileOutDegree = new Map<string, number>();

    // Initialize maps
    for (const file of files) {
      fileDependencies.set(file.path, new Set());
      fileInDegree.set(file.path, 0);
      fileOutDegree.set(file.path, 0);
    }

    // Process edges to determine file-to-file dependencies
    for (const edge of allEdges) {
      const srcNode = this.store.getNodeById(edge.src);
      const dstNode = this.store.getNodeById(edge.dst);

      if (srcNode && dstNode && srcNode.path !== dstNode.path) {
        // Different files - this is a cross-file dependency
        const srcPath = srcNode.path;
        const dstPath = dstNode.path;

        if (!fileDependencies.get(srcPath)?.has(dstPath)) {
          fileDependencies.get(srcPath)?.add(dstPath);
          fileOutDegree.set(srcPath, (fileOutDegree.get(srcPath) || 0) + 1);
          fileInDegree.set(dstPath, (fileInDegree.get(dstPath) || 0) + 1);
        }
      }
    }

    // Build dependency nodes
    const nodes: DependencyNode[] = files.map(file => {
      const relativePath = path.relative(this.workspaceRoot, file.path);
      const fileName = path.basename(file.path);
      
      return {
        id: `file:${relativePath}`,
        type: 'file',
        label: fileName,
        path: relativePath,
        lang: file.lang,
        size: file.size,
        inDegree: fileInDegree.get(file.path) || 0,
        outDegree: fileOutDegree.get(file.path) || 0
      };
    });

    // Build dependency edges with aggregated weights
    const edges: DependencyEdge[] = [];
    const edgeWeights = new Map<string, { srcPath: string, dstPath: string, type: EdgeKind, weight: number }>();

    for (const edge of allEdges) {
      const srcNode = this.store.getNodeById(edge.src);
      const dstNode = this.store.getNodeById(edge.dst);

      if (srcNode && dstNode && srcNode.path !== dstNode.path) {
        const srcPath = path.relative(this.workspaceRoot, srcNode.path);
        const dstPath = path.relative(this.workspaceRoot, dstNode.path);
        // Use a delimiter that won't appear in file paths
        const edgeKey = `${srcPath}|||${dstPath}|||${edge.kind}`;

        if (!edgeWeights.has(edgeKey)) {
          edgeWeights.set(edgeKey, { srcPath, dstPath, type: edge.kind, weight: 0 });
        }
        
        const edgeData = edgeWeights.get(edgeKey)!;
        edgeData.weight += edge.weight;
      }
    }

    // Convert to edge array
    for (const [key, data] of edgeWeights.entries()) {
      edges.push({
        source: `file:${data.srcPath}`,
        target: `file:${data.dstPath}`,
        type: data.type,
        weight: data.weight
      });
    }
    
    DependencyGraphPanel.outputChannel.appendLine(`[DependencyGraphPanel] Built graph: ${nodes.length} nodes, ${edges.length} edges`);

    return { nodes, edges };
  }

  private dispose() {
    DependencyGraphPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private getHtmlContent(extensionUri: vscode.Uri): string {
    const nonce = this.getNonce();
    const cspSource = this.panel.webview.cspSource;

    return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Dependency Graph</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    #toolbar {
      display: flex;
      gap: 8px;
      padding: 8px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    .toolbar-group {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .toolbar-separator {
      width: 1px;
      height: 24px;
      background: var(--vscode-panel-border);
      margin: 0 4px;
    }

    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      cursor: pointer;
      border-radius: 2px;
      font-size: 13px;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button:active {
      opacity: 0.8;
    }

    select {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 4px 8px;
      border-radius: 2px;
      font-size: 13px;
    }

    label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    #container {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    #graph {
      width: 100%;
      height: 100%;
    }

    #stats {
      position: absolute;
      top: 10px;
      right: 10px;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 12px;
      border-radius: 4px;
      font-size: 12px;
      max-width: 250px;
      pointer-events: none;
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }

    .stat-label {
      color: var(--vscode-descriptionForeground);
    }

    .stat-value {
      font-weight: bold;
      color: var(--vscode-textLink-foreground);
    }

    #tooltip {
      position: absolute;
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s;
      z-index: 1000;
      max-width: 300px;
    }

    #tooltip.visible {
      opacity: 1;
    }

    .tooltip-title {
      font-weight: bold;
      margin-bottom: 4px;
      color: var(--vscode-textLink-foreground);
    }

    .tooltip-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 2px;
      font-size: 11px;
    }

    .node {
      cursor: pointer;
      stroke: var(--vscode-panel-border);
      stroke-width: 1.5px;
    }

    .node:hover {
      stroke: var(--vscode-textLink-foreground);
      stroke-width: 2.5px;
    }

    .node-label {
      font-size: 10px;
      fill: var(--vscode-editor-foreground);
      pointer-events: none;
      text-anchor: middle;
    }

    .link {
      stroke: var(--vscode-panel-border);
      stroke-opacity: 0.4;
      fill: none;
    }

    .link.imports {
      stroke: #4a9eff;
    }

    .link.calls {
      stroke: #ff6b6b;
    }

    .link.inherits {
      stroke: #51cf66;
    }

    .link.defines {
      stroke: #ffd43b;
    }

    .link.modifies {
      stroke: #ff8787;
    }

    .link.tests {
      stroke: #a78bfa;
    }

    .link.owns {
      stroke: #ffa94d;
    }

    .link.mentions {
      stroke: #868e96;
    }

  </style>
</head>
<body>
  <div id="toolbar">
    <div class="toolbar-group">
      <button id="btn-reset">Reset View</button>
      <button id="btn-fit">Fit to Screen</button>
    </div>
    <div class="toolbar-separator"></div>
    <div class="toolbar-group">
      <label for="layout-select">Layout:</label>
      <select id="layout-select">
        <option value="force">Force-Directed</option>
        <option value="hierarchical">Hierarchical</option>
        <option value="circular">Circular</option>
      </select>
    </div>
    <div class="toolbar-separator"></div>
    <div class="toolbar-group">
      <label for="filter-select">Filter:</label>
      <select id="filter-select">
        <option value="all">All Files</option>
        <option value="high-deps">High Dependencies (>5)</option>
        <option value="high-dependents">High Dependents (>5)</option>
        <option value="isolated">Isolated Files</option>
      </select>
    </div>
  </div>

  <div id="container">
    <svg id="graph"></svg>
    <div id="stats">
      <div class="stat-row">
        <span class="stat-label">Files:</span>
        <span class="stat-value" id="stat-files">0</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Dependencies:</span>
        <span class="stat-value" id="stat-deps">0</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Avg Dependencies:</span>
        <span class="stat-value" id="stat-avg">0</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Max Dependencies:</span>
        <span class="stat-value" id="stat-max">0</span>
      </div>
    </div>
    <div id="tooltip"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    
    // D3.js v7 minimal implementation for force simulation
    const d3 = {
      forceSimulation: (nodes) => {
        const simulation = {
          nodes: nodes || [],
          forces: {},
          _alpha: 1,
          alphaMin: 0.001,
          alphaDecay: 0.01,
          alphaTarget: 0,
          velocityDecay: 0.4,
          _tickCount: 0,
          
          alpha(value) {
            if (value === undefined) return this._alpha;
            this._alpha = value;
            return this;
          },
          
          force(name, force) {
            if (force === undefined) return this.forces[name];
            this.forces[name] = force;
            // Initialize the force with the nodes if it has an initialize method
            if (force && force.initialize) {
              console.log('[DependencyGraph] Initializing force:', name, 'with', this.nodes.length, 'nodes');
              force.initialize(this.nodes);
            } else {
              console.warn('[DependencyGraph] Force', name, 'has no initialize method');
            }
            return this;
          },
          
          tick() {
            this._alpha += (this.alphaTarget - this._alpha) * this.alphaDecay;
            
            for (const name in this.forces) {
              this.forces[name](this._alpha);
            }
            
            let nanCount = 0;
            for (const node of this.nodes) {
              // Guard against NaN in velocities only
              if (isNaN(node.vx) || node.vx === undefined) node.vx = 0;
              if (isNaN(node.vy) || node.vy === undefined) node.vy = 0;
              
              node.vx *= this.velocityDecay;
              node.vy *= this.velocityDecay;
              node.x += node.vx;
              node.y += node.vy;
              
              // Guard against NaN in positions AFTER update
              if (isNaN(node.x) || node.x === undefined) {
                node.x = 400;
                nanCount++;
              }
              if (isNaN(node.y) || node.y === undefined) {
                node.y = 300;
                nanCount++;
              }
            }
            
            if (nanCount > 0) {
              console.warn('[DependencyGraph] NaN positions detected:', nanCount);
            }
            
            this._tickCount++;
            return this;
          },
          
          on(type, callback) {
            if (type === 'tick') {
              this.tickCallback = callback;
            } else if (type === 'end') {
              this.endCallback = callback;
            }
            return this;
          },
          
          restart() {
            this._alpha = 1;
            if (this.timer) clearInterval(this.timer);
            this.timer = setInterval(() => {
              this.tick();
              if (this.tickCallback) this.tickCallback();
              if (this._alpha < this.alphaMin) {
                clearInterval(this.timer);
                this.timer = null;
                console.log('[DependencyGraph] Simulation stopped at alpha:', this._alpha);
                if (this.endCallback) this.endCallback();
              }
            }, 16);
            return this;
          },
          
          stop() {
            if (this.timer) clearInterval(this.timer);
            return this;
          }
        };
        return simulation;
      },
      
      forceLink: (links) => {
        let targetDistance = 100;
        let idAccessor = d => d.id;
        
        const force = (alpha) => {
          if (!links || links.length === 0) return;
          
          for (const link of links) {
            // Safety check: ensure source and target exist and have positions
            if (!link.source || !link.target || 
                link.source.x === undefined || link.target.x === undefined) {
              continue;
            }
            
            const dx = link.target.x - link.source.x;
            const dy = link.target.y - link.source.y;
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;
            const strength = 0.1 * alpha;
            const bias = 0.5;
            
            const forceAmount = (distance - targetDistance) * strength;
            const fx = (dx / distance) * forceAmount;
            const fy = (dy / distance) * forceAmount;
            
            link.target.vx -= fx * bias;
            link.target.vy -= fy * bias;
            link.source.vx += fx * (1 - bias);
            link.source.vy += fy * (1 - bias);
          }
        };
        
        force.id = (accessor) => {
          if (accessor === undefined) return idAccessor;
          idAccessor = accessor;
          return force;
        };
        
        force.distance = (dist) => {
          if (dist === undefined) return targetDistance;
          targetDistance = dist;
          return force;
        };
        
        force.initialize = (nodes) => {
          // forceLink doesn't need the nodes array since it works with links
          // but we need this method to exist
        };
        
        return force;
      },
      
      forceManyBody: () => {
        let strengthValue = -30;
        let nodes = [];
        const force = (alpha) => {
          if (nodes.length === 0) return;
          
          for (let i = 0; i < nodes.length; i++) {
            if (!nodes[i] || nodes[i].x === undefined) continue;
            for (let j = i + 1; j < nodes.length; j++) {
              if (!nodes[j] || nodes[j].x === undefined) continue;
              const dx = nodes[j].x - nodes[i].x;
              const dy = nodes[j].y - nodes[i].y;
              const distance = Math.sqrt(dx * dx + dy * dy) || 1;
              const repulsion = strengthValue * alpha / (distance * distance);
              const fx = (dx / distance) * repulsion;
              const fy = (dy / distance) * repulsion;
              
              nodes[i].vx -= fx;
              nodes[i].vy -= fy;
              nodes[j].vx += fx;
              nodes[j].vy += fy;
            }
          }
        };
        force.initialize = (n) => { nodes = n; };
        force.strength = (s) => {
          if (s === undefined) return strengthValue;
          strengthValue = s;
          return force;
        };
        return force;
      },
      
      forceCenter: (x, y) => {
        let nodes = [];
        const force = (alpha) => {
          if (nodes.length === 0) return;
          let sx = 0, sy = 0;
          let count = 0;
          
          for (const node of nodes) {
            if (!node || node.x === undefined) continue;
            sx += node.x;
            sy += node.y;
            count++;
          }
          
          if (count === 0) return;
          
          sx = sx / count - x;
          sy = sy / count - y;
          
          for (const node of nodes) {
            if (!node || node.x === undefined) continue;
            node.x -= sx;
            node.y -= sy;
          }
        };
        force.initialize = (n) => { nodes = n; };
        return force;
      },
      
      forceCollide: (radius) => {
        let nodes = [];
        const force = (alpha) => {
          if (nodes.length === 0) return;
          
          for (let i = 0; i < nodes.length; i++) {
            if (!nodes[i] || nodes[i].x === undefined) continue;
            for (let j = i + 1; j < nodes.length; j++) {
              if (!nodes[j] || nodes[j].x === undefined) continue;
              const dx = nodes[j].x - nodes[i].x;
              const dy = nodes[j].y - nodes[i].y;
              const distance = Math.sqrt(dx * dx + dy * dy) || 1; // Guard against zero
              const minDistance = radius * 2;
              
              if (distance < minDistance && distance > 0) {
                const strength = 0.5 * alpha;
                const collisionForce = (minDistance - distance) / distance * strength;
                const fx = (dx / distance) * collisionForce;
                const fy = (dy / distance) * collisionForce;
                
                // Modify velocities, NOT positions
                nodes[i].vx -= fx;
                nodes[i].vy -= fy;
                nodes[j].vx += fx;
                nodes[j].vy += fy;
              }
            }
          }
        };
        force.initialize = (n) => { nodes = n; };
        return force;
      },
      
      drag: () => {
        let subject;
        return {
          subject: (s) => { subject = s; return this; },
          on: () => this
        };
      }
    };

    let graphData = { nodes: [], edges: [] };
    let simulation = null;
    let transform = { x: 0, y: 0, k: 1 };
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };
    let draggedNode = null;

    const svg = document.getElementById('graph');
    const tooltip = document.getElementById('tooltip');
    const container = document.getElementById('container');

    function init() {
      setupEventListeners();
      vscode.postMessage({ type: 'ready' });
    }

    function setupEventListeners() {
      document.getElementById('btn-reset').addEventListener('click', resetView);
      document.getElementById('btn-fit').addEventListener('click', fitToScreen);
      document.getElementById('layout-select').addEventListener('change', (e) => {
        applyLayout(e.target.value);
      });
      document.getElementById('filter-select').addEventListener('change', (e) => {
        applyFilter(e.target.value);
      });

      svg.addEventListener('mousedown', onMouseDown);
      svg.addEventListener('mousemove', onMouseMove);
      svg.addEventListener('mouseup', onMouseUp);
      svg.addEventListener('wheel', onWheel);
      svg.addEventListener('click', onNodeClick);
      svg.addEventListener('mouseleave', () => {
        tooltip.classList.remove('visible');
      });
    }

    function onMouseDown(e) {
      const target = e.target;
      if (target.classList && target.classList.contains('node')) {
        e.stopPropagation();
        draggedNode = target.__data__;
        draggedNode.fx = draggedNode.x;
        draggedNode.fy = draggedNode.y;
      } else if (target === svg || target.tagName === 'line' || target.tagName === 'LINE' || 
                 target.tagName === 'text' || target.tagName === 'TEXT' || 
                 target.tagName === 'svg' || target.tagName === 'SVG') {
        isDragging = true;
        dragStart = { 
          x: e.clientX, 
          y: e.clientY,
          transform: { x: transform.x, y: transform.y, k: transform.k }
        };
      }
    }

    function onMouseMove(e) {
      if (draggedNode) {
        const rect = svg.getBoundingClientRect();
        const x = (e.clientX - rect.left - transform.x) / transform.k;
        const y = (e.clientY - rect.top - transform.y) / transform.k;
        draggedNode.fx = x;
        draggedNode.fy = y;
        if (simulation) {
          simulation.alpha(0.3).restart();
        }
      } else if (isDragging) {
        const dx = e.clientX - dragStart.x;
        const dy = e.clientY - dragStart.y;
        transform.x = dragStart.transform.x + dx;
        transform.y = dragStart.transform.y + dy;
        
        // Limit pan to reasonable bounds
        const maxPan = 5000;
        transform.x = Math.max(-maxPan, Math.min(maxPan, transform.x));
        transform.y = Math.max(-maxPan, Math.min(maxPan, transform.y));
        
        render();
      }

      const target = e.target;
      if (target.classList.contains('node')) {
        showTooltip(target.__data__, e);
      } else {
        tooltip.classList.remove('visible');
      }
    }

    function onMouseUp() {
      if (draggedNode) {
        draggedNode.fx = null;
        draggedNode.fy = null;
        draggedNode = null;
      }
      if (isDragging) {
        isDragging = false;
      }
    }

    function onNodeClick(e) {
      const target = e.target;
      if (target.classList && target.classList.contains('node') && target.__data__) {
        const node = target.__data__;
        vscode.postMessage({
          type: 'file:open',
          filePath: node.path
        });
      }
    }

    function onWheel(e) {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newK = Math.max(0.1, Math.min(5, transform.k * delta));
      
      transform.x = x - (x - transform.x) * (newK / transform.k);
      transform.y = y - (y - transform.y) * (newK / transform.k);
      transform.k = newK;
      
      render();
    }

    function showTooltip(node, e) {
      if (!node) return;
      tooltip.innerHTML = 
        '<div class="tooltip-title">' + node.label + '</div>' +
        '<div class="tooltip-row">' +
          '<span>Path:</span>' +
          '<span>' + node.path + '</span>' +
        '</div>' +
        '<div class="tooltip-row">' +
          '<span>Language:</span>' +
          '<span>' + node.lang + '</span>' +
        '</div>' +
        '<div class="tooltip-row">' +
          '<span>Dependencies:</span>' +
          '<span>' + node.outDegree + '</span>' +
        '</div>' +
        '<div class="tooltip-row">' +
          '<span>Dependents:</span>' +
          '<span>' + node.inDegree + '</span>' +
        '</div>';
      tooltip.style.left = e.clientX + 10 + 'px';
      tooltip.style.top = e.clientY + 10 + 'px';
      tooltip.classList.add('visible');
    }

    function updateGraph(data) {
      console.log('[DependencyGraph] updateGraph called with', data.nodes.length, 'nodes', data.edges.length, 'edges');
      
      if (!data.nodes || data.nodes.length === 0) {
        console.warn('[DependencyGraph] No nodes received!');
        svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#868e96" font-size="16">No dependency data available. Make sure the project is indexed.</text>';
        return;
      }
      
      graphData = data;
      
      // Initialize node positions if not set
      const width = container.clientWidth;
      const height = container.clientHeight;
      console.log('[DependencyGraph] Container size:', width, 'x', height);
      
      graphData.nodes.forEach(node => {
        if (node.x === undefined) node.x = width / 2;
        if (node.y === undefined) node.y = height / 2;
      });
      
      console.log('[DependencyGraph] First node position:', graphData.nodes[0]?.x, graphData.nodes[0]?.y);
      
      applyFilter(document.getElementById('filter-select').value);
      updateStats();
    }

    function applyFilter(filterType) {
      let filteredNodes = [...graphData.nodes];
      
      switch (filterType) {
        case 'high-deps':
          filteredNodes = filteredNodes.filter(n => n.outDegree > 5);
          break;
        case 'high-dependents':
          filteredNodes = filteredNodes.filter(n => n.inDegree > 5);
          break;
        case 'isolated':
          filteredNodes = filteredNodes.filter(n => n.inDegree === 0 && n.outDegree === 0);
          break;
      }
      
      console.log('[DependencyGraph] Filter:', filterType, '- nodes:', graphData.nodes.length, '->', filteredNodes.length);
      
      if (filteredNodes.length === 0) {
        console.warn('[DependencyGraph] Filter removed all nodes!');
        svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#868e96" font-size="16">No nodes match the current filter. Try "All Files".</text>';
        return;
      }
      
      const nodeIds = new Set(filteredNodes.map(n => n.id));
      const filteredEdges = graphData.edges.filter(e => 
        nodeIds.has(e.source) && nodeIds.has(e.target)
      );
      
      // Update graphData with filtered data
      const filteredData = { nodes: filteredNodes, edges: filteredEdges };
      graphData = filteredData;
      
      applyLayout(document.getElementById('layout-select').value);
    }

    function applyLayout(layoutType) {
      const width = container.clientWidth;
      const height = container.clientHeight;
      
      console.log('[DependencyGraph] applyLayout:', layoutType, 'size:', width, 'x', height);
      console.log('[DependencyGraph] Nodes to layout:', graphData.nodes.length);
      
      if (layoutType === 'hierarchical') {
        applyHierarchicalLayout(width, height);
      } else if (layoutType === 'circular') {
        applyCircularLayout(width, height);
      } else {
        applyForceLayout(width, height);
      }
    }

    function applyForceLayout(width, height) {
      console.log('[DependencyGraph] applyForceLayout - width:', width, 'height:', height);
      if (simulation) simulation.stop();
      
      // Ensure valid dimensions
      if (width <= 0 || height <= 0) {
        console.warn('[DependencyGraph] Invalid container dimensions, using defaults');
        width = 800;
        height = 600;
      }
      
      // Work directly with graphData.nodes - ALWAYS randomize positions for force layout
      graphData.nodes.forEach((n, i) => {
        // Always set random positions for force layout to spread nodes out
        n.x = width/2 + (Math.random() - 0.5) * width * 0.8;
        n.y = height/2 + (Math.random() - 0.5) * height * 0.8;
        // Always reset velocities
        n.vx = 0;
        n.vy = 0;
        
        if (i === 0) {
          console.log('[DependencyGraph] First node after init:', n.x.toFixed(1), n.y.toFixed(1));
        }
      });
      
      console.log('[DependencyGraph] Initializing simulation with', graphData.nodes.length, 'nodes');
      console.log('[DependencyGraph] Sample node:', graphData.nodes[0]);
      
      // Create node ID to object map for link resolution
      const nodeById = new Map();
      graphData.nodes.forEach(node => nodeById.set(node.id, node));
      
      // Resolve link source/target from IDs to node objects
      const links = graphData.edges.map(e => ({
        source: nodeById.get(e.source),
        target: nodeById.get(e.target),
        type: e.type,
        weight: e.weight
      })).filter(l => l.source && l.target);
      
      console.log('[DependencyGraph] Resolved', links.length, 'links');
      
      simulation = d3.forceSimulation(graphData.nodes);
      
      const linkForce = d3.forceLink(links)
        .id(d => d.id)
        .distance(150);
      const chargeForce = d3.forceManyBody().strength(-800);
      const centerForce = d3.forceCenter(width / 2, height / 2);
      const collideForce = d3.forceCollide(40);
      
      simulation
        .force('link', linkForce)
        .force('charge', chargeForce)
        .force('center', centerForce)
        .force('collide', collideForce);
      
      let tickCount = 0;
      simulation.on('tick', () => {
        tickCount++;
        if (tickCount % 10 === 0 && graphData.nodes.length > 0) {
          console.log('[DependencyGraph] Tick', tickCount, 'alpha:', simulation.alpha().toFixed(3), 
                      'sample node pos:', graphData.nodes[0].x.toFixed(1), graphData.nodes[0].y.toFixed(1),
                      'vel:', graphData.nodes[0].vx.toFixed(3), graphData.nodes[0].vy.toFixed(3));
        }
        render();
      });
      
      simulation.on('end', () => {
        console.log('[DependencyGraph] Simulation ended after', tickCount, 'ticks');
        console.log('[DependencyGraph] Final positions:', graphData.nodes.slice(0, 3).map(n => 
          '(' + n.x.toFixed(1) + ', ' + n.y.toFixed(1) + ')').join(', '));
        // Auto-fit after initial layout completes
        setTimeout(() => fitToScreen(), 100);
      });
      
      console.log('[DependencyGraph] Starting simulation...');
      simulation.alpha(1).restart();
    }

    function applyHierarchicalLayout(width, height) {
      if (simulation) simulation.stop();
      
      // Simple hierarchical layout based on dependency depth
      const levels = new Map();
      const visited = new Set();
      
      function getLevel(nodeId, depth = 0) {
        if (visited.has(nodeId)) return levels.get(nodeId) || 0;
        visited.add(nodeId);
        
        const outEdges = graphData.edges.filter(e => e.source === nodeId);
        if (outEdges.length === 0) {
          levels.set(nodeId, depth);
          return depth;
        }
        
        const maxChildLevel = Math.max(...outEdges.map(e => getLevel(e.target, depth + 1)));
        levels.set(nodeId, depth);
        return maxChildLevel;
      }
      
      graphData.nodes.forEach(n => getLevel(n.id));
      
      const maxLevel = Math.max(...Array.from(levels.values()));
      const levelNodes = new Map();
      
      for (const [nodeId, level] of levels.entries()) {
        if (!levelNodes.has(level)) levelNodes.set(level, []);
        levelNodes.get(level).push(nodeId);
      }
      
      graphData.nodes.forEach(node => {
        const level = levels.get(node.id) || 0;
        const nodesInLevel = levelNodes.get(level) || [];
        const index = nodesInLevel.indexOf(node.id);
        
        node.x = (width / (maxLevel + 1)) * level + 50;
        node.y = (height / (nodesInLevel.length + 1)) * (index + 1);
      });
      
      render();
    }

    function applyCircularLayout(width, height) {
      if (simulation) simulation.stop();
      
      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) / 2 - 100;
      
      graphData.nodes.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / graphData.nodes.length;
        node.x = centerX + radius * Math.cos(angle);
        node.y = centerY + radius * Math.sin(angle);
      });
      
      render();
    }

    function renderGraph(data) {
      // This function is kept for backward compatibility but now just calls applyLayout
      graphData = data;
      
      // Initialize positions if needed
      const width = container.clientWidth;
      const height = container.clientHeight;
      graphData.nodes.forEach(node => {
        if (node.x === undefined) node.x = width / 2;
        if (node.y === undefined) node.y = height / 2;
      });
      
      applyLayout(document.getElementById('layout-select').value);
    }

    function render() {
      const width = container.clientWidth;
      const height = container.clientHeight;
      
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      
      let html = '';
      
      let renderedNodes = 0;
      let skippedNodes = 0;
      
      // Render links
      for (const edge of graphData.edges) {
        const source = graphData.nodes.find(n => n.id === edge.source);
        const target = graphData.nodes.find(n => n.id === edge.target);
        
        if (source && target && source.x !== undefined && target.x !== undefined) {
          const x1 = source.x * transform.k + transform.x;
          const y1 = source.y * transform.k + transform.y;
          const x2 = target.x * transform.k + transform.x;
          const y2 = target.y * transform.k + transform.y;
          
          html += '<line class="link ' + edge.type + '" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke-width="' + Math.max(1, edge.weight * 0.5) + '" />';
        }
      }
      
      // Render nodes
      for (const node of graphData.nodes) {
        // Skip nodes without valid positions
        if (node.x === undefined || node.y === undefined || isNaN(node.x) || isNaN(node.y)) {
          skippedNodes++;
          continue;
        }
        
        renderedNodes++;
        
        const x = node.x * transform.k + transform.x;
        const y = node.y * transform.k + transform.y;
        const radius = Math.max(5, Math.min(20, 5 + node.inDegree + node.outDegree));
        
        const color = getNodeColor(node);
        
        html += '<circle class="node" cx="' + x + '" cy="' + y + '" r="' + radius + '" fill="' + color + '" />';
        html += '<text class="node-label" x="' + x + '" y="' + (y + radius + 12) + '">' + node.label + '</text>';
      }
      
      if (renderedNodes === 0 && graphData.nodes.length > 0) {
        console.warn('[DependencyGraph] No nodes rendered! Total:', graphData.nodes.length, 'Skipped:', skippedNodes);
        console.warn('[DependencyGraph] Sample node:', graphData.nodes[0]);
      }
      
      svg.innerHTML = html;
      
      // Attach data to nodes AFTER setting innerHTML
      const circles = svg.querySelectorAll('.node');
      let nodeIndex = 0;
      for (const node of graphData.nodes) {
        if (node.x === undefined || node.y === undefined || isNaN(node.x) || isNaN(node.y)) {
          continue;
        }
        if (circles[nodeIndex]) {
          circles[nodeIndex].__data__ = node;
        }
        nodeIndex++;
      }
    }

    function getNodeColor(node) {
      const total = node.inDegree + node.outDegree;
      if (total === 0) return '#868e96';
      if (total > 10) return '#ff6b6b';
      if (total > 5) return '#ffa94d';
      return '#4a9eff';
    }

    function resetView() {
      transform = { x: 0, y: 0, k: 1 };
      render();
    }

    function fitToScreen() {
      if (graphData.nodes.length === 0) return;
      
      const padding = 50;
      const width = container.clientWidth;
      const height = container.clientHeight;
      
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      
      for (const node of graphData.nodes) {
        minX = Math.min(minX, node.x);
        maxX = Math.max(maxX, node.x);
        minY = Math.min(minY, node.y);
        maxY = Math.max(maxY, node.y);
      }
      
      const graphWidth = maxX - minX;
      const graphHeight = maxY - minY;
      
      const scaleX = (width - padding * 2) / graphWidth;
      const scaleY = (height - padding * 2) / graphHeight;
      const scale = Math.min(scaleX, scaleY, 1);
      
      transform.k = scale;
      transform.x = (width - (minX + maxX) * scale) / 2;
      transform.y = (height - (minY + maxY) * scale) / 2;
      
      render();
    }

    function updateStats() {
      document.getElementById('stat-files').textContent = graphData.nodes.length;
      document.getElementById('stat-deps').textContent = graphData.edges.length;
      
      const avgDeps = graphData.nodes.length > 0
        ? (graphData.nodes.reduce((sum, n) => sum + n.outDegree, 0) / graphData.nodes.length).toFixed(1)
        : 0;
      document.getElementById('stat-avg').textContent = avgDeps;
      
      const maxDeps = graphData.nodes.length > 0
        ? Math.max(...graphData.nodes.map(n => n.outDegree))
        : 0;
      document.getElementById('stat-max').textContent = maxDeps;
    }

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'graph:update':
          updateGraph(message.data);
          break;
      }
    });

    init();
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}


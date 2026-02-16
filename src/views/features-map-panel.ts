import * as vscode from 'vscode';
import { GraphStore } from '../store/schema';
import { FeaturesConfigLoader, FeaturesConfig, FeatureConfig, FeatureCapability, FeatureStatus } from '../config/features-config';
import * as path from 'path';

interface FeaturesGraphNode {
  id: string;
  kind: 'app' | 'feature' | 'capability' | 'file';
  name: string;
  description?: string;
  status?: FeatureStatus;
  filePath?: string;
  parentId?: string;
  color?: string;
}

interface FeaturesGraphEdge {
  source: string;
  target: string;
  kind: 'contains';
}

interface FeaturesGraphData {
  nodes: FeaturesGraphNode[];
  edges: FeaturesGraphEdge[];
}

export class FeaturesMapPanel {
  public static currentPanel: FeaturesMapPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private static outputChannel: vscode.OutputChannel;
  private workspaceRoot: string;
  private configLoader: FeaturesConfigLoader;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private store: GraphStore,
    configLoader: FeaturesConfigLoader
  ) {
    this.configLoader = configLoader;
    this.panel = panel;
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    this.workspaceRoot = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
    
    FeaturesMapPanel.outputChannel.appendLine('Registering message handler');
    const messageHandler = this.panel.webview.onDidReceiveMessage(
      message => {
        FeaturesMapPanel.outputChannel.appendLine(`Message received: ${message.type}`);
        this.handleMessage(message);
      },
      null,
      this.disposables
    );
    FeaturesMapPanel.outputChannel.appendLine(`Message handler registered: ${!!messageHandler}`);

    this.panel.webview.html = this.getHtmlContent(extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(extensionUri: vscode.Uri, store: GraphStore, configLoader: FeaturesConfigLoader) {
    if (!FeaturesMapPanel.outputChannel) {
      FeaturesMapPanel.outputChannel = vscode.window.createOutputChannel('Radium Features View');
    }
    
    FeaturesMapPanel.outputChannel.appendLine('createOrShow called');
    
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (FeaturesMapPanel.currentPanel) {
      FeaturesMapPanel.outputChannel.appendLine('Panel already exists, revealing');
      // Reload config in case it was created/modified
      configLoader.load();
      FeaturesMapPanel.currentPanel.panel.reveal(column);
      // Re-send graph data when panel is revealed
      FeaturesMapPanel.currentPanel.updateGraph();
      return;
    }
    
    FeaturesMapPanel.outputChannel.appendLine('Creating new panel');

    // Reload config in case it was created/modified since extension activation
    FeaturesMapPanel.outputChannel.appendLine('Reloading features config...');
    const loadedConfig = configLoader.load();
    FeaturesMapPanel.outputChannel.appendLine(`Config loaded: ${!!loadedConfig}`);

    const panel = vscode.window.createWebviewPanel(
      'featuresMap',
      'Radium: Features View',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    FeaturesMapPanel.currentPanel = new FeaturesMapPanel(panel, extensionUri, store, configLoader);
  }

  private async handleMessage(message: any) {
    console.log('[Radium Features] Received message:', message.type);
    switch (message.type) {
      case 'file:open':
        await this.handleFileOpen(message.filePath);
        break;
      case 'copy:prompt':
        await this.handleCopyPrompt();
        break;
      case 'ready':
        this.updateGraph();
        break;
      default:
        console.log('[Radium Features] Unknown message type:', message.type);
    }
  }

  private async handleCopyPrompt() {
    const prompt = `Analyze this codebase and generate or update the .radium/radium-features.yaml file.

The file should document the product features and capabilities using this structure:

\`\`\`yaml
spec:
  apps:  # Optional - only if project has multiple apps
    - app_key:
        name: App Display Name
        description: Optional description
        features:
          - feature_key1
          - feature_key2

  features:
    - feature_key:
        name: Feature Display Name
        description: What this feature does
        status: completed  # completed | in_progress | planned
        capabilities:
          - capability_key:
              name: Capability Name
              description: What this capability does
              files:
                - src/path/to/file.ts
        files:  # Feature-level files not tied to a specific capability
          - src/shared/file.ts
\`\`\`

Instructions:
1. Identify the main product features by analyzing the codebase structure, routes, components, and business logic
2. For each feature, identify its sub-capabilities (distinct functionalities within the feature)
3. Map the source files that implement each capability
4. Set appropriate status based on code completeness (TODOs, stubs = in_progress or planned)
5. Group features under apps only if the project contains multiple distinct applications

Focus on user-facing product features, not technical infrastructure.`;

    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage('Prompt copied to clipboard');
  }

  private async handleFileOpen(filePath: string) {
    console.log(`[Radium Features] Opening file: ${filePath}`);
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open');
      }
      
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      
      let absolutePath: string;
      if (filePath.startsWith(workspaceRoot)) {
        absolutePath = filePath;
      } else {
        const relativePath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
        absolutePath = path.join(workspaceRoot, relativePath);
      }
      
      console.log(`[Radium Features] Resolved path: ${absolutePath}`);
      const uri = vscode.Uri.file(absolutePath);
      await vscode.window.showTextDocument(uri);
    } catch (error) {
      console.error(`[Radium Features] Failed to open file:`, error);
      vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
    }
  }

  public updateGraph() {
    const config = this.configLoader.getConfig();
    
    if (!config) {
      FeaturesMapPanel.outputChannel.appendLine('No features configuration loaded');
      this.panel.webview.postMessage({
        type: 'features:update',
        data: { nodes: [], edges: [] },
        error: 'No radium-features.yaml configuration found. Create one in .radium/radium-features.yaml'
      });
      return;
    }

    const graphData = this.buildFeaturesGraph(config);
    FeaturesMapPanel.outputChannel.appendLine(`Built graph with ${graphData.nodes.length} nodes and ${graphData.edges.length} edges`);

    this.panel.webview.postMessage({
      type: 'features:update',
      data: graphData
    });
  }

  private buildFeaturesGraph(config: FeaturesConfig): FeaturesGraphData {
    const nodes: FeaturesGraphNode[] = [];
    const edges: FeaturesGraphEdge[] = [];
    
    const grouped = this.configLoader.getFeaturesGroupedByApp();
    
    // Color palette for features
    const featureColors = [
      '#FFE082', // Amber
      '#A5D6A7', // Green
      '#90CAF9', // Blue
      '#CE93D8', // Purple
      '#FFAB91', // Deep Orange
      '#80DEEA', // Cyan
      '#F48FB1', // Pink
      '#C5E1A5', // Light Green
    ];
    
    let colorIndex = 0;
    const getNextColor = () => {
      const color = featureColors[colorIndex % featureColors.length];
      colorIndex++;
      return color;
    };

    // Process apps and their features
    for (const { key: appKey, app, features } of grouped.apps) {
      // Add app node
      nodes.push({
        id: `app:${appKey}`,
        kind: 'app',
        name: app.name,
        description: app.description
      });

      // Add features for this app
      for (const { key: featureKey, feature } of features) {
        const featureColor = getNextColor();
        this.addFeatureNodes(nodes, edges, featureKey, feature, `app:${appKey}`, featureColor);
      }
    }

    // Process ungrouped features (no app)
    for (const { key: featureKey, feature } of grouped.ungroupedFeatures) {
      const featureColor = getNextColor();
      this.addFeatureNodes(nodes, edges, featureKey, feature, undefined, featureColor);
    }

    return { nodes, edges };
  }

  private addFeatureNodes(
    nodes: FeaturesGraphNode[],
    edges: FeaturesGraphEdge[],
    featureKey: string,
    feature: FeatureConfig,
    parentId: string | undefined,
    color: string
  ) {
    const featureId = `feature:${featureKey}`;
    
    // Add feature node
    nodes.push({
      id: featureId,
      kind: 'feature',
      name: feature.name,
      description: feature.description,
      status: feature.status,
      parentId,
      color
    });

    // Add edge from app to feature (if has parent)
    if (parentId) {
      edges.push({
        source: parentId,
        target: featureId,
        kind: 'contains'
      });
    }

    // Add capabilities
    for (const [capKey, capability] of Object.entries(feature.capabilities)) {
      const capId = `capability:${featureKey}:${capKey}`;
      
      nodes.push({
        id: capId,
        kind: 'capability',
        name: capability.name,
        description: capability.description,
        parentId: featureId,
        color
      });

      edges.push({
        source: featureId,
        target: capId,
        kind: 'contains'
      });

      // Add files for this capability
      for (const filePath of capability.files) {
        const fileId = `file:${featureKey}:${capKey}:${filePath}`;
        
        nodes.push({
          id: fileId,
          kind: 'file',
          name: path.basename(filePath),
          filePath,
          parentId: capId,
          color
        });

        edges.push({
          source: capId,
          target: fileId,
          kind: 'contains'
        });
      }
    }

    // Add feature-level files (not tied to a capability)
    for (const filePath of feature.files) {
      const fileId = `file:${featureKey}:${filePath}`;
      
      nodes.push({
        id: fileId,
        kind: 'file',
        name: path.basename(filePath),
        filePath,
        parentId: featureId,
        color
      });

      edges.push({
        source: featureId,
        target: fileId,
        kind: 'contains'
      });
    }
  }

  private dispose() {
    FeaturesMapPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private getHtmlContent(extensionUri: vscode.Uri): string {
    const nonce = this.getNonce();
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://d3js.org; connect-src 'none';">
  <title>Radium: Features View</title>
  <style>
    * {
      box-sizing: border-box;
    }
    body { 
      margin: 0; 
      padding: 0; 
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
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
    }
    .legend-title {
      font-weight: bold;
      margin-bottom: 8px;
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
    .legend-status {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .status-indicator {
      width: 12px;
      height: 12px;
      margin-right: 8px;
      border-radius: 2px;
      border: 2px solid;
    }
    .status-completed { border-color: #4CAF50; background: rgba(76, 175, 80, 0.2); }
    .status-in_progress { border-color: #FFC107; background: rgba(255, 193, 7, 0.2); }
    .status-planned { border-color: #9E9E9E; background: transparent; border-style: dashed; }
    .error-message {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: var(--vscode-editorWarning-background);
      border: 1px solid var(--vscode-editorWarning-border);
      padding: 20px;
      border-radius: 8px;
      text-align: center;
      max-width: 400px;
    }
    .error-message h3 {
      margin-top: 0;
      color: var(--vscode-editorWarning-foreground);
    }
    .error-message code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
    }
    .tooltip {
      position: absolute;
      background: var(--vscode-editorHoverWidget-background);
      border: 1px solid var(--vscode-editorHoverWidget-border);
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none;
      z-index: 2000;
      max-width: 300px;
    }
    .tooltip-title {
      font-weight: bold;
      margin-bottom: 4px;
    }
    .tooltip-description {
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="controls">
    <button class="control-button" id="reset-view-btn">Reset View</button>
    <button class="control-button" id="expand-all-btn">Expand All</button>
    <button class="control-button" id="collapse-all-btn">Collapse All</button>
    <button class="control-button" id="copy-prompt-btn">Copy Prompt</button>
  </div>
  <div class="legend">
    <div class="legend-title">Features View</div>
    <div class="legend-item">
      <div class="legend-color" style="background: #FFF9C4; border: 2px solid #F9A825;"></div>
      <span>App</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #FFE082;"></div>
      <span>Feature</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #E1BEE7;"></div>
      <span>Capability</span>
    </div>
    <div class="legend-item">
      <div class="legend-color" style="background: #BDBDBD;"></div>
      <span>File</span>
    </div>
    <div class="legend-status">
      <div class="legend-item">
        <div class="status-indicator status-completed"></div>
        <span>Completed</span>
      </div>
      <div class="legend-item">
        <div class="status-indicator status-in_progress"></div>
        <span>In Progress</span>
      </div>
      <div class="legend-item">
        <div class="status-indicator status-planned"></div>
        <span>Planned</span>
      </div>
    </div>
  </div>
  <div id="tooltip" class="tooltip" style="display: none;"></div>
  <div id="error-container"></div>

  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    
    let graphData = { nodes: [], edges: [] };
    let svg = null;
    let g = null;
    let width = 0;
    let height = 0;
    let transform = { k: 1, x: 0, y: 0 };
    let collapsedNodes = new Set();

    // Layout constants
    const PADDING = 20;
    const APP_PADDING = 30;
    const FEATURE_PADDING = 20;
    const CAPABILITY_PADDING = 15;
    const FILE_HEIGHT = 28;
    const FILE_WIDTH = 150;
    const FILE_GAP = 8;
    const CAPABILITY_GAP = 15;
    const FEATURE_GAP = 25;
    const HEADER_HEIGHT = 35;
    const CAP_HEADER_HEIGHT = 28;

    function initVisualization() {
      const container = d3.select('#map');
      width = window.innerWidth;
      height = window.innerHeight;

      svg = container.append('svg')
        .attr('width', width)
        .attr('height', height);

      g = svg.append('g');
      
      // Background for pan
      g.append('rect')
        .attr('class', 'zoom-background')
        .attr('width', 100000)
        .attr('height', 100000)
        .attr('x', -50000)
        .attr('y', -50000)
        .attr('fill', 'transparent')
        .lower();

      // Pan/zoom
      let isPanning = false;
      let startPoint = { x: 0, y: 0 };
      
      function updateTransform() {
        g.attr('transform', \`translate(\${transform.x},\${transform.y}) scale(\${transform.k})\`);
      }
      
      svg.on('wheel', (event) => {
        event.preventDefault();
        const delta = -event.deltaY;
        const scaleBy = delta > 0 ? 1.05 : 0.95;
        const newScale = Math.max(0.1, Math.min(5, transform.k * scaleBy));
        
        const rect = svg.node().getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        
        const factor = newScale / transform.k;
        transform.x = mouseX - (mouseX - transform.x) * factor;
        transform.y = mouseY - (mouseY - transform.y) * factor;
        transform.k = newScale;
        
        updateTransform();
      });
      
      svg.on('mousedown', (event) => {
        if (event.button !== 0) return;
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
        isPanning = false;
        svg.style('cursor', 'grab');
      });
      
      svg.on('mouseleave', () => {
        isPanning = false;
        svg.style('cursor', 'grab');
      });

      // Controls
      d3.select('#reset-view-btn').on('click', () => {
        transform = { k: 1, x: 0, y: 0 };
        updateTransform();
      });

      d3.select('#expand-all-btn').on('click', () => {
        collapsedNodes.clear();
        renderGraph();
      });

      d3.select('#collapse-all-btn').on('click', () => {
        graphData.nodes.filter(n => n.kind === 'feature').forEach(n => {
          collapsedNodes.add(n.id);
        });
        renderGraph();
      });

      const copyBtn = document.getElementById('copy-prompt-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'copy:prompt' });
        });
      }
    }

    function showError(message) {
      const container = d3.select('#error-container');
      container.html(\`
        <div class="error-message">
          <h3>No Features Configuration</h3>
          <p>To generate the features configuration:</p>
          <ol>
            <li>Click the <strong>"Copy Prompt"</strong> button above</li>
            <li>Paste the prompt in your coding agent chat</li>
            <li>The agent will analyze your codebase and create the <code>.radium/radium-features.yaml</code> file</li>
          </ol>
        </div>
      \`);
    }

    function hideError() {
      d3.select('#error-container').html('');
    }

    function showTooltip(event, node) {
      const tooltip = d3.select('#tooltip');
      let html = \`<div class="tooltip-title">\${node.name}</div>\`;
      if (node.description) {
        html += \`<div class="tooltip-description">\${node.description}</div>\`;
      }
      if (node.filePath) {
        html += \`<div class="tooltip-description">\${node.filePath}</div>\`;
      }
      if (node.status) {
        const statusLabel = node.status.replace('_', ' ');
        html += \`<div class="tooltip-description">Status: \${statusLabel}</div>\`;
      }
      
      tooltip.html(html)
        .style('display', 'block')
        .style('left', (event.pageX + 10) + 'px')
        .style('top', (event.pageY + 10) + 'px');
    }

    function hideTooltip() {
      d3.select('#tooltip').style('display', 'none');
    }

    function calculateLayout() {
      // Build hierarchy
      const nodeMap = new Map();
      graphData.nodes.forEach(n => {
        nodeMap.set(n.id, { ...n, children: [], _width: 0, _height: 0, _x: 0, _y: 0 });
      });

      // Link children to parents
      graphData.edges.forEach(e => {
        const parent = nodeMap.get(e.source);
        const child = nodeMap.get(e.target);
        if (parent && child) {
          parent.children.push(child);
        }
      });

      // Get root nodes (apps or features without parents)
      const roots = [];
      nodeMap.forEach(node => {
        if (!node.parentId) {
          roots.push(node);
        }
      });

      // Calculate sizes bottom-up
      function calculateSize(node) {
        if (collapsedNodes.has(node.id)) {
          node._width = 200;
          node._height = HEADER_HEIGHT + 10;
          return;
        }

        if (node.kind === 'file') {
          node._width = FILE_WIDTH;
          node._height = FILE_HEIGHT;
          return;
        }

        // Calculate children sizes first
        node.children.forEach(child => calculateSize(child));

        if (node.kind === 'capability') {
          // Files in a row
          const files = node.children.filter(c => c.kind === 'file');
          const filesPerRow = 3;
          const rows = Math.ceil(files.length / filesPerRow);
          const filesWidth = Math.min(files.length, filesPerRow) * (FILE_WIDTH + FILE_GAP) - FILE_GAP;
          const filesHeight = rows * (FILE_HEIGHT + FILE_GAP) - FILE_GAP;
          
          node._width = Math.max(180, filesWidth + CAPABILITY_PADDING * 2);
          node._height = CAP_HEADER_HEIGHT + filesHeight + CAPABILITY_PADDING * 2;
        } else if (node.kind === 'feature') {
          // Capabilities and files side by side
          const capabilities = node.children.filter(c => c.kind === 'capability');
          const files = node.children.filter(c => c.kind === 'file');
          
          let capsWidth = 0;
          let capsHeight = 0;
          capabilities.forEach(cap => {
            capsWidth = Math.max(capsWidth, cap._width);
            capsHeight += cap._height + CAPABILITY_GAP;
          });
          if (capabilities.length > 0) capsHeight -= CAPABILITY_GAP;

          // Files stacked on the right
          const filesWidth = files.length > 0 ? FILE_WIDTH : 0;
          const filesHeight = files.length * (FILE_HEIGHT + FILE_GAP) - (files.length > 0 ? FILE_GAP : 0);

          const contentWidth = capsWidth + (files.length > 0 ? FEATURE_PADDING + filesWidth : 0);
          const contentHeight = Math.max(capsHeight, filesHeight);

          node._width = Math.max(250, contentWidth + FEATURE_PADDING * 2);
          node._height = HEADER_HEIGHT + contentHeight + FEATURE_PADDING * 2;
        } else if (node.kind === 'app') {
          // Features in a row
          const features = node.children.filter(c => c.kind === 'feature');
          let totalWidth = 0;
          let maxHeight = 0;
          features.forEach(f => {
            totalWidth += f._width + FEATURE_GAP;
            maxHeight = Math.max(maxHeight, f._height);
          });
          if (features.length > 0) totalWidth -= FEATURE_GAP;

          node._width = Math.max(300, totalWidth + APP_PADDING * 2);
          node._height = HEADER_HEIGHT + maxHeight + APP_PADDING * 2;
        }
      }

      roots.forEach(root => calculateSize(root));

      // Position nodes
      let currentX = PADDING;
      let currentY = PADDING;
      let maxRowHeight = 0;
      const maxRowWidth = width - PADDING * 2;

      function positionNode(node, x, y) {
        node._x = x;
        node._y = y;

        if (collapsedNodes.has(node.id)) return;

        if (node.kind === 'app') {
          let childX = x + APP_PADDING;
          const childY = y + HEADER_HEIGHT + APP_PADDING;
          node.children.filter(c => c.kind === 'feature').forEach(feature => {
            positionNode(feature, childX, childY);
            childX += feature._width + FEATURE_GAP;
          });
        } else if (node.kind === 'feature') {
          const capabilities = node.children.filter(c => c.kind === 'capability');
          const files = node.children.filter(c => c.kind === 'file');
          
          let childY = y + HEADER_HEIGHT + FEATURE_PADDING;
          capabilities.forEach(cap => {
            positionNode(cap, x + FEATURE_PADDING, childY);
            childY += cap._height + CAPABILITY_GAP;
          });

          // Position feature-level files on the right
          if (files.length > 0) {
            const capsWidth = capabilities.length > 0 ? 
              Math.max(...capabilities.map(c => c._width)) : 0;
            const filesX = x + FEATURE_PADDING + capsWidth + (capabilities.length > 0 ? FEATURE_PADDING : 0);
            let fileY = y + HEADER_HEIGHT + FEATURE_PADDING;
            files.forEach(file => {
              positionNode(file, filesX, fileY);
              fileY += FILE_HEIGHT + FILE_GAP;
            });
          }
        } else if (node.kind === 'capability') {
          const files = node.children.filter(c => c.kind === 'file');
          const filesPerRow = 3;
          files.forEach((file, i) => {
            const row = Math.floor(i / filesPerRow);
            const col = i % filesPerRow;
            positionNode(file, 
              x + CAPABILITY_PADDING + col * (FILE_WIDTH + FILE_GAP),
              y + CAP_HEADER_HEIGHT + CAPABILITY_PADDING + row * (FILE_HEIGHT + FILE_GAP)
            );
          });
        }
      }

      // Position root nodes in a balanced grid
      // Calculate optimal number of columns based on node count
      const numRoots = roots.length;
      const optimalCols = Math.ceil(Math.sqrt(numRoots)); // Square-ish grid
      
      // Calculate max width per column
      const avgWidth = roots.reduce((sum, r) => sum + r._width, 0) / numRoots;
      const targetCols = Math.max(2, Math.min(optimalCols, Math.floor((maxRowWidth + FEATURE_GAP) / (avgWidth + FEATURE_GAP))));
      
      // Distribute roots into rows
      const rowCount = Math.ceil(numRoots / targetCols);
      const rows = [];
      for (let i = 0; i < rowCount; i++) {
        rows.push(roots.slice(i * targetCols, (i + 1) * targetCols));
      }
      
      // Position each row
      rows.forEach(rowNodes => {
        // Calculate row dimensions
        const rowWidth = rowNodes.reduce((sum, n) => sum + n._width + FEATURE_GAP, 0) - FEATURE_GAP;
        const rowHeight = Math.max(...rowNodes.map(n => n._height));
        
        // Center the row horizontally
        let rowX = PADDING + (maxRowWidth - rowWidth) / 2;
        
        rowNodes.forEach(node => {
          positionNode(node, rowX, currentY);
          rowX += node._width + FEATURE_GAP;
        });
        
        currentY += rowHeight + FEATURE_GAP;
      });

      return nodeMap;
    }

    function getStatusBorderStyle(status) {
      switch (status) {
        case 'completed': return { color: '#4CAF50', dashArray: 'none' };
        case 'in_progress': return { color: '#FFC107', dashArray: 'none' };
        case 'planned': return { color: '#9E9E9E', dashArray: '5,3' };
        default: return { color: '#9E9E9E', dashArray: 'none' };
      }
    }

    function renderGraph() {
      g.selectAll('.node-group').remove();
      
      if (graphData.nodes.length === 0) return;

      const nodeMap = calculateLayout();
      const nodes = Array.from(nodeMap.values());

      // Render in order: apps, features, capabilities, files
      const renderOrder = ['app', 'feature', 'capability', 'file'];
      
      renderOrder.forEach(kind => {
        const kindNodes = nodes.filter(n => n.kind === kind);
        
        kindNodes.forEach(node => {
          if (node.parentId && collapsedNodes.has(node.parentId)) return;
          // Check all ancestors
          let ancestor = nodeMap.get(node.parentId);
          while (ancestor) {
            if (collapsedNodes.has(ancestor.id)) return;
            ancestor = nodeMap.get(ancestor.parentId);
          }

          const group = g.append('g')
            .attr('class', 'node-group')
            .attr('transform', \`translate(\${node._x},\${node._y})\`);

          if (node.kind === 'app') {
            // App container - cream background
            group.append('rect')
              .attr('width', node._width)
              .attr('height', node._height)
              .attr('rx', 8)
              .attr('fill', '#FFF9C4')
              .attr('stroke', '#F9A825')
              .attr('stroke-width', 3);

            group.append('text')
              .attr('x', node._width / 2)
              .attr('y', 24)
              .attr('text-anchor', 'middle')
              .attr('font-size', '16px')
              .attr('font-weight', 'bold')
              .attr('fill', '#333')
              .text(node.name);

          } else if (node.kind === 'feature') {
            const statusStyle = getStatusBorderStyle(node.status);
            const isCollapsed = collapsedNodes.has(node.id);
            
            // Feature box - yellow background
            group.append('rect')
              .attr('width', node._width)
              .attr('height', node._height)
              .attr('rx', 6)
              .attr('fill', node.color || '#FFE082')
              .attr('stroke', statusStyle.color)
              .attr('stroke-width', 3)
              .attr('stroke-dasharray', statusStyle.dashArray)
              .style('cursor', 'pointer')
              .on('click', () => {
                if (collapsedNodes.has(node.id)) {
                  collapsedNodes.delete(node.id);
                } else {
                  collapsedNodes.add(node.id);
                }
                renderGraph();
              })
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip);

            // Collapse indicator
            group.append('text')
              .attr('x', 12)
              .attr('y', 22)
              .attr('font-size', '14px')
              .attr('fill', '#333')
              .text(isCollapsed ? '▶' : '▼');

            group.append('text')
              .attr('x', 28)
              .attr('y', 24)
              .attr('font-size', '14px')
              .attr('font-weight', 'bold')
              .attr('fill', '#333')
              .text(node.name);

          } else if (node.kind === 'capability') {
            // Capability box - purple/pink background
            group.append('rect')
              .attr('width', node._width)
              .attr('height', node._height)
              .attr('rx', 4)
              .attr('fill', '#E1BEE7')
              .attr('stroke', '#9C27B0')
              .attr('stroke-width', 1.5)
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip);

            group.append('text')
              .attr('x', CAPABILITY_PADDING)
              .attr('y', 18)
              .attr('font-size', '12px')
              .attr('font-weight', 'bold')
              .attr('fill', '#4A148C')
              .text(node.name);

          } else if (node.kind === 'file') {
            // File box - gray with stacked effect
            // Shadow/stack effect
            group.append('rect')
              .attr('x', 4)
              .attr('y', 4)
              .attr('width', node._width)
              .attr('height', node._height)
              .attr('rx', 3)
              .attr('fill', '#9E9E9E');

            group.append('rect')
              .attr('x', 2)
              .attr('y', 2)
              .attr('width', node._width)
              .attr('height', node._height)
              .attr('rx', 3)
              .attr('fill', '#BDBDBD');

            // Main file box
            group.append('rect')
              .attr('width', node._width)
              .attr('height', node._height)
              .attr('rx', 3)
              .attr('fill', '#E0E0E0')
              .attr('stroke', '#757575')
              .attr('stroke-width', 1)
              .style('cursor', 'pointer')
              .on('click', () => {
                if (node.filePath) {
                  vscode.postMessage({ type: 'file:open', filePath: node.filePath });
                }
              })
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip);

            group.append('text')
              .attr('x', 8)
              .attr('y', 18)
              .attr('font-size', '11px')
              .attr('fill', '#333')
              .text(truncateText(node.name, 20));
          }
        });
      });
    }

    function truncateText(text, maxLength) {
      if (text.length <= maxLength) return text;
      return text.substring(0, maxLength - 2) + '..';
    }

    // Initialize
    initVisualization();
    
    // Message handler
    window.addEventListener('message', event => {
      const message = event.data;
      console.log('[Features View] Received:', message.type);
      
      switch (message.type) {
        case 'features:update':
          hideError();
          if (message.error) {
            showError(message.error);
            graphData = { nodes: [], edges: [] };
          } else {
            graphData = message.data;
          }
          renderGraph();
          break;
      }
    });

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

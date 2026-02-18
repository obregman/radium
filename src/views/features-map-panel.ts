import * as vscode from 'vscode';
import { GraphStore } from '../store/schema';
import { FeaturesConfigLoader, FeaturesConfig, FeatureConfig, FeatureCapability, ExternalSource } from '../config/features-config';
import * as path from 'path';

interface FeaturesGraphNode {
  id: string;
  kind: 'app' | 'feature' | 'capability' | 'file' | 'external';
  name: string;
  description?: string;
  filePath?: string;
  parentId?: string;
  color?: string;
  externalType?: string;
  usedBy?: string[];
}

interface FeaturesGraphEdge {
  source: string;
  target: string;
  kind: 'contains' | 'uses-external';
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
      case 'context:explain':
        await this.handleContextExplain(message.nodeKind, message.nodeName, message.nodeDescription);
        break;
      case 'context:report-bug':
        await this.handleContextReportBug(message.nodeKind, message.nodeName, message.nodeDescription);
        break;
      case 'context:review':
        await this.handleContextReview(message.nodeKind, message.nodeName, message.nodeDescription);
        break;
      case 'ready':
        this.updateGraph();
        break;
      default:
        console.log('[Radium Features] Unknown message type:', message.type);
    }
  }

  private async handleContextExplain(nodeKind: string, nodeName: string, nodeDescription?: string) {
    const kindLabel = nodeKind === 'feature' ? 'feature' : 'capability';
    const descPart = nodeDescription ? `\nDescription: ${nodeDescription}` : '';
    
    const prompt = `Explain how the "${nodeName}" ${kindLabel} is implemented in this codebase.${descPart}

Please provide:
1. An overview of what this ${kindLabel} does
2. The main components/files involved
3. The key code paths and how they work together
4. Any important patterns or architectural decisions used`;

    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage('Prompt copied to clipboard');
  }

  private async handleContextReportBug(nodeKind: string, nodeName: string, nodeDescription?: string) {
    const kindLabel = nodeKind === 'feature' ? 'feature' : 'capability';
    const descPart = nodeDescription ? `\nDescription: ${nodeDescription}` : '';
    
    const prompt = `I'm experiencing a bug in the "${nodeName}" ${kindLabel}.${descPart}

Please help me investigate this issue:
1. Review the implementation of this ${kindLabel}
2. Identify potential problem areas or edge cases
3. Check for common issues like null checks, error handling, race conditions
4. Suggest debugging steps or fixes

Bug description: [DESCRIBE THE BUG HERE]`;

    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage('Prompt copied to clipboard');
  }

  private async handleContextReview(nodeKind: string, nodeName: string, nodeDescription?: string) {
    const kindLabel = nodeKind === 'feature' ? 'feature' : 'capability';
    const descPart = nodeDescription ? `\nDescription: ${nodeDescription}` : '';
    
    const prompt = `Review the "${nodeName}" ${kindLabel} implementation.${descPart}

Please analyze this ${kindLabel} and identify:
1. Potential bugs or edge cases that may not be handled
2. Error handling gaps or missing validations
3. Race conditions or concurrency issues
4. Security vulnerabilities or data validation issues
5. Performance concerns or inefficiencies
6. Code quality issues or areas that could be improved
7. Missing tests or test coverage gaps

For each issue found, explain the potential impact and suggest a fix.`;

    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage('Prompt copied to clipboard');
  }


  private async handleCopyPrompt() {
    const prompt = `Analyze this codebase and generate or update the .radium/radium-features.yaml file.

The file should document the product features and capabilities using this structure:

\`\`\`yaml
metadata:
  last_updated: "<current ISO 8601 timestamp>"
  commit_id: "<current HEAD commit hash>"

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
              external:  # Optional - external dependencies for this capability
                - type: Database  # e.g., Database, API, Cache, Queue, Email, Storage, etc.
                  name: PostgreSQL
                  description: What this external source is used for
                  usedBy:  # Optional - files that use this external source
                    - src/path/to/repository.ts
        files:  # Feature-level files not tied to a specific capability
          - src/shared/file.ts
        external:  # Optional - feature-level external dependencies
          - type: API
            name: External Service
            description: Third-party service integration
\`\`\`

Instructions:
1. If .radium/radium-features.yaml already exists, read it and note the commit_id in its metadata. Then review all changes since that commit (git diff <commit_id>..HEAD) and update the file incrementally based on what changed — add new features/capabilities, update file lists, remove deleted files, etc. Do NOT regenerate from scratch.
2. If the file does not exist, generate it from scratch by analyzing the full codebase.
3. Identify the main product features by analyzing the codebase structure, routes, components, and business logic
4. For each feature, identify its sub-capabilities (distinct functionalities within the feature)
5. Map the source files that implement each capability
6. Identify external dependencies (databases, APIs, caches, queues, file storage, third-party services, etc.) and associate them with the features/capabilities that use them
7. Group features under apps only if the project contains multiple distinct applications
8. Always set metadata.last_updated to the current timestamp and metadata.commit_id to the current HEAD commit hash

Focus on user-facing product features, not technical infrastructure.

IMPORTANT YAML formatting rules:
- Always quote description values that contain special characters like @, #, :, -, *, etc.
- Use double quotes for descriptions: description: "Text with @mentions and /commands"
- Keep descriptions on a single line
- If a description is long, truncate it rather than using multi-line strings`;

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

      // Add external sources for this capability
      if (capability.external && capability.external.length > 0) {
        this.addExternalNodes(nodes, edges, capability.external, capId, `${featureKey}:${capKey}`, color);
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

    // Add feature-level external sources
    if (feature.external && feature.external.length > 0) {
      this.addExternalNodes(nodes, edges, feature.external, featureId, featureKey, color);
    }
  }

  private addExternalNodes(
    nodes: FeaturesGraphNode[],
    edges: FeaturesGraphEdge[],
    externals: ExternalSource[],
    parentId: string,
    keyPrefix: string,
    color: string
  ) {
    for (const external of externals) {
      const externalId = `external:${keyPrefix}:${external.name}`;
      
      nodes.push({
        id: externalId,
        kind: 'external',
        name: external.name,
        description: external.description,
        externalType: external.type,
        parentId,
        color,
        usedBy: external.usedBy
      });

      edges.push({
        source: parentId,
        target: externalId,
        kind: 'uses-external'
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
      user-select: none;
      -webkit-user-select: none;
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
    .context-menu {
      position: absolute;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border);
      border-radius: 4px;
      padding: 4px 0;
      z-index: 3000;
      min-width: 150px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .context-menu-item {
      padding: 6px 12px;
      cursor: pointer;
      color: var(--vscode-menu-foreground);
    }
    .context-menu-item:hover {
      background: var(--vscode-menu-selectionBackground);
      color: var(--vscode-menu-selectionForeground);
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="controls">
    <button class="control-button" id="reset-view-btn">Reset View</button>
    <button class="control-button" id="copy-prompt-btn">Copy Prompt</button>
  </div>
  <div id="tooltip" class="tooltip" style="display: none;"></div>
  <div id="context-menu" class="context-menu" style="display: none;">
    <div class="context-menu-item" data-action="explain">Explain</div>
    <div class="context-menu-item" data-action="review">Review this</div>
    <div class="context-menu-item" data-action="report-bug">Report a bug</div>
  </div>
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
    let contextMenuNode = null;

    // Context menu functions
    function showContextMenu(event, node) {
      event.preventDefault();
      contextMenuNode = node;
      const menu = document.getElementById('context-menu');
      menu.style.display = 'block';
      menu.style.left = event.pageX + 'px';
      menu.style.top = event.pageY + 'px';
    }

    function hideContextMenu() {
      const menu = document.getElementById('context-menu');
      menu.style.display = 'none';
      contextMenuNode = null;
    }

    // Initialize context menu handlers
    document.addEventListener('click', hideContextMenu);
    document.getElementById('context-menu').addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (action && contextMenuNode) {
        if (action === 'explain') {
          vscode.postMessage({
            type: 'context:explain',
            nodeKind: contextMenuNode.kind,
            nodeName: contextMenuNode.name,
            nodeDescription: contextMenuNode.description
          });
        } else if (action === 'review') {
          vscode.postMessage({
            type: 'context:review',
            nodeKind: contextMenuNode.kind,
            nodeName: contextMenuNode.name,
            nodeDescription: contextMenuNode.description
          });
        } else if (action === 'report-bug') {
          vscode.postMessage({
            type: 'context:report-bug',
            nodeKind: contextMenuNode.kind,
            nodeName: contextMenuNode.name,
            nodeDescription: contextMenuNode.description
          });
        }
        hideContextMenu();
      }
    });

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
    const APP_HEADER_HEIGHT = 65;
    const CAP_HEADER_HEIGHT = 28;
    const EXTERNAL_HEIGHT = 36;
    const EXTERNAL_WIDTH = 140;
    const EXTERNAL_GAP = 10;

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
        // Reduced zoom speed for smoother experience, especially on Mac trackpads
        // When Shift is held, zoom three times as fast
        const baseScaleBy = delta > 0 ? 1.03 : 0.97;
        const scaleBy = event.shiftKey ? (delta > 0 ? 1.09 : 0.91) : baseScaleBy;
        const newScale = Math.max(0.1, Math.min(10, transform.k * scaleBy));
        
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

      const copyBtn = document.getElementById('copy-prompt-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'copy:prompt' });
        });
      }

      // Handle window resize
      window.addEventListener('resize', () => {
        width = window.innerWidth;
        height = window.innerHeight;
        svg.attr('width', width).attr('height', height);
      });
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

    let tooltipTimeout = null;
    let tooltipEvent = null;
    let tooltipNode = null;

    function showTooltip(event, node) {
      // Store event and node for delayed display
      tooltipEvent = event;
      tooltipNode = node;
      
      // Clear any existing timeout
      if (tooltipTimeout) {
        clearTimeout(tooltipTimeout);
      }
      
      // Set timeout to show tooltip after 800ms
      tooltipTimeout = setTimeout(() => {
        if (!tooltipNode) return;
        
        const tooltip = d3.select('#tooltip');
        let html = \`<div class="tooltip-title">\${tooltipNode.name}</div>\`;
        if (tooltipNode.externalType) {
          html += \`<div class="tooltip-description">Type: \${tooltipNode.externalType}</div>\`;
        }
        if (tooltipNode.description) {
          html += \`<div class="tooltip-description">\${tooltipNode.description}</div>\`;
        }
        if (tooltipNode.filePath) {
          html += \`<div class="tooltip-description">\${tooltipNode.filePath}</div>\`;
        }
        if (tooltipNode.usedBy && tooltipNode.usedBy.length > 0) {
          html += \`<div class="tooltip-description">Used by: \${tooltipNode.usedBy.join(', ')}</div>\`;
        }
        
        tooltip.html(html)
          .style('display', 'block')
          .style('left', (tooltipEvent.pageX + 10) + 'px')
          .style('top', (tooltipEvent.pageY + 10) + 'px');
      }, 800);
    }

    function hideTooltip() {
      // Clear timeout if tooltip hasn't shown yet
      if (tooltipTimeout) {
        clearTimeout(tooltipTimeout);
        tooltipTimeout = null;
      }
      tooltipEvent = null;
      tooltipNode = null;
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
        if (node.kind === 'file') {
          node._width = FILE_WIDTH;
          node._height = FILE_HEIGHT;
          return;
        }

        if (node.kind === 'external') {
          node._width = EXTERNAL_WIDTH;
          node._height = EXTERNAL_HEIGHT;
          return;
        }

        // Calculate children sizes first
        node.children.forEach(child => calculateSize(child));

        if (node.kind === 'capability') {
          // Files in a row
          const files = node.children.filter(c => c.kind === 'file');
          const externals = node.children.filter(c => c.kind === 'external');
          const filesPerRow = 3;
          const rows = Math.ceil(files.length / filesPerRow);
          const filesWidth = Math.min(files.length, filesPerRow) * (FILE_WIDTH + FILE_GAP) - FILE_GAP;
          const filesHeight = rows * (FILE_HEIGHT + FILE_GAP) - FILE_GAP;
          
          // External sources below files
          const externalsHeight = externals.length > 0 ? externals.length * (EXTERNAL_HEIGHT + EXTERNAL_GAP) - EXTERNAL_GAP : 0;
          const externalsWidth = externals.length > 0 ? EXTERNAL_WIDTH : 0;
          
          // Estimate label width (12px font, ~7px per character average)
          const labelWidth = node.name.length * 7 + CAPABILITY_PADDING * 2;
          
          const contentWidth = Math.max(filesWidth, externalsWidth);
          const contentHeight = filesHeight + (externals.length > 0 && files.length > 0 ? EXTERNAL_GAP : 0) + externalsHeight;
          
          node._width = Math.max(labelWidth, contentWidth + CAPABILITY_PADDING * 2);
          node._height = CAP_HEADER_HEIGHT + contentHeight + CAPABILITY_PADDING * 2;
        } else if (node.kind === 'feature') {
          // Capabilities and files side by side
          const capabilities = node.children.filter(c => c.kind === 'capability');
          const files = node.children.filter(c => c.kind === 'file');
          const externals = node.children.filter(c => c.kind === 'external');
          
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
          
          // External sources stacked below files on the right
          const externalsHeight = externals.length > 0 ? externals.length * (EXTERNAL_HEIGHT + EXTERNAL_GAP) - EXTERNAL_GAP : 0;
          const externalsWidth = externals.length > 0 ? EXTERNAL_WIDTH : 0;
          const rightColumnWidth = Math.max(filesWidth, externalsWidth);
          const rightColumnHeight = filesHeight + (externals.length > 0 && files.length > 0 ? EXTERNAL_GAP : 0) + externalsHeight;

          const contentWidth = capsWidth + (rightColumnWidth > 0 ? FEATURE_PADDING + rightColumnWidth : 0);
          const contentHeight = Math.max(capsHeight, rightColumnHeight);

          // Estimate label width (30px font, ~18px per character average)
          const featureLabelWidth = node.name.length * 18 + FEATURE_PADDING * 2;

          node._width = Math.max(featureLabelWidth, contentWidth + FEATURE_PADDING * 2);
          node._height = HEADER_HEIGHT + contentHeight + FEATURE_PADDING * 2;
        } else if (node.kind === 'app') {
          // Features in brick/masonry layout
          const features = node.children.filter(c => c.kind === 'feature');

          // Find optimal column count for masonry layout
          let appBestCols = 1;
          let appBestRatio = Infinity;
          const appTargetRatio = 1.5;

          for (let cols = 1; cols <= Math.min(features.length, 4); cols++) {
            const cHeights = new Array(cols).fill(0);
            const cWidths = new Array(cols).fill(0);
            features.forEach(f => {
              const minIdx = cHeights.indexOf(Math.min(...cHeights));
              cHeights[minIdx] += f._height + FEATURE_GAP;
              cWidths[minIdx] = Math.max(cWidths[minIdx], f._width);
            });
            const estW = cWidths.reduce((s, w) => s + w, 0) + (cols - 1) * FEATURE_GAP;
            const estH = Math.max(...cHeights) - (features.length > 0 ? FEATURE_GAP : 0);
            const ratio = estW / (estH || 1);
            if (Math.abs(ratio - appTargetRatio) < Math.abs(appBestRatio - appTargetRatio)) {
              appBestRatio = ratio;
              appBestCols = cols;
            }
          }

          // Calculate actual dimensions with masonry
          const appColHeights = new Array(appBestCols).fill(0);
          const appColWidths = new Array(appBestCols).fill(0);
          features.forEach(f => {
            const minIdx = appColHeights.indexOf(Math.min(...appColHeights));
            appColHeights[minIdx] += f._height + FEATURE_GAP;
            appColWidths[minIdx] = Math.max(appColWidths[minIdx], f._width);
          });

          const totalWidth = appColWidths.reduce((s, w) => s + w, 0) + (appBestCols - 1) * FEATURE_GAP;
          const maxColHeight = features.length > 0 ? Math.max(...appColHeights) - FEATURE_GAP : 0;

          node._width = Math.max(300, totalWidth + APP_PADDING * 2);
          node._height = APP_HEADER_HEIGHT + maxColHeight + APP_PADDING * 2;
          node._masonryCols = appBestCols;
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

        if (node.kind === 'app') {
          // Brick/masonry layout for features inside app
          const features = node.children.filter(c => c.kind === 'feature');
          const numAppCols = node._masonryCols || 1;
          const appColHeights = new Array(numAppCols).fill(0);
          const appColMaxWidths = new Array(numAppCols).fill(0);
          const appNodeCols = [];

          // First pass: assign features to columns
          features.forEach(f => {
            const minIdx = appColHeights.indexOf(Math.min(...appColHeights));
            appNodeCols.push(minIdx);
            appColHeights[minIdx] += f._height + FEATURE_GAP;
            appColMaxWidths[minIdx] = Math.max(appColMaxWidths[minIdx], f._width);
          });

          // Calculate column X positions
          const appColXPositions = [];
          let appColX = x + APP_PADDING;
          for (let i = 0; i < numAppCols; i++) {
            appColXPositions.push(appColX);
            appColX += appColMaxWidths[i] + FEATURE_GAP;
          }

          // Reset and position
          appColHeights.fill(y + APP_HEADER_HEIGHT + APP_PADDING);
          features.forEach((feature, idx) => {
            const colIdx = appNodeCols[idx];
            positionNode(feature, appColXPositions[colIdx], appColHeights[colIdx]);
            appColHeights[colIdx] += feature._height + FEATURE_GAP;
          });
        } else if (node.kind === 'feature') {
          const capabilities = node.children.filter(c => c.kind === 'capability');
          const files = node.children.filter(c => c.kind === 'file');
          const externals = node.children.filter(c => c.kind === 'external');
          
          let childY = y + HEADER_HEIGHT + FEATURE_PADDING;
          capabilities.forEach(cap => {
            positionNode(cap, x + FEATURE_PADDING, childY);
            childY += cap._height + CAPABILITY_GAP;
          });

          // Position feature-level files and externals on the right
          const capsWidth = capabilities.length > 0 ? 
            Math.max(...capabilities.map(c => c._width)) : 0;
          const rightX = x + FEATURE_PADDING + capsWidth + (capabilities.length > 0 ? FEATURE_PADDING : 0);
          let rightY = y + HEADER_HEIGHT + FEATURE_PADDING;
          
          files.forEach(file => {
            positionNode(file, rightX, rightY);
            rightY += FILE_HEIGHT + FILE_GAP;
          });
          
          // Position external sources below files
          if (externals.length > 0 && files.length > 0) {
            rightY += EXTERNAL_GAP - FILE_GAP;
          }
          externals.forEach(ext => {
            positionNode(ext, rightX, rightY);
            rightY += EXTERNAL_HEIGHT + EXTERNAL_GAP;
          });
        } else if (node.kind === 'capability') {
          const files = node.children.filter(c => c.kind === 'file');
          const externals = node.children.filter(c => c.kind === 'external');
          const filesPerRow = 3;
          let currentY = y + CAP_HEADER_HEIGHT + CAPABILITY_PADDING;
          
          files.forEach((file, i) => {
            const row = Math.floor(i / filesPerRow);
            const col = i % filesPerRow;
            positionNode(file, 
              x + CAPABILITY_PADDING + col * (FILE_WIDTH + FILE_GAP),
              y + CAP_HEADER_HEIGHT + CAPABILITY_PADDING + row * (FILE_HEIGHT + FILE_GAP)
            );
          });
          
          // Position external sources below files
          const filesRows = Math.ceil(files.length / filesPerRow);
          let extY = y + CAP_HEADER_HEIGHT + CAPABILITY_PADDING + filesRows * (FILE_HEIGHT + FILE_GAP);
          if (externals.length > 0 && files.length > 0) {
            extY += EXTERNAL_GAP - FILE_GAP;
          }
          externals.forEach(ext => {
            positionNode(ext, x + CAPABILITY_PADDING, extY);
            extY += EXTERNAL_HEIGHT + EXTERNAL_GAP;
          });
        }
      }

      // Brick/masonry layout aiming for roughly square total dimensions (4:3 to 5:4 ratio)
      // Calculate total area and find optimal column count for square-ish layout
      const totalArea = roots.reduce((sum, r) => sum + r._width * r._height, 0);
      const avgHeight = roots.reduce((sum, r) => sum + r._height, 0) / roots.length;
      const avgWidth = roots.reduce((sum, r) => sum + r._width, 0) / roots.length;
      
      // Target aspect ratio between 1:1 and 4:3 (width:height)
      // Estimate total dimensions for different column counts and pick best
      let bestCols = 1;
      let bestRatio = Infinity;
      const targetRatio = 1.25; // Aim for 5:4 aspect ratio
      
      for (let cols = 1; cols <= Math.min(roots.length, 6); cols++) {
        // Estimate layout dimensions with this column count using masonry simulation
        const colHeights = new Array(cols).fill(0);
        const colWidths = new Array(cols).fill(0);
        
        roots.forEach(node => {
          // Find shortest column
          const minColIdx = colHeights.indexOf(Math.min(...colHeights));
          colHeights[minColIdx] += node._height + FEATURE_GAP;
          colWidths[minColIdx] = Math.max(colWidths[minColIdx], node._width);
        });
        
        const estWidth = colWidths.reduce((sum, w) => sum + w, 0) + (cols - 1) * FEATURE_GAP;
        const estHeight = Math.max(...colHeights) - FEATURE_GAP;
        const ratio = estWidth / estHeight;
        
        // Pick column count closest to target ratio
        if (Math.abs(ratio - targetRatio) < Math.abs(bestRatio - targetRatio)) {
          bestRatio = ratio;
          bestCols = cols;
        }
      }
      
      // Masonry layout: place each node in the shortest column
      const numCols = bestCols;
      const colHeights = new Array(numCols).fill(PADDING);
      const colXPositions = new Array(numCols).fill(0);
      const colMaxWidths = new Array(numCols).fill(0);
      
      // First pass: assign nodes to columns to determine max widths
      const nodeColumns = [];
      roots.forEach(node => {
        const minColIdx = colHeights.indexOf(Math.min(...colHeights));
        nodeColumns.push(minColIdx);
        colHeights[minColIdx] += node._height + FEATURE_GAP;
        colMaxWidths[minColIdx] = Math.max(colMaxWidths[minColIdx], node._width);
      });
      
      // Calculate column X positions based on max widths
      let currentColX = PADDING;
      for (let i = 0; i < numCols; i++) {
        colXPositions[i] = currentColX;
        currentColX += colMaxWidths[i] + FEATURE_GAP;
      }
      
      // Reset column heights for actual positioning
      colHeights.fill(PADDING);
      
      // Second pass: position nodes
      roots.forEach((node, idx) => {
        const colIdx = nodeColumns[idx];
        const x = colXPositions[colIdx];
        const y = colHeights[colIdx];
        
        positionNode(node, x, y);
        colHeights[colIdx] += node._height + FEATURE_GAP;
      });

      return nodeMap;
    }

    function renderGraph() {
      g.selectAll('.node-group').remove();
      
      if (graphData.nodes.length === 0) return;

      const nodeMap = calculateLayout();
      const nodes = Array.from(nodeMap.values());

      // Render in order: apps, features, capabilities, files, externals
      const renderOrder = ['app', 'feature', 'capability', 'file', 'external'];
      
      renderOrder.forEach(kind => {
        const kindNodes = nodes.filter(n => n.kind === kind);
        
        kindNodes.forEach(node => {
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
              .attr('y', 48)
              .attr('text-anchor', 'middle')
              .attr('font-size', '48px')
              .attr('font-weight', 'bold')
              .attr('fill', '#333')
              .text(node.name);

          } else if (node.kind === 'feature') {
            // Feature box - yellow background
            group.append('rect')
              .attr('width', node._width)
              .attr('height', node._height)
              .attr('rx', 6)
              .attr('fill', node.color || '#FFE082')
              .attr('stroke', '#666')
              .attr('stroke-width', 2)
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip)
              .on('contextmenu', (event) => showContextMenu(event, node));

            group.append('text')
              .attr('x', 12)
              .attr('y', 32)
              .attr('font-size', '30px')
              .attr('font-weight', 'bold')
              .attr('fill', '#333')
              .style('cursor', 'default')
              .text(node.name)
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip)
              .on('contextmenu', (event) => showContextMenu(event, node));

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
              .on('mouseleave', hideTooltip)
              .on('contextmenu', (event) => showContextMenu(event, node));

            group.append('text')
              .attr('x', CAPABILITY_PADDING)
              .attr('y', 18)
              .attr('font-size', '12px')
              .attr('font-weight', 'bold')
              .attr('fill', '#4A148C')
              .style('cursor', 'default')
              .text(node.name)
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip)
              .on('contextmenu', (event) => showContextMenu(event, node));

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
              .style('cursor', 'pointer')
              .text(truncateText(node.name, 20))
              .on('click', () => {
                if (node.filePath) {
                  vscode.postMessage({ type: 'file:open', filePath: node.filePath });
                }
              })
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip);
          } else if (node.kind === 'external') {
            // External source - rounded rectangle with icon
            group.append('rect')
              .attr('width', node._width)
              .attr('height', node._height)
              .attr('rx', 6)
              .attr('fill', '#FFFFFF')
              .attr('stroke', '#1976D2')
              .attr('stroke-width', 2)
              .attr('stroke-dasharray', '4,2')
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip);

            // Icon based on type
            const icon = getExternalIcon(node.externalType);
            group.append('text')
              .attr('x', 10)
              .attr('y', 24)
              .attr('font-size', '16px')
              .style('pointer-events', 'all')
              .text(icon)
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip);

            // Name
            group.append('text')
              .attr('x', 32)
              .attr('y', 16)
              .attr('font-size', '11px')
              .attr('font-weight', 'bold')
              .attr('fill', '#1976D2')
              .style('pointer-events', 'all')
              .text(truncateText(node.name, 14))
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip);

            // Type label
            group.append('text')
              .attr('x', 32)
              .attr('y', 28)
              .attr('font-size', '9px')
              .attr('fill', '#666')
              .style('pointer-events', 'all')
              .text(node.externalType || 'External')
              .on('mouseenter', (event) => showTooltip(event, node))
              .on('mouseleave', hideTooltip);
          }
        });
      });
    }

    function getExternalIcon(type) {
      if (!type) return '🔗';
      const t = type.toLowerCase();
      if (t.includes('database') || t.includes('db') || t.includes('sql') || t.includes('postgres') || t.includes('mysql') || t.includes('mongo') || t.includes('redis')) return '🗄️';
      if (t.includes('api') || t.includes('rest') || t.includes('graphql') || t.includes('http')) return '🌐';
      if (t.includes('file') || t.includes('storage') || t.includes('s3') || t.includes('blob')) return '📁';
      if (t.includes('queue') || t.includes('kafka') || t.includes('rabbit') || t.includes('sqs')) return '📬';
      if (t.includes('cache') || t.includes('memcache')) return '⚡';
      if (t.includes('auth') || t.includes('oauth') || t.includes('jwt')) return '🔐';
      if (t.includes('email') || t.includes('smtp') || t.includes('mail')) return '📧';
      if (t.includes('payment') || t.includes('stripe') || t.includes('paypal')) return '💳';
      if (t.includes('analytics') || t.includes('metrics') || t.includes('logging')) return '📊';
      if (t.includes('cdn') || t.includes('cloudflare')) return '☁️';
      if (t.includes('library') || t.includes('sdk') || t.includes('package')) return '📦';
      return '🔗';
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

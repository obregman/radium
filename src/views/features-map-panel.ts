import * as vscode from 'vscode';
import { FeaturesConfigLoader, FeatureConfig, FlowItem } from '../config/features-config';
import { RadiumConfigLoader } from '../config/radium-config';

export class FeaturesMapPanel {
  public static currentPanel: FeaturesMapPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private featuresLoader: FeaturesConfigLoader,
    private componentsLoader: RadiumConfigLoader
  ) {
    this.panel = panel;
    
    this.panel.webview.onDidReceiveMessage(
      message => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.webview.html = this.getHtmlContent(extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Send initial data
    this.updateGraph();
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    featuresLoader: FeaturesConfigLoader,
    componentsLoader: RadiumConfigLoader
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (FeaturesMapPanel.currentPanel) {
      FeaturesMapPanel.currentPanel.panel.reveal(column);
      FeaturesMapPanel.currentPanel.updateGraph();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'featuresMap',
      'Radium: Features Map',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          extensionUri,
          vscode.Uri.joinPath(extensionUri, 'resources', 'feature-steps')
        ]
      }
    );

    FeaturesMapPanel.currentPanel = new FeaturesMapPanel(
      panel,
      extensionUri,
      featuresLoader,
      componentsLoader
    );
  }

  private async handleMessage(message: any) {
    switch (message.type) {
      case 'feature:selected':
        await this.handleFeatureSelected(message.featureKey);
        break;
      case 'flowItem:clicked':
        await this.handleFlowItemClicked(message.implPath);
        break;
      case 'ready':
        this.updateGraph();
        break;
    }
  }

  private async handleFeatureSelected(featureKey: string) {
    const feature = this.featuresLoader.getFeature(featureKey);
    if (!feature) {
      return;
    }

    const statusIcon = this.getStatusIcon(feature.status);
    const info = [
      `${statusIcon} **${feature.name}**`,
      '',
      feature.description || 'No description',
      '',
      `**Status:** ${feature.status || 'in-progress'}`,
      feature.owner ? `**Owner:** ${feature.owner}` : '',
      '',
      feature.components && feature.components.length > 0 
        ? `**Components:** ${feature.components.join(', ')}` 
        : '',
      feature.dependencies && feature.dependencies.length > 0
        ? `**Dependencies:** ${feature.dependencies.join(', ')}`
        : ''
    ].filter(line => line !== '').join('\n');

    vscode.window.showInformationMessage(info);
  }

  private async handleFlowItemClicked(implPath: string) {
    if (!implPath) {
      return;
    }

    try {
      // Resolve the file path relative to workspace root
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const fullPath = vscode.Uri.file(implPath.startsWith('/') 
        ? implPath 
        : `${workspaceRoot}/${implPath}`);

      // Open the file in the editor
      const document = await vscode.workspace.openTextDocument(fullPath);
      await vscode.window.showTextDocument(document);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open file: ${implPath}`);
      console.error('[Features Map] Error opening file:', error);
    }
  }

  private getStatusIcon(status?: string): string {
    switch (status) {
      case 'completed': return '✅';
      case 'in-progress': return '🔄';
      case 'planned': return '📋';
      case 'deprecated': return '⚠️';
      default: return '🔄';
    }
  }

  public updateGraph() {
    const featuresConfig = this.featuresLoader.getConfig();
    const componentsConfig = this.componentsLoader.getConfig();

    if (!featuresConfig) {
      this.panel.webview.postMessage({
        type: 'error',
        message: 'No radium-features.yaml found. Create one to visualize features.'
      });
      return;
    }

    const graphData = this.buildFeaturesGraph(featuresConfig, componentsConfig);
    
    this.panel.webview.postMessage({
      type: 'graph:update',
      data: graphData
    });
  }

  private buildFeaturesGraph(featuresConfig: any, componentsConfig: any) {
    const nodes: any[] = [];
    const edges: any[] = [];
    let nodeId = 1;

    // Group features by area
    const featuresByArea = new Map<string, Array<[string, FeatureConfig]>>();
    for (const [featureKey, feature] of Object.entries(featuresConfig.features)) {
      const featureData = feature as FeatureConfig;
      const area = featureData.area || 'General';
      
      if (!featuresByArea.has(area)) {
        featuresByArea.set(area, []);
      }
      featuresByArea.get(area)!.push([featureKey, featureData]);
    }

    // Create feature nodes and determine hierarchy
    const featureMap = new Map<string, number>();
    const flowItemMap = new Map<string, number[]>(); // featureKey -> array of flow item node IDs
    const allFeatureKeys = new Set(Object.keys(featuresConfig.features));
    
    // Create feature nodes with area info and flow items
    for (const [featureKey, feature] of Object.entries(featuresConfig.features)) {
      const featureData = feature as FeatureConfig;
      const featureNodeId = nodeId++;
      featureMap.set(featureKey, featureNodeId);

      nodes.push({
        id: featureNodeId,
        label: featureData.name,
        type: 'feature',
        status: featureData.status || 'in-progress',
        description: featureData.description,
        owner: featureData.owner,
        key: featureKey,
        area: featureData.area || 'General',
        hasFlow: featureData.flow && featureData.flow.length > 0
      });

      // Create flow item nodes if flow exists
      if (featureData.flow && featureData.flow.length > 0) {
        const flowNodeIds: number[] = [];
        
        for (let i = 0; i < featureData.flow.length; i++) {
          const flowItem = featureData.flow[i];
          const flowNodeId = nodeId++;
          flowNodeIds.push(flowNodeId);

          nodes.push({
            id: flowNodeId,
            label: flowItem.name,
            type: 'flow-item',
            flowType: flowItem.type,
            description: flowItem.description,
            impl: flowItem.impl,
            featureKey: featureKey,
            flowIndex: i
          });

          // Create edge from feature to first flow item
          if (i === 0) {
            edges.push({
              source: featureNodeId,
              target: flowNodeId,
              type: 'feature-to-flow'
            });
          }

          // Create edge from previous flow item to current flow item
          if (i > 0) {
            edges.push({
              source: flowNodeIds[i - 1],
              target: flowNodeId,
              type: 'flow-sequence'
            });
          }
        }

        flowItemMap.set(featureKey, flowNodeIds);
      }
    }

    console.log('[Backend] Built graph with', nodes.length, 'nodes and', edges.length, 'edges');
    console.log('[Backend] Features by area:', Array.from(featuresByArea.keys()));
    console.log('[Backend] Sample nodes:', nodes.slice(0, 3));
    
    return { nodes, edges, featuresByArea: Array.from(featuresByArea.entries()).map(([area, features]) => ({
      area,
      features: features.map(([key]) => key)
    })) };
  }

  private getHtmlContent(extensionUri: vscode.Uri): string {
    // Get URIs for the flow type icons
    const systemIconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'resources', 'feature-steps', 'system.png')
    );
    const userIconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'resources', 'feature-steps', 'user.png')
    );
    const uiIconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'resources', 'feature-steps', 'ui.png')
    );
    const outboundApiIconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'resources', 'feature-steps', 'outbound_api.png')
    );
    const inboundApiIconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'resources', 'feature-steps', 'inbound_api.png')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Radium: Features Map</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      overflow-y: auto;
    }
    
    #container {
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .area-section {
      margin-bottom: 30px;
    }
    
    .area-header {
      font-size: 24px;
      font-weight: 600;
      color: #4a9eff;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 2px solid #4a9eff;
    }
    
    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 15px;
    }
    
    .feature-box {
      background: #2d2d2d;
      border: 2px solid #444;
      border-radius: 8px;
      padding: 15px;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    
    .feature-box:hover {
      border-color: #4a9eff;
      box-shadow: 0 4px 12px rgba(74, 158, 255, 0.3);
    }
    
    .feature-box.expanded {
      grid-column: 1 / -1;
      border-color: #4a9eff;
    }
    
    .feature-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .feature-name {
      font-size: 18px;
      font-weight: 600;
      color: #d4d4d4;
    }
    
    .feature-description {
      margin-top: 10px;
      font-size: 14px;
      color: #999;
    }
    
    .feature-flow {
      margin-top: 20px;
      display: none;
    }
    
    .feature-box.expanded .feature-flow {
      display: block;
    }
    
    .flow-container {
      display: flex;
      align-items: center;
      gap: 20px;
      overflow-x: auto;
      padding: 20px 0;
    }
    
    .flow-item {
      min-width: 200px;
      background: #3d3d3d;
      border: 2px solid;
      border-radius: 8px;
      padding: 15px;
      position: relative;
    }
    
    .flow-item.user {
      border-color: #9c27b0;
    }
    
    .flow-item.ui {
      border-color: #ff9800;
    }
    
    .flow-item.logic {
      border-color: #4caf50;
    }
    
    .flow-item.inbound_api {
      border-color: #f44336;
    }
    
    .flow-item.outbound_api {
      border-color: #e91e63;
    }
    
    .flow-type {
      font-size: 11px;
      font-weight: bold;
      text-transform: uppercase;
      color: #999;
      margin-bottom: 8px;
    }
    
    .flow-name {
      font-size: 16px;
      font-weight: 500;
      color: #d4d4d4;
      margin-bottom: 5px;
    }
    
    .flow-description {
      font-size: 13px;
      color: #999;
    }
    
    .flow-arrow {
      font-size: 24px;
      color: #666;
    }
    
    .expand-icon {
      font-size: 20px;
      color: #4a9eff;
      transition: transform 0.3s ease;
    }
    
    .feature-box.expanded .expand-icon {
      transform: rotate(180deg);
    }
    
    .error-message {
      text-align: center;
      padding: 30px;
      background: rgba(30, 30, 30, 0.95);
      border: 1px solid #444;
      border-radius: 8px;
      max-width: 500px;
      margin: 50px auto;
    }
    
    .error-message h2 {
      color: #f44336;
      margin-top: 0;
    }
  </style>
</head>
<body>
  <div id="container"></div>
  
  <script>
    const vscode = acquireVsCodeApi();
    let currentData = null;
    let expandedFeature = null;
    
    // Notify ready
    vscode.postMessage({ type: 'ready' });
    
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'graph:update':
          renderFeatures(message.data);
          break;
        case 'error':
          showError(message.message);
          break;
      }
    });
    
    function showError(message) {
      const container = document.getElementById('container');
      container.innerHTML = \`
        <div class="error-message">
          <h2>⚠️ Configuration Missing</h2>
          <p>\${message}</p>
          <p style="margin-top: 20px; color: #888;">
            See documentation for radium-features.yaml format.
          </p>
        </div>
      \`;
    }
    
    function renderFeatures(data) {
      currentData = data;
      const container = document.getElementById('container');
      
      // Create a map of nodes by key for easy lookup
      const nodeMap = new Map();
      data.nodes.forEach(node => {
        nodeMap.set(node.key, node);
      });
      
      // Group features by area
      const featuresByArea = new Map();
      data.nodes.filter(n => n.type === 'feature').forEach(feature => {
        const area = feature.area || 'General';
        if (!featuresByArea.has(area)) {
          featuresByArea.set(area, []);
        }
        featuresByArea.get(area).push(feature);
      });
      
      // Build HTML for all areas
      let html = '';
      for (const [area, features] of featuresByArea.entries()) {
        html += \`
          <div class="area-section">
            <div class="area-header">\${area}</div>
            <div class="features-grid">
        \`;
        
        features.forEach(feature => {
          const flowItems = data.nodes.filter(n => 
            n.type === 'flow-item' && n.featureKey === feature.key
          ).sort((a, b) => a.flowIndex - b.flowIndex);
          
          html += \`
            <div class="feature-box" data-feature-key="\${feature.key}">
              <div class="feature-header">
                <div class="feature-name">\${feature.label}</div>
                <span class="expand-icon">▼</span>
              </div>
              \${feature.description ? \`<div class="feature-description">\${feature.description}</div>\` : ''}
              \${flowItems.length > 0 ? \`
                <div class="feature-flow">
                  <div class="flow-container">
                    \${flowItems.map((item, idx) => \`
                      \${idx > 0 ? '<div class="flow-arrow">→</div>' : ''}
                      <div class="flow-item \${item.flowType}" \${item.impl ? \`data-impl="\${item.impl}"\` : ''}>
                        <div class="flow-type">&lt;&lt;\${item.flowType}&gt;&gt;</div>
                        <div class="flow-name">\${item.label}</div>
                        \${item.description ? \`<div class="flow-description">\${item.description}</div>\` : ''}
                      </div>
                    \`).join('')}
                  </div>
                </div>
              \` : ''}
            </div>
          \`;
        });
        
        html += \`
            </div>
          </div>
        \`;
      }
      
      container.innerHTML = html;
      
      // Add click handlers
      document.querySelectorAll('.feature-box').forEach(box => {
        box.addEventListener('click', (e) => {
          const featureKey = box.getAttribute('data-feature-key');
          
          // Check if clicking on a flow item with impl
          if (e.target.closest('.flow-item')) {
            const flowItem = e.target.closest('.flow-item');
            const impl = flowItem.getAttribute('data-impl');
            if (impl) {
              vscode.postMessage({
                type: 'flowItem:clicked',
                implPath: impl
              });
              e.stopPropagation();
              return;
            }
          }
          
          // Toggle expansion
          const wasExpanded = box.classList.contains('expanded');
          
          // Collapse all boxes
          document.querySelectorAll('.feature-box').forEach(b => {
            b.classList.remove('expanded');
          });
          
          // Expand clicked box if it wasn't expanded
          if (!wasExpanded) {
            box.classList.add('expanded');
            expandedFeature = featureKey;
          } else {
            expandedFeature = null;
          }
        });
      });
    }
  </script>
</body>
</html>`;
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
}

import * as vscode from 'vscode';
import { FeaturesConfigLoader, FeatureConfig } from '../config/features-config';
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
      'Radium Features Map',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
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
      `**Components:** ${feature.components.join(', ')}`,
      feature.dependencies && feature.dependencies.length > 0
        ? `**Dependencies:** ${feature.dependencies.join(', ')}`
        : ''
    ].filter(line => line !== '').join('\n');

    vscode.window.showInformationMessage(info);
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

    // Create a map of component keys to component info
    const componentMap = new Map<string, any>();
    if (componentsConfig) {
      for (const [key, component] of Object.entries(componentsConfig.projectSpec.components)) {
        componentMap.set(key, { id: nodeId++, key, component });
      }
    }

    // Create feature nodes
    const featureMap = new Map<string, number>();
    
    // Determine top-level features (those with no dependencies or dependencies to non-existent features)
    const allFeatureKeys = new Set(Object.keys(featuresConfig.features));
    const topLevelFeatures = new Set<string>();
    
    for (const [featureKey, feature] of Object.entries(featuresConfig.features)) {
      const featureData = feature as FeatureConfig;
      const hasValidDependencies = featureData.dependencies && 
        featureData.dependencies.length > 0 &&
        featureData.dependencies.some(dep => allFeatureKeys.has(dep));
      
      if (!hasValidDependencies) {
        topLevelFeatures.add(featureKey);
      }
    }
    
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
        isTopLevel: topLevelFeatures.has(featureKey)
      });
    }

    // Create component nodes (only those referenced by features)
    const usedComponents = new Set<string>();
    for (const feature of Object.values(featuresConfig.features)) {
      const featureData = feature as FeatureConfig;
      for (const componentKey of featureData.components) {
        usedComponents.add(componentKey);
      }
    }

    const componentNodeMap = new Map<string, number>();
    for (const componentKey of usedComponents) {
      const componentInfo = componentMap.get(componentKey);
      const componentNodeId = nodeId++;
      componentNodeMap.set(componentKey, componentNodeId);

      nodes.push({
        id: componentNodeId,
        label: componentInfo?.component?.name || componentKey,
        type: 'component',
        description: componentInfo?.component?.description,
        key: componentKey
      });
    }

    // Create edges from features to components
    for (const [featureKey, feature] of Object.entries(featuresConfig.features)) {
      const featureData = feature as FeatureConfig;
      const featureNodeId = featureMap.get(featureKey);

      for (const componentKey of featureData.components) {
        const componentNodeId = componentNodeMap.get(componentKey);
        if (featureNodeId && componentNodeId) {
          edges.push({
            source: featureNodeId,
            target: componentNodeId,
            type: 'uses'
          });
        }
      }

      // Create edges for feature dependencies
      if (featureData.dependencies) {
        for (const depKey of featureData.dependencies) {
          const depNodeId = featureMap.get(depKey);
          if (depNodeId && featureNodeId) {
            edges.push({
              source: featureNodeId,
              target: depNodeId,
              type: 'depends-on'
            });
          }
        }
      }
    }

    return { nodes, edges };
  }

  private getHtmlContent(extensionUri: vscode.Uri): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Radium Features Map</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    #container {
      width: 100vw;
      height: 100vh;
      position: relative;
    }
    
    svg {
      width: 100%;
      height: 100%;
    }
    
    .node {
      cursor: pointer;
      transition: all 0.2s;
    }
    
    .node:hover {
      filter: brightness(1.3);
    }
    
    .feature-node {
      fill: #4a9eff;
      stroke: #2d7dd2;
      stroke-width: 2px;
    }
    
    .component-node {
      fill: #00bcd4;
      stroke: #0097a7;
      stroke-width: 2px;
    }
    
    .node-label {
      fill: white;
      font-size: 12px;
      text-anchor: middle;
      pointer-events: none;
      font-weight: 500;
    }
    
    .node-label.top-level {
      font-size: 32px;
      font-weight: 700;
    }
    
    .edge {
      stroke: #666;
      stroke-width: 2px;
      fill: none;
      opacity: 0.6;
    }
    
    .edge.uses {
      stroke: #4a9eff;
    }
    
    .edge.depends-on {
      stroke: #ff9800;
      stroke-dasharray: 5,5;
    }
    
    .legend {
      position: absolute;
      top: 20px;
      right: 20px;
      background: rgba(30, 30, 30, 0.9);
      border: 1px solid #444;
      border-radius: 4px;
      padding: 15px;
      font-size: 12px;
    }
    
    .legend-item {
      display: flex;
      align-items: center;
      margin: 8px 0;
    }
    
    .legend-color {
      width: 20px;
      height: 20px;
      border-radius: 3px;
      margin-right: 10px;
      border: 1px solid #666;
    }
    
    .error-message {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      padding: 30px;
      background: rgba(30, 30, 30, 0.95);
      border: 1px solid #444;
      border-radius: 8px;
      max-width: 500px;
    }
    
    .error-message h2 {
      color: #f44336;
      margin-top: 0;
    }
  </style>
</head>
<body>
  <div id="container">
    <svg id="graph"></svg>
    <div class="legend">
      <div style="font-weight: bold; margin-bottom: 10px;">Features Map</div>
      <div class="legend-item">
        <div class="legend-color" style="background: #4a9eff;"></div>
        <span>Feature</span>
      </div>
      <div class="legend-item">
        <div class="legend-color" style="background: #00bcd4;"></div>
        <span>Component</span>
      </div>
      <div class="legend-item">
        <div style="width: 20px; height: 2px; background: #4a9eff; margin-right: 10px;"></div>
        <span>Uses</span>
      </div>
      <div class="legend-item">
        <div style="width: 20px; height: 2px; background: #ff9800; margin-right: 10px; border-top: 2px dashed #ff9800;"></div>
        <span>Depends On</span>
      </div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    let simulation;
    let currentData = null;
    
    // Notify ready
    vscode.postMessage({ type: 'ready' });
    
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'graph:update':
          renderGraph(message.data);
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
    
    function renderGraph(data) {
      currentData = data;
      
      const svg = d3.select('#graph');
      svg.selectAll('*').remove();
      
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      const g = svg.append('g');
      
      // Add zoom behavior
      const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });
      
      svg.call(zoom);
      
      // Create force simulation with dynamic collision radius
      simulation = d3.forceSimulation(data.nodes)
        .force('link', d3.forceLink(data.edges)
          .id(d => d.id)
          .distance(d => {
            // Longer distance for top-level features
            const source = data.nodes.find(n => n.id === d.source.id || n.id === d.source);
            const target = data.nodes.find(n => n.id === d.target.id || n.id === d.target);
            if (source?.isTopLevel || target?.isTopLevel) {
              return 400;
            }
            return 150;
          }))
        .force('charge', d3.forceManyBody().strength(d => d.isTopLevel ? -1000 : -300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => {
          // Larger collision radius for top-level features
          if (d.type === 'feature' && d.isTopLevel) {
            return 220; // Half of width (400/2) + padding
          } else if (d.type === 'feature') {
            return 60;
          } else {
            return 50;
          }
        }));
      
      // Draw edges
      const edges = g.append('g')
        .selectAll('line')
        .data(data.edges)
        .enter()
        .append('line')
        .attr('class', d => \`edge \${d.type}\`);
      
      // Draw nodes
      const nodes = g.append('g')
        .selectAll('g')
        .data(data.nodes)
        .enter()
        .append('g')
        .attr('class', 'node')
        .call(d3.drag()
          .on('start', dragStarted)
          .on('drag', dragged)
          .on('end', dragEnded))
        .on('click', (event, d) => {
          if (d.type === 'feature') {
            vscode.postMessage({
              type: 'feature:selected',
              featureKey: d.key
            });
          }
        });
      
      // Add shapes based on type
      nodes.each(function(d) {
        const node = d3.select(this);
        
        if (d.type === 'feature') {
          // Top-level features are 4x larger
          const width = d.isTopLevel ? 400 : 100;
          const height = d.isTopLevel ? 240 : 60;
          const rx = d.isTopLevel ? 10 : 5;
          
          node.append('rect')
            .attr('class', 'feature-node')
            .attr('width', width)
            .attr('height', height)
            .attr('x', -width / 2)
            .attr('y', -height / 2)
            .attr('rx', rx);
            
          // Add tooltip
          node.append('title')
            .text(\`\${d.label}\${d.description ? '\\n\\n' + d.description : ''}\`);
        } else if (d.type === 'component') {
          node.append('rect')
            .attr('class', 'component-node')
            .attr('width', 90)
            .attr('height', 50)
            .attr('x', -45)
            .attr('y', -25)
            .attr('rx', 3);
            
          // Add tooltip
          node.append('title')
            .text(\`\${d.label}\${d.description ? '\\n\\n' + d.description : ''}\`);
        }
      });
      
      // Add labels
      nodes.append('text')
        .attr('class', d => d.isTopLevel ? 'node-label top-level' : 'node-label')
        .attr('dy', 5)
        .text(d => {
          if (d.type === 'feature' && d.isTopLevel) {
            // Top-level features can show more text
            const maxLen = 35;
            return d.label.length > maxLen 
              ? d.label.substring(0, maxLen) + '...'
              : d.label;
          } else {
            const maxLen = d.type === 'feature' ? 12 : 10;
            return d.label.length > maxLen 
              ? d.label.substring(0, maxLen) + '...'
              : d.label;
          }
        });
      
      // Update positions on tick
      simulation.on('tick', () => {
        edges
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        
        nodes.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
      });
      
      // Initial zoom to fit
      setTimeout(() => {
        const bounds = g.node().getBBox();
        const fullWidth = bounds.width;
        const fullHeight = bounds.height;
        const midX = bounds.x + fullWidth / 2;
        const midY = bounds.y + fullHeight / 2;
        
        const scale = 0.8 / Math.max(fullWidth / width, fullHeight / height);
        const translate = [width / 2 - scale * midX, height / 2 - scale * midY];
        
        svg.transition()
          .duration(750)
          .call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
      }, 500);
    }
    
    function dragStarted(event, d) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }
    
    function dragged(event, d) {
      d.fx = event.x;
      d.fy = event.y;
    }
    
    function dragEnded(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }
    
    // Handle window resize
    window.addEventListener('resize', () => {
      if (currentData) {
        renderGraph(currentData);
      }
    });
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


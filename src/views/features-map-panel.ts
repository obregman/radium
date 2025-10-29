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

    // Create a map of component keys to component info
    const componentMap = new Map<string, any>();
    if (componentsConfig) {
      for (const [key, component] of Object.entries(componentsConfig.projectSpec.components)) {
        componentMap.set(key, { id: nodeId++, key, component });
      }
    }

    // Create feature nodes and determine hierarchy
    const featureMap = new Map<string, number>();
    const flowItemMap = new Map<string, number[]>(); // featureKey -> array of flow item node IDs
    const allFeatureKeys = new Set(Object.keys(featuresConfig.features));
    
    // Build parent-child relationships
    const childrenMap = new Map<string, Set<string>>(); // parent -> children
    const parentMap = new Map<string, string>(); // child -> parent
    
    for (const [featureKey, feature] of Object.entries(featuresConfig.features)) {
      const featureData = feature as FeatureConfig;
      
      // A feature's parent is its first valid dependency
      if (featureData.dependencies && featureData.dependencies.length > 0) {
        const validDep = featureData.dependencies.find(dep => allFeatureKeys.has(dep));
        if (validDep) {
          parentMap.set(featureKey, validDep);
          if (!childrenMap.has(validDep)) {
            childrenMap.set(validDep, new Set());
          }
          childrenMap.get(validDep)!.add(featureKey);
        }
      }
    }
    
    // Identify root features (those with no parent)
    const rootFeatures = new Set<string>();
    for (const featureKey of allFeatureKeys) {
      if (!parentMap.has(featureKey)) {
        rootFeatures.add(featureKey);
      }
    }
    
    // Create feature nodes with hierarchy info and flow items
    for (const [featureKey, feature] of Object.entries(featuresConfig.features)) {
      const featureData = feature as FeatureConfig;
      const featureNodeId = nodeId++;
      featureMap.set(featureKey, featureNodeId);

      const parent = parentMap.get(featureKey);
      const children = childrenMap.get(featureKey);

      nodes.push({
        id: featureNodeId,
        label: featureData.name,
        type: 'feature',
        status: featureData.status || 'in-progress',
        description: featureData.description,
        owner: featureData.owner,
        key: featureKey,
        isRoot: rootFeatures.has(featureKey),
        parent: parent,
        children: children ? Array.from(children) : [],
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

    // Create component nodes (only those referenced by features)
    const usedComponents = new Set<string>();
    for (const feature of Object.values(featuresConfig.features)) {
      const featureData = feature as FeatureConfig;
      if (featureData.components) {
        for (const componentKey of featureData.components) {
          usedComponents.add(componentKey);
        }
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

      if (featureData.components) {
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
      }

      // Create edges for parent-child relationships
      const parent = parentMap.get(featureKey);
      if (parent) {
        const parentNodeId = featureMap.get(parent);
        if (parentNodeId && featureNodeId) {
          edges.push({
            source: parentNodeId,
            target: featureNodeId,
            type: 'parent-child'
          });
        }
      }
    }

    console.log('[Backend] Built graph with', nodes.length, 'nodes and', edges.length, 'edges');
    console.log('[Backend] Root features:', Array.from(rootFeatures));
    console.log('[Backend] Sample nodes:', nodes.slice(0, 3));
    
    return { nodes, edges, rootFeatures: Array.from(rootFeatures) };
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
    
    .flow-item-node {
      stroke-width: 2px;
    }
    
    .flow-item-node.user {
      fill: #9c27b0;
      stroke: #7b1fa2;
    }
    
    .flow-item-node.window {
      fill: #ff9800;
      stroke: #f57c00;
    }
    
    .flow-item-node.system {
      fill: #4caf50;
      stroke: #388e3c;
    }
    
    .flow-item-node.api {
      fill: #f44336;
      stroke: #d32f2f;
    }
    
    .flow-item-node.database {
      fill: #607d8b;
      stroke: #455a64;
    }
    
    .node-label {
      fill: white;
      font-size: 14px;
      text-anchor: middle;
      pointer-events: none;
      font-weight: 500;
    }
    
    .feature-node-label {
      fill: white;
      font-size: 28px;
      text-anchor: start;
      pointer-events: none;
      font-weight: 600;
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
    
    .edge.parent-child {
      stroke: #888;
      stroke-width: 3px;
    }
    
    .edge.feature-to-flow {
      stroke: #9c27b0;
      stroke-width: 2px;
      stroke-dasharray: 5, 5;
    }
    
    .edge.flow-sequence {
      stroke: #666;
      stroke-width: 3px;
      marker-end: url(#arrowhead);
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
      
      // Add arrowhead marker for flow sequences
      const defs = svg.append('defs');
      defs.append('marker')
        .attr('id', 'arrowhead')
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 9)
        .attr('refY', 5)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M 0 0 L 10 5 L 0 10 z')
        .attr('fill', '#666');
      
      // Add zoom behavior
      const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .wheelDelta((event) => {
          // When Shift is held, zoom twice as fast
          const multiplier = event.shiftKey ? 2 : 1;
          return -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * (event.ctrlKey ? 10 : 1) * multiplier;
        })
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });
      
      svg.call(zoom);
      
      // Constants for layout
      const VERTICAL_SPACING = 100;
      const HORIZONTAL_SPACING = 40;
      const TREE_SPACING = 120;
      const FLOW_SPACING = 100; // Increased spacing between flow items
      const FLOW_VERTICAL_OFFSET = 120;
      const PADDING_X = 30; // Increased padding for feature boxes
      const PADDING_Y = 20; // Increased padding for feature boxes
      const CHAR_WIDTH = 10; // Increased character width for larger text
      const MIN_WIDTH = 180; // Increased minimum width for features
      const MIN_HEIGHT = 80; // Increased minimum height for features
      const FLOW_ITEM_WIDTH = 160; // Width for flow items
      const FLOW_ITEM_HEIGHT = 70; // Height for type label + text
      
      // Helper function to calculate box dimensions based on text
      function getBoxDimensions(label, type) {
        if (type === 'flow-item') {
          // Calculate dynamic width and height based on label length
          const labelCharWidth = 8; // Character width for flow item text
          const minFlowWidth = 160;
          const maxFlowWidth = 280; // Maximum width before wrapping to second line
          const flowPadding = 30;
          const lineHeight = 16;
          const typeHeight = 20; // Height for <<type>> label
          const baseHeight = 50; // Base height for single line
          
          const estimatedWidth = label.length * labelCharWidth + flowPadding;
          
          // If text is too long, use max width and calculate height for 2 lines
          if (estimatedWidth > maxFlowWidth) {
            const calculatedHeight = typeHeight + (lineHeight * 2) + 20; // 2 lines + padding
            return { width: maxFlowWidth, height: calculatedHeight };
          }
          
          // Otherwise use calculated width with single line height
          const calculatedWidth = Math.max(minFlowWidth, estimatedWidth);
          return { width: calculatedWidth, height: baseHeight + typeHeight };
        }
        const textWidth = label.length * CHAR_WIDTH;
        const width = Math.max(MIN_WIDTH, textWidth + PADDING_X * 2);
        const height = type === 'component' ? MIN_HEIGHT : MIN_HEIGHT + 10;
        return { width, height };
      }
      
      // Pre-calculate dimensions for all nodes
      const nodeDimensions = new Map();
      data.nodes.forEach(node => {
        nodeDimensions.set(node.id, getBoxDimensions(node.label, node.type));
      });
      
      // Build hierarchical structure
      const nodeMap = new Map();
      data.nodes.forEach(n => nodeMap.set(n.id, n));
      
      // Create D3 hierarchy from features
      const featureNodes = data.nodes.filter(n => n.type === 'feature');
      const componentNodes = data.nodes.filter(n => n.type === 'component');
      const flowItemNodes = data.nodes.filter(n => n.type === 'flow-item');
      
      // Build tree structure
      const rootNodes = featureNodes.filter(n => n.isRoot);
      
      console.log('[Frontend] Total nodes:', data.nodes.length);
      console.log('[Frontend] Feature nodes:', featureNodes.length);
      console.log('[Frontend] Root nodes:', rootNodes.length);
      console.log('[Frontend] Component nodes:', componentNodes.length);
      console.log('[Frontend] Sample feature node:', featureNodes[0]);
      console.log('[Frontend] Sample root node:', rootNodes[0]);
      
      if (rootNodes.length === 0 && featureNodes.length > 0) {
        console.warn('[Frontend] No root nodes found! All features have parents.');
        // Fallback: treat all features as roots
        featureNodes.forEach(f => f.isRoot = true);
        rootNodes.push(...featureNodes);
      }
      
      const positionedNodes = new Map();
      
      // Helper function to calculate tree width recursively
      function calculateTreeWidth(nodeKey) {
        const node = featureNodes.find(n => n.key === nodeKey);
        if (!node) return MIN_WIDTH;
        
        const nodeDim = nodeDimensions.get(node.id);
        const nodeWidth = nodeDim ? nodeDim.width : MIN_WIDTH;
        
        const children = featureNodes.filter(n => n.parent === nodeKey);
        if (children.length === 0) {
          return nodeWidth;
        }
        
        let totalWidth = 0;
        children.forEach((child, idx) => {
          totalWidth += calculateTreeWidth(child.key);
          if (idx < children.length - 1) {
            totalWidth += HORIZONTAL_SPACING;
          }
        });
        
        return Math.max(nodeWidth, totalWidth);
      }
      
      // Helper function to position a subtree
      function positionSubtree(nodeKey, centerX, y) {
        const node = featureNodes.find(n => n.key === nodeKey);
        if (!node) return;
        
        // Position this node at center
        positionedNodes.set(node.id, { x: centerX, y: y });
        
        // Find children
        const children = featureNodes.filter(n => n.parent === nodeKey);
        if (children.length === 0) return;
        
        // Calculate total width needed for children
        const childWidths = children.map(child => calculateTreeWidth(child.key));
        const totalChildWidth = childWidths.reduce((sum, w) => sum + w, 0) + 
                                (children.length - 1) * HORIZONTAL_SPACING;
        
        // Position children centered below parent
        let childX = centerX - totalChildWidth / 2;
        const childY = y + VERTICAL_SPACING;
        
        children.forEach((child, idx) => {
          const childWidth = childWidths[idx];
          const childCenterX = childX + childWidth / 2;
          
          positionSubtree(child.key, childCenterX, childY);
          
          childX += childWidth + HORIZONTAL_SPACING;
        });
      }
      
      // Position features with name on left and flows on right
      const FEATURE_NAME_WIDTH = 300; // Width reserved for feature name on left
      const FEATURE_NAME_X = 100; // X position for feature names
      const FLOW_START_X = FEATURE_NAME_X + FEATURE_NAME_WIDTH + 80; // Start X for flow items
      let currentY = 100;
      const FEATURE_VERTICAL_SPACING = 250; // Space between feature rows
      
      // Calculate positions for features and their flows
      featureNodes.forEach((feature) => {
        // Get flow items for this feature
        const featureFlowItems = flowItemNodes.filter(f => f.featureKey === feature.key).sort((a, b) => a.flowIndex - b.flowIndex);
        
        if (feature.hasFlow && featureFlowItems.length > 0) {
          // Calculate flow row dimensions
          const flowItemWidths = featureFlowItems.map(item => {
            const dim = nodeDimensions.get(item.id);
            return dim ? dim.width : FLOW_ITEM_WIDTH;
          });
          const maxFlowItemHeight = Math.max(...featureFlowItems.map(item => {
            const dim = nodeDimensions.get(item.id);
            return dim ? dim.height : FLOW_ITEM_HEIGHT;
          }));
          
          // Position feature name on the left, vertically centered with flow
          positionedNodes.set(feature.id, { 
            x: FEATURE_NAME_X,
            y: currentY
          });
          
          // Position flow items horizontally starting from FLOW_START_X
          let flowX = FLOW_START_X;
          const flowY = currentY;
          
          featureFlowItems.forEach(flowItem => {
            const itemWidth = flowItemWidths[featureFlowItems.indexOf(flowItem)];
            positionedNodes.set(flowItem.id, { x: flowX + itemWidth / 2, y: flowY });
            flowX += itemWidth + FLOW_SPACING;
          });
          
          // Move down for next feature row
          currentY += FEATURE_VERTICAL_SPACING;
        } else {
          // Feature without flows - just show name on left
          positionedNodes.set(feature.id, { 
            x: FEATURE_NAME_X,
            y: currentY
          });
          
          currentY += FEATURE_VERTICAL_SPACING;
        }
      });
      
      // Position components at the bottom if any exist
      if (componentNodes.length > 0) {
        let compX = 150;
        const compY = currentY + 100;
        componentNodes.forEach(comp => {
          if (!positionedNodes.has(comp.id)) {
            const dim = nodeDimensions.get(comp.id);
            const compWidth = dim ? dim.width : MIN_WIDTH;
            positionedNodes.set(comp.id, { x: compX + compWidth / 2, y: compY });
            compX += compWidth + HORIZONTAL_SPACING;
          }
        });
      }
      
      // Apply positions to nodes
      data.nodes.forEach(node => {
        const pos = positionedNodes.get(node.id);
        if (pos) {
          node.x = pos.x;
          node.y = pos.y;
        }
      });
      
      console.log('[Frontend] Positioned nodes:', positionedNodes.size);
      console.log('[Frontend] Sample node positions:', Array.from(positionedNodes.entries()).slice(0, 3));
      console.log('[Frontend] Nodes with x,y:', data.nodes.filter(n => n.x !== undefined && n.y !== undefined).length);
      
      // Draw edges
      const edges = g.append('g')
        .selectAll('path')
        .data(data.edges)
        .enter()
        .append('path')
        .attr('class', d => \`edge \${d.type}\`)
        .attr('d', d => {
          const source = nodeMap.get(d.source);
          const target = nodeMap.get(d.target);
          if (!source || !target) return '';
          
          const sourceDim = nodeDimensions.get(source.id) || { width: MIN_WIDTH, height: MIN_HEIGHT };
          const targetDim = nodeDimensions.get(target.id) || { width: MIN_WIDTH, height: MIN_HEIGHT };
          
          // For parent-child relationships, draw straight lines
          if (d.type === 'parent-child') {
            return \`M \${source.x} \${source.y + sourceDim.height/2} 
                    L \${target.x} \${target.y - targetDim.height/2}\`;
          }
          
          // For feature-to-flow relationships, don't draw (feature is now container)
          if (d.type === 'feature-to-flow') {
            return '';
          }
          
          // For flow-sequence relationships, draw straight lines with arrows
          if (d.type === 'flow-sequence') {
            const startX = source.x + sourceDim.width/2;
            const endX = target.x - targetDim.width/2;
            return \`M \${startX} \${source.y} 
                    L \${endX} \${target.y}\`;
          }
          
          // For uses relationships, draw curved lines
          const midY = (source.y + target.y) / 2;
          return \`M \${source.x} \${source.y + sourceDim.height/2} 
                  Q \${source.x} \${midY}, \${(source.x + target.x) / 2} \${midY}
                  T \${target.x} \${target.y - targetDim.height/2}\`;
        })
        .attr('fill', 'none');
      
      // Draw nodes
      const nodes = g.append('g')
        .selectAll('g')
        .data(data.nodes.filter(n => n.x !== undefined && n.y !== undefined))
        .enter()
        .append('g')
        .attr('class', 'node')
        .attr('transform', d => \`translate(\${d.x},\${d.y})\`)
        .on('click', (event, d) => {
          if (d.type === 'feature') {
            vscode.postMessage({
              type: 'feature:selected',
              featureKey: d.key
            });
          } else if (d.type === 'flow-item' && d.impl) {
            vscode.postMessage({
              type: 'flowItem:clicked',
              implPath: d.impl
            });
          }
        });
      
      console.log('[Frontend] Drew', nodes.size(), 'nodes');
      
      // Add shapes based on type
      nodes.each(function(d) {
        const node = d3.select(this);
        const dim = nodeDimensions.get(d.id) || { width: MIN_WIDTH, height: MIN_HEIGHT };
        
        if (d.type === 'feature') {
          // Features are now just text labels (container box drawn separately)
          // Add tooltip
          node.append('title')
            .text(\`\${d.label}\${d.description ? '\\n\\n' + d.description : ''}\`);
        } else if (d.type === 'component') {
          node.append('rect')
            .attr('class', 'component-node')
            .attr('width', dim.width)
            .attr('height', dim.height)
            .attr('x', -dim.width / 2)
            .attr('y', -dim.height / 2)
            .attr('rx', 4);
            
          // Add tooltip
          node.append('title')
            .text(\`\${d.label}\${d.description ? '\\n\\n' + d.description : ''}\`);
        } else if (d.type === 'flow-item') {
          node.append('rect')
            .attr('class', \`flow-item-node \${d.flowType}\`)
            .attr('width', dim.width)
            .attr('height', dim.height)
            .attr('x', -dim.width / 2)
            .attr('y', -dim.height / 2)
            .attr('rx', 8)
            .style('cursor', d.impl ? 'pointer' : 'default');
            
          // Add tooltip
          const tooltipText = \`\${d.flowType.toUpperCase()}: \${d.label}\${d.description ? '\\n\\n' + d.description : ''}\${d.impl ? '\\n\\nClick to open: ' + d.impl : ''}\`;
          node.append('title')
            .text(tooltipText);
        }
      });
      
      // Add labels - show full text since boxes are sized to fit
      nodes.each(function(d) {
        const node = d3.select(this);
        
        if (d.type === 'flow-item') {
          // For flow items, add type label at top and wrap text if needed
          const lineHeight = 16;
          const dim = nodeDimensions.get(d.id) || { width: FLOW_ITEM_WIDTH, height: FLOW_ITEM_HEIGHT };
          const maxWidth = dim.width - 20;
          
          // Get icon for flow type
          const getFlowIcon = (flowType) => {
            switch(flowType) {
              case 'user': return '👤';
              case 'window': return '🪟';
              case 'system': return '⚙️';
              case 'api': return '☁️';
              case 'database': return '🗄️';
              default: return '📦';
            }
          };
          
          // Add icon above the box (larger)
          node.append('text')
            .attr('class', 'flow-icon')
            .attr('dy', -dim.height / 2 - 25)
            .style('font-size', '40px')
            .style('text-anchor', 'middle')
            .text(getFlowIcon(d.flowType));
          
          // Add type label at top of box with << >>
          node.append('text')
            .attr('class', 'node-label')
            .attr('dy', -dim.height / 2 + 16)
            .style('font-size', '11px')
            .style('font-weight', 'bold')
            .text(\`<<\${d.flowType}>>\`);
          
          // Add main label text below type
          const words = d.label.split(/\\s+/);
          let line = [];
          let lineNumber = 0;
          const lines = [];
          
          words.forEach(word => {
            line.push(word);
            const testLine = line.join(' ');
            if (testLine.length * 8 > maxWidth && line.length > 1) {
              line.pop();
              lines.push(line.join(' '));
              line = [word];
              lineNumber++;
            }
          });
          if (line.length > 0) {
            lines.push(line.join(' '));
          }
          
          // Start text below type label
          const startY = -(lines.length - 1) * lineHeight / 2 + 18;
          lines.forEach((lineText, i) => {
            node.append('text')
              .attr('class', 'node-label')
              .attr('dy', startY + i * lineHeight)
              .text(lineText);
          });
        } else if (d.type === 'feature') {
          // Feature name on the left side
          const lineHeight = 28;
          const maxWidth = 280;
          const words = d.label.split(/\\s+/);
          const charWidth = 14;
          
          let line = [];
          const lines = [];
          
          words.forEach(word => {
            line.push(word);
            const testLine = line.join(' ');
            const estimatedWidth = testLine.length * charWidth;
            if (estimatedWidth > maxWidth && line.length > 1) {
              line.pop();
              lines.push(line.join(' '));
              line = [word];
            }
          });
          if (line.length > 0) {
            lines.push(line.join(' '));
          }
          
          // Calculate vertical offset to center text
          const totalHeight = lines.length * lineHeight;
          const startY = -(totalHeight / 2) + lineHeight;
          
          lines.forEach((lineText, i) => {
            node.append('text')
              .attr('class', 'feature-node-label')
              .attr('x', 0)
              .attr('y', startY + (i * lineHeight))
              .attr('text-anchor', 'start')
              .style('font-size', '24px')
              .style('font-weight', '600')
              .style('fill', '#4a9eff')
              .text(lineText);
          });
        } else {
          // For components, use standard centered label
          node.append('text')
            .attr('class', 'node-label')
            .attr('dy', 5)
            .text(d.label);
        }
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
      }, 100);
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


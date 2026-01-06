/**
 * Development server for testing Radium panels in a browser
 * 
 * This server extracts the HTML content from the actual panel classes
 * and serves them with a mock VS Code API, avoiding code duplication.
 * 
 * Usage: npx ts-node dev/panel-server.ts [panel-name]
 *   panel-name: files-map | symbol-changes | codebase-map
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const PORT = 3000;

// Panel configurations
interface PanelConfig {
  name: string;
  sourceFile: string;
  mockDataFn: string;
  title: string;
}

const PANELS: Record<string, PanelConfig> = {
  'files-map': {
    name: 'FilesMapPanel',
    sourceFile: 'src/views/files-map-panel.ts',
    mockDataFn: 'getFilesMapMockDataScript',
    title: 'Files Map'
  },
  'symbol-changes': {
    name: 'SymbolChangesPanel',
    sourceFile: 'src/views/symbol-changes-panel.ts',
    mockDataFn: 'getSymbolChangesMockDataScript',
    title: 'Symbol Changes'
  },
  'codebase-map': {
    name: 'CodebaseMapPanel',
    sourceFile: 'src/views/codebase-map-panel.ts',
    mockDataFn: 'getCodebaseMapMockDataScript',
    title: 'Codebase Map'
  }
};

/**
 * Extracts the HTML content from a panel's getHtmlContent method
 */
function extractPanelHtml(panelKey: string): string {
  const config = PANELS[panelKey];
  if (!config) {
    throw new Error(`Unknown panel: ${panelKey}. Available: ${Object.keys(PANELS).join(', ')}`);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const sourceFilePath = path.join(projectRoot, config.sourceFile);
  
  if (!fs.existsSync(sourceFilePath)) {
    throw new Error(`Source file not found: ${sourceFilePath}`);
  }

  const sourceCode = fs.readFileSync(sourceFilePath, 'utf-8');
  
  // Extract HTML content between getHtmlContent method and the closing backtick
  // The pattern looks for: return `<!DOCTYPE html> ... </html>`; or return String.raw`<!DOCTYPE html> ... </html>`;
  const htmlMatch = sourceCode.match(/private\s+getHtmlContent\([^)]*\):\s*string\s*\{[\s\S]*?return\s*(?:String\.raw)?`(<!DOCTYPE html>[\s\S]*?<\/html>)`/);
  
  if (!htmlMatch) {
    throw new Error(`Could not extract HTML content from ${config.sourceFile}`);
  }

  let html = htmlMatch[1];
  
  // Remove only specific template literal expressions that are VS Code-specific
  // Do NOT remove JavaScript template literals like ${type} inside the code
  html = html.replace(/\$\{nonce\}/g, 'dev-nonce');
  html = html.replace(/\$\{extensionUri\}/g, '');
  html = html.replace(/\$\{cspSource\}/g, "'self'");
  html = html.replace(/\$\{buttonLabel\}/g, '🗑️ Clear All');
  html = html.replace(/\$\{buttonTitle\}/g, 'Clear all symbols');
  
  // Unescape backticks and dollar signs that were escaped in the source template literal
  // In the TypeScript source, backticks inside template literals are written as \` 
  // We need to convert them to actual backticks for the browser
  html = html.replace(/\\`/g, '`');
  html = html.replace(/\\\$/g, '$');
  
  // Remove nonce attributes from script tags (they prevent inline scripts in browser)
  html = html.replace(/\s+nonce="[^"]*"/g, '');
  
  return html;
}

/**
 * Injects mock VS Code API into the HTML
 */
function injectMockApi(html: string, panelKey: string): string {
  const mockApiScript = getMockApiScript(panelKey);
  
  // Inject the mock API script right after <head> and before any other scripts
  // This ensures acquireVsCodeApi is defined before the panel scripts run
  const headEndIndex = html.indexOf('</head>');
  if (headEndIndex === -1) {
    throw new Error('Could not find </head> tag in HTML');
  }
  
  // Inject fallback CSS for VS Code variables (they don't exist in regular browsers)
  const fallbackCss = `
    <style>
      /* Fallback CSS variables for running outside VS Code */
      :root {
        --vscode-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        --vscode-editor-background: #1e1e1e;
        --vscode-editor-foreground: #d4d4d4;
        --vscode-button-background: #0e639c;
        --vscode-button-foreground: #ffffff;
        --vscode-button-hoverBackground: #1177bb;
        --vscode-input-background: #3c3c3c;
        --vscode-input-foreground: #cccccc;
        --vscode-input-border: #3c3c3c;
        --vscode-focusBorder: #007acc;
        --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.4);
        --vscode-scrollbarSlider-hoverBackground: rgba(100, 100, 100, 0.7);
        --vscode-panel-border: #80808059;
        --vscode-sideBar-background: #252526;
        --vscode-list-hoverBackground: #2a2d2e;
        --vscode-list-activeSelectionBackground: #094771;
        --vscode-textLink-foreground: #3794ff;
        --vscode-descriptionForeground: #8a8a8a;
      }
      
      /* Debug status indicator */
      #dev-status {
        position: fixed;
        top: 10px;
        right: 10px;
        background: #333;
        color: #0f0;
        padding: 8px 12px;
        border-radius: 4px;
        font-family: monospace;
        font-size: 12px;
        z-index: 99999;
        max-width: 300px;
        word-wrap: break-word;
      }
      #dev-status.error { color: #f55; }
    </style>
  `;
  
  // Add a status indicator div
  const statusDiv = `
    <div id="dev-status">🔄 Loading...</div>
    <script>
      window.__devLog = function(msg, isError) {
        const el = document.getElementById('dev-status');
        if (el) {
          el.textContent = msg;
          el.className = isError ? 'error' : '';
        }
        console.log('[Dev]', msg);
      };
      window.onerror = function(msg, url, line) {
        window.__devLog('❌ Error: ' + msg + ' (line ' + line + ')', true);
        return false;
      };
    </script>
  `;
  
  let modifiedHtml = html.slice(0, headEndIndex) + fallbackCss + statusDiv + mockApiScript + html.slice(headEndIndex);
  
  // Remove or relax CSP for local development - replace with permissive CSP
  modifiedHtml = modifiedHtml.replace(
    /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/gi,
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' \'unsafe-inline\' \'unsafe-eval\' data: https:;">'
  );
  
  return modifiedHtml;
}

/**
 * Gets the mock API script for a specific panel
 */
function getMockApiScript(panelKey: string): string {
  const config = PANELS[panelKey];
  
  // Get the appropriate mock data script
  let mockDataScript = '';
  switch (panelKey) {
    case 'files-map':
      mockDataScript = getFilesMapMockDataScript();
      break;
    case 'symbol-changes':
      mockDataScript = getSymbolChangesMockDataScript();
      break;
    case 'codebase-map':
      mockDataScript = getCodebaseMapMockDataScript();
      break;
  }

  return `
    <script>
      // Mock VS Code API for local development
      // This allows the panel to run in a regular browser without VS Code
      console.log('[Mock VS Code] Initializing mock API...');
      
      (function() {
        const mockVscode = {
          postMessage: function(message) {
            console.log('[Mock VS Code] postMessage called:', message.type, message);
            if (window.__handleWebviewMessage) {
              console.log('[Mock VS Code] Calling __handleWebviewMessage');
              window.__handleWebviewMessage(message);
            } else {
              console.error('[Mock VS Code] __handleWebviewMessage not defined!');
            }
          },
          getState: function() {
            const state = localStorage.getItem('__vscode_webview_state');
            return state ? JSON.parse(state) : undefined;
          },
          setState: function(state) {
            localStorage.setItem('__vscode_webview_state', JSON.stringify(state));
            return state;
          }
        };
        
        window.acquireVsCodeApi = function() {
          console.log('[Mock VS Code] acquireVsCodeApi called');
          return mockVscode;
        };
        
        window.__postMessageToWebview = function(message) {
          console.log('[Mock VS Code] Dispatching message event to webview:', message.type, message);
          window.dispatchEvent(new MessageEvent('message', { data: message }));
        };
        
        console.log('[Mock VS Code] Mock API initialized');
      })();
    </script>
    <script>
      console.log('[Mock Data] Loading mock data script...');
      ${mockDataScript}
      console.log('[Mock Data] Mock data script loaded, __handleWebviewMessage:', typeof window.__handleWebviewMessage);
    </script>
  `;
}

// Inline mock data scripts (copied from mock-vscode-api.ts to avoid import issues)
function getFilesMapMockDataScript(): string {
  return `
    // Helper function to calculate size from lines (same formula as the extension)
    function calcSize(lines) {
      const MIN_WIDTH = 160, MAX_WIDTH = 360, MAX_LINES = 3000;
      if (lines <= 1) return MIN_WIDTH;
      if (lines >= MAX_LINES) return MAX_WIDTH;
      return MIN_WIDTH + ((lines - 1) / (MAX_LINES - 1)) * (MAX_WIDTH - MIN_WIDTH);
    }
    
    const mockGraphData = {
      nodes: [
        // Root directories
        { id: 'dir:src', type: 'directory', label: 'src', path: 'src', fileCount: 18, depth: 0 },
        { id: 'dir:test', type: 'directory', label: 'test', path: 'test', fileCount: 8, depth: 0 },
        
        // src subdirectories
        { id: 'dir:src/services', type: 'directory', label: 'services', path: 'src/services', fileCount: 12, depth: 1 },
        { id: 'dir:src/utils', type: 'directory', label: 'utils', path: 'src/utils', fileCount: 12, depth: 1 },
        { id: 'dir:src/components', type: 'directory', label: 'components', path: 'src/components', fileCount: 12, depth: 1 },
        { id: 'dir:src/models', type: 'directory', label: 'models', path: 'src/models', fileCount: 12, depth: 1 },
        
        // test subdirectories
        { id: 'dir:test/unit', type: 'directory', label: 'unit', path: 'test/unit', fileCount: 12, depth: 1 },
        { id: 'dir:test/integration', type: 'directory', label: 'integration', path: 'test/integration', fileCount: 12, depth: 1 },
        
        // Root level files
        { 
          id: 'file:src/index.ts', type: 'file', label: 'index.ts', path: 'src/index.ts',
          lines: 150, lang: 'typescript', size: calcSize(150), exportedSymbols: 5, smellScore: 15,
          smellDetails: { functionCount: 8, avgFunctionLength: 18, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 6 },
          functions: ['main()', 'init()', 'setup()', 'configure()', 'run()'],
          variables: ['config', 'logger'],
          types: ['AppConfig', 'Logger']
        },
        { 
          id: 'file:src/app.ts', type: 'file', label: 'app.ts', path: 'src/app.ts',
          lines: 280, lang: 'typescript', size: calcSize(280), exportedSymbols: 7, smellScore: 18,
          smellDetails: { functionCount: 10, avgFunctionLength: 20, maxFunctionLength: 50, maxNestingDepth: 3, importCount: 9 },
          functions: ['createApp()', 'startApp()', 'stopApp()'],
          variables: ['appInstance', 'routes'],
          types: ['App', 'Route']
        },
        
        // Services
        { 
          id: 'file:src/services/auth.ts', type: 'file', label: 'auth.ts', path: 'src/services/auth.ts',
          lines: 450, lang: 'typescript', size: calcSize(450), exportedSymbols: 8, smellScore: 25,
          smellDetails: { functionCount: 12, avgFunctionLength: 15, maxFunctionLength: 35, maxNestingDepth: 4, importCount: 8 },
          functions: ['login()', 'logout()', 'validateToken()', 'refreshToken()', 'hashPassword()'],
          variables: ['tokenCache', 'sessionStore'],
          types: ['User', 'Session', 'AuthConfig']
        },
        { 
          id: 'file:src/services/api.ts', type: 'file', label: 'api.ts', path: 'src/services/api.ts',
          lines: 320, lang: 'typescript', size: calcSize(320), exportedSymbols: 6, smellScore: 20,
          smellDetails: { functionCount: 10, avgFunctionLength: 16, maxFunctionLength: 40, maxNestingDepth: 3, importCount: 5 },
          functions: ['fetch()', 'post()', 'put()', 'delete()', 'handleError()'],
          variables: ['baseUrl', 'headers'],
          types: ['ApiResponse', 'ApiError']
        },
        { 
          id: 'file:src/services/database.ts', type: 'file', label: 'database.ts', path: 'src/services/database.ts',
          lines: 520, lang: 'typescript', size: calcSize(520), exportedSymbols: 10, smellScore: 30,
          smellDetails: { functionCount: 15, avgFunctionLength: 22, maxFunctionLength: 60, maxNestingDepth: 4, importCount: 7 },
          functions: ['connect()', 'disconnect()', 'query()', 'insert()', 'update()', 'delete()'],
          variables: ['connection', 'pool'],
          types: ['Database', 'QueryResult', 'Connection']
        },
        { 
          id: 'file:src/services/cache.ts', type: 'file', label: 'cache.ts', path: 'src/services/cache.ts',
          lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 5, smellScore: 12,
          smellDetails: { functionCount: 8, avgFunctionLength: 14, maxFunctionLength: 30, maxNestingDepth: 2, importCount: 3 },
          functions: ['get()', 'set()', 'delete()', 'clear()'],
          variables: ['cacheStore'],
          types: ['CacheConfig']
        },
        
        // Utils
        { 
          id: 'file:src/utils/helpers.ts', type: 'file', label: 'helpers.ts', path: 'src/utils/helpers.ts',
          lines: 100, lang: 'typescript', size: calcSize(100), exportedSymbols: 10, smellScore: 10,
          smellDetails: { functionCount: 15, avgFunctionLength: 6, maxFunctionLength: 15, maxNestingDepth: 2, importCount: 2 },
          functions: ['formatDate()', 'parseJSON()', 'debounce()', 'throttle()', 'deepClone()'],
          variables: [],
          types: []
        },
        { 
          id: 'file:src/utils/logger.ts', type: 'file', label: 'logger.ts', path: 'src/utils/logger.ts',
          lines: 80, lang: 'typescript', size: calcSize(80), exportedSymbols: 4, smellScore: 8,
          smellDetails: { functionCount: 5, avgFunctionLength: 12, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 1 },
          functions: ['log()', 'warn()', 'error()', 'debug()'],
          variables: ['logLevel'],
          types: ['LogLevel']
        },
        { 
          id: 'file:src/utils/validator.ts', type: 'file', label: 'validator.ts', path: 'src/utils/validator.ts',
          lines: 220, lang: 'typescript', size: calcSize(220), exportedSymbols: 8, smellScore: 16,
          smellDetails: { functionCount: 12, avgFunctionLength: 14, maxFunctionLength: 35, maxNestingDepth: 3, importCount: 4 },
          functions: ['validateEmail()', 'validatePassword()', 'validatePhone()', 'sanitize()'],
          variables: ['patterns'],
          types: ['ValidationRule', 'ValidationResult']
        },
        { 
          id: 'file:src/utils/crypto.ts', type: 'file', label: 'crypto.ts', path: 'src/utils/crypto.ts',
          lines: 140, lang: 'typescript', size: calcSize(140), exportedSymbols: 6, smellScore: 14,
          smellDetails: { functionCount: 7, avgFunctionLength: 16, maxFunctionLength: 40, maxNestingDepth: 2, importCount: 2 },
          functions: ['encrypt()', 'decrypt()', 'hash()', 'generateKey()'],
          variables: ['algorithm'],
          types: ['CryptoConfig']
        },
        
        // Components
        { 
          id: 'file:src/components/Button.tsx', type: 'file', label: 'Button.tsx', path: 'src/components/Button.tsx',
          lines: 95, lang: 'typescript', size: calcSize(95), exportedSymbols: 2, smellScore: 8,
          smellDetails: { functionCount: 3, avgFunctionLength: 12, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 3 },
          functions: ['Button()'],
          variables: [],
          types: ['ButtonProps']
        },
        { 
          id: 'file:src/components/Input.tsx', type: 'file', label: 'Input.tsx', path: 'src/components/Input.tsx',
          lines: 110, lang: 'typescript', size: calcSize(110), exportedSymbols: 2, smellScore: 9,
          smellDetails: { functionCount: 4, avgFunctionLength: 13, maxFunctionLength: 28, maxNestingDepth: 2, importCount: 4 },
          functions: ['Input()'],
          variables: [],
          types: ['InputProps']
        },
        { 
          id: 'file:src/components/Modal.tsx', type: 'file', label: 'Modal.tsx', path: 'src/components/Modal.tsx',
          lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 3, smellScore: 15,
          smellDetails: { functionCount: 6, avgFunctionLength: 18, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 5 },
          functions: ['Modal()', 'useModal()'],
          variables: [],
          types: ['ModalProps']
        },
        { 
          id: 'file:src/components/Table.tsx', type: 'file', label: 'Table.tsx', path: 'src/components/Table.tsx',
          lines: 340, lang: 'typescript', size: calcSize(340), exportedSymbols: 5, smellScore: 22,
          smellDetails: { functionCount: 11, avgFunctionLength: 20, maxFunctionLength: 55, maxNestingDepth: 4, importCount: 7 },
          functions: ['Table()', 'TableRow()', 'TableCell()'],
          variables: [],
          types: ['TableProps', 'Column']
        },
        { 
          id: 'file:src/components/Form.tsx', type: 'file', label: 'Form.tsx', path: 'src/components/Form.tsx',
          lines: 260, lang: 'typescript', size: calcSize(260), exportedSymbols: 4, smellScore: 18,
          smellDetails: { functionCount: 9, avgFunctionLength: 17, maxFunctionLength: 42, maxNestingDepth: 3, importCount: 6 },
          functions: ['Form()', 'useForm()'],
          variables: [],
          types: ['FormProps', 'FormState']
        },
        
        // Models
        { 
          id: 'file:src/models/User.ts', type: 'file', label: 'User.ts', path: 'src/models/User.ts',
          lines: 120, lang: 'typescript', size: calcSize(120), exportedSymbols: 3, smellScore: 10,
          smellDetails: { functionCount: 6, avgFunctionLength: 10, maxFunctionLength: 20, maxNestingDepth: 2, importCount: 2 },
          functions: [],
          variables: [],
          types: ['User', 'UserRole', 'UserPermissions']
        },
        { 
          id: 'file:src/models/Product.ts', type: 'file', label: 'Product.ts', path: 'src/models/Product.ts',
          lines: 90, lang: 'typescript', size: calcSize(90), exportedSymbols: 2, smellScore: 8,
          smellDetails: { functionCount: 4, avgFunctionLength: 8, maxFunctionLength: 18, maxNestingDepth: 1, importCount: 1 },
          functions: [],
          variables: [],
          types: ['Product', 'ProductCategory']
        },
        { 
          id: 'file:src/models/Order.ts', type: 'file', label: 'Order.ts', path: 'src/models/Order.ts',
          lines: 150, lang: 'typescript', size: calcSize(150), exportedSymbols: 4, smellScore: 12,
          smellDetails: { functionCount: 7, avgFunctionLength: 12, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 3 },
          functions: [],
          variables: [],
          types: ['Order', 'OrderItem', 'OrderStatus', 'PaymentMethod']
        },
        
        // Tests
        { 
          id: 'file:test/unit/auth.test.ts', type: 'file', label: 'auth.test.ts', path: 'test/unit/auth.test.ts',
          lines: 280, lang: 'typescript', size: calcSize(280), exportedSymbols: 0, smellScore: 5,
          smellDetails: { functionCount: 15, avgFunctionLength: 12, maxFunctionLength: 30, maxNestingDepth: 2, importCount: 5 },
          functions: [],
          variables: [],
          types: []
        },
        { 
          id: 'file:test/unit/api.test.ts', type: 'file', label: 'api.test.ts', path: 'test/unit/api.test.ts',
          lines: 220, lang: 'typescript', size: calcSize(220), exportedSymbols: 0, smellScore: 5,
          smellDetails: { functionCount: 12, avgFunctionLength: 11, maxFunctionLength: 28, maxNestingDepth: 2, importCount: 4 },
          functions: [],
          variables: [],
          types: []
        },
        { 
          id: 'file:test/unit/helpers.test.ts', type: 'file', label: 'helpers.test.ts', path: 'test/unit/helpers.test.ts',
          lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 0, smellScore: 4,
          smellDetails: { functionCount: 20, avgFunctionLength: 7, maxFunctionLength: 15, maxNestingDepth: 1, importCount: 2 },
          functions: [],
          variables: [],
          types: []
        },
        { 
          id: 'file:test/unit/validator.test.ts', type: 'file', label: 'validator.test.ts', path: 'test/unit/validator.test.ts',
          lines: 240, lang: 'typescript', size: calcSize(240), exportedSymbols: 0, smellScore: 5,
          smellDetails: { functionCount: 18, avgFunctionLength: 9, maxFunctionLength: 22, maxNestingDepth: 2, importCount: 3 },
          functions: [],
          variables: [],
          types: []
        },
        { 
          id: 'file:test/unit/crypto.test.ts', type: 'file', label: 'crypto.test.ts', path: 'test/unit/crypto.test.ts',
          lines: 160, lang: 'typescript', size: calcSize(160), exportedSymbols: 0, smellScore: 4,
          smellDetails: { functionCount: 10, avgFunctionLength: 10, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 2 },
          functions: [],
          variables: [],
          types: []
        },
        { 
          id: 'file:test/integration/auth-flow.test.ts', type: 'file', label: 'auth-flow.test.ts', path: 'test/integration/auth-flow.test.ts',
          lines: 320, lang: 'typescript', size: calcSize(320), exportedSymbols: 0, smellScore: 6,
          smellDetails: { functionCount: 8, avgFunctionLength: 25, maxFunctionLength: 60, maxNestingDepth: 3, importCount: 8 },
          functions: [],
          variables: [],
          types: []
        },
        { 
          id: 'file:test/integration/api-flow.test.ts', type: 'file', label: 'api-flow.test.ts', path: 'test/integration/api-flow.test.ts',
          lines: 280, lang: 'typescript', size: calcSize(280), exportedSymbols: 0, smellScore: 6,
          smellDetails: { functionCount: 7, avgFunctionLength: 22, maxFunctionLength: 55, maxNestingDepth: 3, importCount: 7 },
          functions: [],
          variables: [],
          types: []
        },
        { 
          id: 'file:test/integration/database.test.ts', type: 'file', label: 'database.test.ts', path: 'test/integration/database.test.ts',
          lines: 380, lang: 'typescript', size: calcSize(380), exportedSymbols: 0, smellScore: 7,
          smellDetails: { functionCount: 10, avgFunctionLength: 28, maxFunctionLength: 70, maxNestingDepth: 4, importCount: 6 },
          functions: [],
          variables: [],
          types: []
        }
      ],
      edges: [
        // Directory containment
        { source: 'dir:src', target: 'dir:src/services', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/utils', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/components', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/models', type: 'contains' },
        { source: 'dir:src', target: 'file:src/index.ts', type: 'contains' },
        { source: 'dir:src', target: 'file:src/app.ts', type: 'contains' },
        { source: 'dir:test', target: 'dir:test/unit', type: 'contains' },
        { source: 'dir:test', target: 'dir:test/integration', type: 'contains' },
        
        // Services
        { source: 'dir:src/services', target: 'file:src/services/auth.ts', type: 'contains' },
        { source: 'dir:src/services', target: 'file:src/services/api.ts', type: 'contains' },
        { source: 'dir:src/services', target: 'file:src/services/database.ts', type: 'contains' },
        { source: 'dir:src/services', target: 'file:src/services/cache.ts', type: 'contains' },
        
        // Utils
        { source: 'dir:src/utils', target: 'file:src/utils/helpers.ts', type: 'contains' },
        { source: 'dir:src/utils', target: 'file:src/utils/logger.ts', type: 'contains' },
        { source: 'dir:src/utils', target: 'file:src/utils/validator.ts', type: 'contains' },
        { source: 'dir:src/utils', target: 'file:src/utils/crypto.ts', type: 'contains' },
        
        // Components
        { source: 'dir:src/components', target: 'file:src/components/Button.tsx', type: 'contains' },
        { source: 'dir:src/components', target: 'file:src/components/Input.tsx', type: 'contains' },
        { source: 'dir:src/components', target: 'file:src/components/Modal.tsx', type: 'contains' },
        { source: 'dir:src/components', target: 'file:src/components/Table.tsx', type: 'contains' },
        { source: 'dir:src/components', target: 'file:src/components/Form.tsx', type: 'contains' },
        
        // Models
        { source: 'dir:src/models', target: 'file:src/models/User.ts', type: 'contains' },
        { source: 'dir:src/models', target: 'file:src/models/Product.ts', type: 'contains' },
        { source: 'dir:src/models', target: 'file:src/models/Order.ts', type: 'contains' },
        
        // Unit tests
        { source: 'dir:test/unit', target: 'file:test/unit/auth.test.ts', type: 'contains' },
        { source: 'dir:test/unit', target: 'file:test/unit/api.test.ts', type: 'contains' },
        { source: 'dir:test/unit', target: 'file:test/unit/helpers.test.ts', type: 'contains' },
        { source: 'dir:test/unit', target: 'file:test/unit/validator.test.ts', type: 'contains' },
        { source: 'dir:test/unit', target: 'file:test/unit/crypto.test.ts', type: 'contains' },
        
        // Integration tests
        { source: 'dir:test/integration', target: 'file:test/integration/auth-flow.test.ts', type: 'contains' },
        { source: 'dir:test/integration', target: 'file:test/integration/api-flow.test.ts', type: 'contains' },
        { source: 'dir:test/integration', target: 'file:test/integration/database.test.ts', type: 'contains' },
        
        // Main app imports
        { source: 'file:src/index.ts', target: 'file:src/app.ts', type: 'imports', weight: 5 },
        { source: 'file:src/index.ts', target: 'file:src/services/auth.ts', type: 'imports', weight: 3 },
        { source: 'file:src/index.ts', target: 'file:src/services/api.ts', type: 'imports', weight: 2 },
        { source: 'file:src/index.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 1 },
        { source: 'file:src/app.ts', target: 'file:src/services/database.ts', type: 'imports', weight: 4 },
        { source: 'file:src/app.ts', target: 'file:src/services/cache.ts', type: 'imports', weight: 2 },
        { source: 'file:src/app.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 3 },
        
        // Service dependencies
        { source: 'file:src/services/auth.ts', target: 'file:src/services/database.ts', type: 'imports', weight: 5 },
        { source: 'file:src/services/auth.ts', target: 'file:src/services/cache.ts', type: 'imports', weight: 3 },
        { source: 'file:src/services/auth.ts', target: 'file:src/utils/crypto.ts', type: 'imports', weight: 4 },
        { source: 'file:src/services/auth.ts', target: 'file:src/utils/validator.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/auth.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/auth.ts', target: 'file:src/models/User.ts', type: 'imports', weight: 6 },
        { source: 'file:src/services/api.ts', target: 'file:src/utils/helpers.ts', type: 'imports', weight: 3 },
        { source: 'file:src/services/api.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/database.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 4 },
        { source: 'file:src/services/cache.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 1 },
        
        // Component dependencies
        { source: 'file:src/components/Form.tsx', target: 'file:src/components/Input.tsx', type: 'imports', weight: 4 },
        { source: 'file:src/components/Form.tsx', target: 'file:src/components/Button.tsx', type: 'imports', weight: 3 },
        { source: 'file:src/components/Form.tsx', target: 'file:src/utils/validator.ts', type: 'imports', weight: 2 },
        { source: 'file:src/components/Table.tsx', target: 'file:src/utils/helpers.ts', type: 'imports', weight: 2 },
        { source: 'file:src/components/Modal.tsx', target: 'file:src/components/Button.tsx', type: 'imports', weight: 2 },
        
        // Model usage
        { source: 'file:src/services/database.ts', target: 'file:src/models/User.ts', type: 'imports', weight: 3 },
        { source: 'file:src/services/database.ts', target: 'file:src/models/Product.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/database.ts', target: 'file:src/models/Order.ts', type: 'imports', weight: 2 },
        
        // Test dependencies
        { source: 'file:test/unit/auth.test.ts', target: 'file:src/services/auth.ts', type: 'imports', weight: 1 },
        { source: 'file:test/unit/api.test.ts', target: 'file:src/services/api.ts', type: 'imports', weight: 1 },
        { source: 'file:test/unit/helpers.test.ts', target: 'file:src/utils/helpers.ts', type: 'imports', weight: 1 },
        { source: 'file:test/unit/validator.test.ts', target: 'file:src/utils/validator.ts', type: 'imports', weight: 1 },
        { source: 'file:test/unit/crypto.test.ts', target: 'file:src/utils/crypto.ts', type: 'imports', weight: 1 },
        { source: 'file:test/integration/auth-flow.test.ts', target: 'file:src/services/auth.ts', type: 'imports', weight: 1 },
        { source: 'file:test/integration/api-flow.test.ts', target: 'file:src/services/api.ts', type: 'imports', weight: 1 },
        { source: 'file:test/integration/database.test.ts', target: 'file:src/services/database.ts', type: 'imports', weight: 1 }
      ]
    };
    
    window.__handleWebviewMessage = function(message) {
      switch (message.type) {
        case 'ready':
          console.log('[Mock] Webview ready, sending files graph data...');
          if (window.__devLog) window.__devLog('✅ Ready, sending data...');
          setTimeout(() => {
            console.log('[Mock] Sending graph:update with', mockGraphData.nodes.length, 'nodes');
            if (window.__devLog) window.__devLog('📊 Sent ' + mockGraphData.nodes.length + ' nodes');
            window.__postMessageToWebview({ type: 'graph:update', data: mockGraphData });
          }, 100);
          break;
        case 'layout:load':
          console.log('[Mock] Layout load requested');
          break;
        case 'layout:save':
          console.log('[Mock] Layout save:', message.layout);
          break;
        case 'file:open':
          alert('Would open file: ' + message.filePath);
          break;
        case 'file:copy':
          navigator.clipboard.writeText(message.filePath).then(() => alert('Copied: ' + message.filePath));
          break;
        case 'dir:unpin':
          console.log('[Mock] Unpin:', message.dirPath);
          break;
      }
    };
  `;
}

function getSymbolChangesMockDataScript(): string {
  return `
    // Mock symbol change data with correct structure for symbol-changes-panel
    const mockSymbolChanges = [
      {
        filePath: 'src/services/auth.ts',
        symbol: {
          name: 'login',
          type: 'function',
          changeType: 'modified',
          endLine: 25
        },
        calls: [
          { from: 'login', to: 'findUser', filePath: 'src/services/auth.ts' },
          { from: 'login', to: 'validate', filePath: 'src/services/auth.ts' }
        ],
        timestamp: Date.now() - 60000,
        isNew: false,
        diff: '+ async function login(email, password) {\\n+   const user = await findUser(email);\\n-   return validate(password);\\n+   return validate(user, password);\\n+ }',
        additions: 5,
        deletions: 2,
        fileLineCount: 200,
        comments: ['Added user lookup before validation']
      },
      {
        filePath: 'src/services/api.ts',
        symbol: {
          name: 'fetchData',
          type: 'function',
          changeType: 'added',
          endLine: 45
        },
        calls: [],
        timestamp: Date.now() - 120000,
        isNew: true,
        diff: '+ export async function fetchData<T>(endpoint: string): Promise<T> {\\n+   const response = await fetch(baseUrl + endpoint);\\n+   return response.json();\\n+ }',
        additions: 15,
        deletions: 0,
        fileLineCount: 180
      },
      {
        filePath: 'src/utils/helpers.ts',
        symbol: {
          name: 'formatDate',
          type: 'function',
          changeType: 'modified',
          endLine: 12
        },
        calls: [],
        timestamp: Date.now() - 300000,
        isNew: false,
        diff: '- return date.toISOString();\\n+ return date.toLocaleDateString("en-US");',
        additions: 2,
        deletions: 1,
        fileLineCount: 100
      },
      {
        filePath: 'src/utils/logger.ts',
        symbol: {
          name: 'debug',
          type: 'function',
          changeType: 'deleted',
          endLine: 35
        },
        calls: [],
        timestamp: Date.now() - 600000,
        isNew: false,
        diff: '- export function debug(msg) { console.debug(msg); }',
        additions: 0,
        deletions: 8,
        fileLineCount: 80
      },
      {
        filePath: 'src/services/auth.ts',
        symbol: {
          name: 'User',
          type: 'class',
          changeType: 'modified',
          endLine: 80
        },
        calls: [],
        timestamp: Date.now() - 180000,
        isNew: false,
        diff: '+ private email: string;\\n+ private role: UserRole;',
        additions: 8,
        deletions: 0,
        fileLineCount: 200
      },
      {
        filePath: 'src/services/api.ts',
        symbol: {
          name: 'BASE_URL',
          type: 'variable',
          changeType: 'value_changed',
          endLine: 3
        },
        calls: [],
        timestamp: Date.now() - 90000,
        isNew: false,
        diff: "- const BASE_URL = 'http://localhost:3000';\\n+ const BASE_URL = 'https://api.example.com';",
        additions: 1,
        deletions: 1,
        fileLineCount: 180
      }
    ];
    
    window.__handleWebviewMessage = function(message) {
      switch (message.type) {
        case 'ready':
          console.log('[Mock] Ready message received');
          break;
        case 'clearAll':
          console.log('[Mock] Clear all');
          break;
        case 'symbol:explain':
          alert('Would explain: ' + message.symbolId);
          break;
        case 'symbol:revert':
          alert('Would revert: ' + message.symbolId);
          break;
        case 'openFile':
          alert('Would open: ' + message.filePath + ':' + message.line);
          break;
      }
    };
    
    // Auto-send mock data after page loads (symbol-changes panel doesn't send 'ready')
    setTimeout(() => {
      console.log('[Mock] Auto-sending symbol changes...');
      if (window.__devLog) window.__devLog('✅ Auto-sending symbols...');
      mockSymbolChanges.forEach((data, i) => {
        setTimeout(() => {
          console.log('[Mock] Sending symbol:', data.symbol.name);
          if (window.__devLog) window.__devLog('📝 Symbol ' + (i+1) + '/' + mockSymbolChanges.length + ': ' + data.symbol.name);
          window.__postMessageToWebview({ type: 'symbol:changed', data: data });
        }, i * 400);
      });
    }, 500);
  `;
}

function getCodebaseMapMockDataScript(): string {
  return `
    const mockGraphData = {
      nodes: [
        { id: 'auth.ts:login', name: 'login', type: 'function', filePath: 'src/services/auth.ts', line: 10, size: 25 },
        { id: 'auth.ts:logout', name: 'logout', type: 'function', filePath: 'src/services/auth.ts', line: 25, size: 15 },
        { id: 'auth.ts:User', name: 'User', type: 'class', filePath: 'src/services/auth.ts', line: 1, size: 80 },
        { id: 'api.ts:fetch', name: 'fetch', type: 'function', filePath: 'src/services/api.ts', line: 5, size: 20 },
        { id: 'api.ts:ApiClient', name: 'ApiClient', type: 'class', filePath: 'src/services/api.ts', line: 1, size: 60 },
        { id: 'helpers.ts:formatDate', name: 'formatDate', type: 'function', filePath: 'src/utils/helpers.ts', line: 1, size: 10 },
        { id: 'helpers.ts:parseJSON', name: 'parseJSON', type: 'function', filePath: 'src/utils/helpers.ts', line: 15, size: 12 },
        { id: 'logger.ts:Logger', name: 'Logger', type: 'class', filePath: 'src/utils/logger.ts', line: 1, size: 45 }
      ],
      edges: [
        { source: 'auth.ts:login', target: 'auth.ts:User', type: 'uses', weight: 2 },
        { source: 'auth.ts:logout', target: 'auth.ts:User', type: 'uses', weight: 1 },
        { source: 'api.ts:ApiClient', target: 'api.ts:fetch', type: 'contains', weight: 1 },
        { source: 'auth.ts:login', target: 'api.ts:fetch', type: 'calls', weight: 3 },
        { source: 'auth.ts:login', target: 'helpers.ts:formatDate', type: 'calls', weight: 1 },
        { source: 'api.ts:fetch', target: 'helpers.ts:parseJSON', type: 'calls', weight: 2 },
        { source: 'auth.ts:User', target: 'logger.ts:Logger', type: 'uses', weight: 1 }
      ]
    };
    
    window.__handleWebviewMessage = function(message) {
      switch (message.type) {
        case 'ready':
          console.log('[Mock] Sending codebase graph data...');
          setTimeout(() => window.__postMessageToWebview({ type: 'graph:update', data: mockGraphData }), 100);
          break;
        case 'goToSymbol':
          alert('Would go to: ' + message.filePath + ':' + message.line);
          break;
      }
    };
  `;
}

/**
 * Generates the index page with links to all panels
 */
function getIndexPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Radium Panel Dev Server</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e4e4e4;
    }
    .container {
      text-align: center;
      padding: 40px;
    }
    h1 {
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .subtitle {
      color: #888;
      margin-bottom: 2rem;
    }
    .panels {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      justify-content: center;
    }
    .panel-card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 30px;
      width: 200px;
      text-decoration: none;
      color: inherit;
      transition: all 0.3s ease;
    }
    .panel-card:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: #667eea;
      transform: translateY(-4px);
      box-shadow: 0 10px 40px rgba(102, 126, 234, 0.2);
    }
    .panel-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
    .panel-name {
      font-size: 1.1rem;
      font-weight: 600;
    }
    .panel-desc {
      font-size: 0.85rem;
      color: #888;
      margin-top: 0.5rem;
    }
    .footer {
      margin-top: 3rem;
      font-size: 0.8rem;
      color: #666;
    }
    code {
      background: rgba(255, 255, 255, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Monaco, monospace;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚛️ Radium Dev Server</h1>
    <p class="subtitle">Test extension panels in your browser</p>
    
    <div class="panels">
      <a href="/panel/files-map" class="panel-card">
        <div class="panel-icon">📁</div>
        <div class="panel-name">Files Map</div>
        <div class="panel-desc">Interactive file dependency graph</div>
      </a>
      
      <a href="/panel/symbol-changes" class="panel-card">
        <div class="panel-icon">🔄</div>
        <div class="panel-name">Symbol Changes</div>
        <div class="panel-desc">Real-time code change tracker</div>
      </a>
      
      <a href="/panel/codebase-map" class="panel-card">
        <div class="panel-icon">🗺️</div>
        <div class="panel-name">Codebase Map</div>
        <div class="panel-desc">Symbol relationship graph</div>
      </a>
    </div>
    
    <p class="footer">
      HTML is extracted directly from <code>src/views/*.ts</code> — no duplication!
    </p>
  </div>
</body>
</html>`;
}

/**
 * Creates and starts the HTTP server
 */
function startServer(): void {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);
    const pathname = url.pathname;

    console.log(`[Dev Server] ${req.method} ${pathname}`);

    try {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getIndexPage());
        return;
      }

      // Handle panel requests: /panel/files-map, /panel/symbol-changes, /panel/codebase-map
      const panelMatch = pathname.match(/^\/panel\/([a-z-]+)$/);
      if (panelMatch) {
        const panelKey = panelMatch[1];
        
        if (!PANELS[panelKey]) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`Unknown panel: ${panelKey}\nAvailable: ${Object.keys(PANELS).join(', ')}`);
          return;
        }

        const html = extractPanelHtml(panelKey);
        const htmlWithMock = injectMockApi(html, panelKey);
        
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlWithMock);
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (error) {
      console.error('[Dev Server] Error:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Server error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                  ⚛️  Radium Dev Server                      ║
╠════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                  ║
║                                                            ║
║  Available panels:                                         ║
║    • http://localhost:${PORT}/panel/files-map                 ║
║    • http://localhost:${PORT}/panel/symbol-changes            ║
║    • http://localhost:${PORT}/panel/codebase-map              ║
║                                                            ║
║  Press Ctrl+C to stop                                      ║
╚════════════════════════════════════════════════════════════╝
`);
  });
}

// Run server
startServer();


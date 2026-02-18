/**
 * Development server for testing Radium panels in a browser
 * 
 * This server extracts the HTML content from the actual panel classes
 * and serves them with a mock VS Code API, avoiding code duplication.
 * 
 * Usage: npx ts-node dev/panel-server.ts [panel-name]
 *   panel-name: files-map | symbol-changes | dependency-graph
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
  'dependency-graph': {
    name: 'DependencyGraphPanel',
    sourceFile: 'src/views/dependency-graph-panel.ts',
    mockDataFn: 'getDependencyGraphMockDataScript',
    title: 'Dependency Graph'
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
    case 'dependency-graph':
      mockDataScript = getDependencyGraphMockDataScript();
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
        { id: 'dir:docs', type: 'directory', label: 'docs', path: 'docs', fileCount: 7, depth: 0 },
        { id: 'dir:scripts', type: 'directory', label: 'scripts', path: 'scripts', fileCount: 8, depth: 0 },
        { id: 'dir:config', type: 'directory', label: 'config', path: 'config', fileCount: 6, depth: 0 },
        
        // src subdirectories (level 1)
        { id: 'dir:src/services', type: 'directory', label: 'services', path: 'src/services', fileCount: 4, depth: 1 },
        { id: 'dir:src/AI', type: 'directory', label: 'AI', path: 'src/AI', fileCount: 4, depth: 1 },
        { id: 'dir:src/utils', type: 'directory', label: 'utils', path: 'src/utils', fileCount: 4, depth: 1 },
        { id: 'dir:src/components', type: 'directory', label: 'components', path: 'src/components', fileCount: 0, depth: 1 },
        { id: 'dir:src/models', type: 'directory', label: 'models', path: 'src/models', fileCount: 3, depth: 1 },
        { id: 'dir:src/controllers', type: 'directory', label: 'controllers', path: 'src/controllers', fileCount: 0, depth: 1 },
        { id: 'dir:src/middleware', type: 'directory', label: 'middleware', path: 'src/middleware', fileCount: 7, depth: 1 },
        { id: 'dir:src/routes', type: 'directory', label: 'routes', path: 'src/routes', fileCount: 6, depth: 1 },
        { id: 'dir:src/hooks', type: 'directory', label: 'hooks', path: 'src/hooks', fileCount: 10, depth: 1 },
        { id: 'dir:src/contexts', type: 'directory', label: 'contexts', path: 'src/contexts', fileCount: 5, depth: 1 },
        { id: 'dir:src/types', type: 'directory', label: 'types', path: 'src/types', fileCount: 9, depth: 1 },
        
        // src/components subdirectories (level 2)
        { id: 'dir:src/components/common', type: 'directory', label: 'common', path: 'src/components/common', fileCount: 3, depth: 2 },
        { id: 'dir:src/components/forms', type: 'directory', label: 'forms', path: 'src/components/forms', fileCount: 2, depth: 2 },
        { id: 'dir:src/components/layout', type: 'directory', label: 'layout', path: 'src/components/layout', fileCount: 0, depth: 2 },
        
        // src/components/layout subdirectories (level 3)
        { id: 'dir:src/components/layout/header', type: 'directory', label: 'header', path: 'src/components/layout/header', fileCount: 2, depth: 3 },
        { id: 'dir:src/components/layout/footer', type: 'directory', label: 'footer', path: 'src/components/layout/footer', fileCount: 2, depth: 3 },
        { id: 'dir:src/components/layout/sidebar', type: 'directory', label: 'sidebar', path: 'src/components/layout/sidebar', fileCount: 3, depth: 3 },
        
        // src/controllers subdirectories (level 2)
        { id: 'dir:src/controllers/api', type: 'directory', label: 'api', path: 'src/controllers/api', fileCount: 5, depth: 2 },
        { id: 'dir:src/controllers/admin', type: 'directory', label: 'admin', path: 'src/controllers/admin', fileCount: 3, depth: 2 },
        
        // test subdirectories (level 1)
        { id: 'dir:test/unit', type: 'directory', label: 'unit', path: 'test/unit', fileCount: 0, depth: 1 },
        { id: 'dir:test/integration', type: 'directory', label: 'integration', path: 'test/integration', fileCount: 3, depth: 1 },
        { id: 'dir:test/e2e', type: 'directory', label: 'e2e', path: 'test/e2e', fileCount: 8, depth: 1 },
        { id: 'dir:test/fixtures', type: 'directory', label: 'fixtures', path: 'test/fixtures', fileCount: 10, depth: 1 },
        
        // test/unit subdirectories (level 2)
        { id: 'dir:test/unit/services', type: 'directory', label: 'services', path: 'test/unit/services', fileCount: 0, depth: 2 },
        { id: 'dir:test/unit/utils', type: 'directory', label: 'utils', path: 'test/unit/utils', fileCount: 3, depth: 2 },
        { id: 'dir:test/unit/components', type: 'directory', label: 'components', path: 'test/unit/components', fileCount: 4, depth: 2 },
        
        // test/unit/services subdirectories (level 3)
        { id: 'dir:test/unit/services/auth', type: 'directory', label: 'auth', path: 'test/unit/services/auth', fileCount: 3, depth: 3 },
        { id: 'dir:test/unit/services/api', type: 'directory', label: 'api', path: 'test/unit/services/api', fileCount: 2, depth: 3 },
        
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
        
        // AI directory files
        { 
          id: 'file:src/AI/model.ts', type: 'file', label: 'model.ts', path: 'src/AI/model.ts',
          lines: 280, lang: 'typescript', size: calcSize(280), exportedSymbols: 5, smellScore: 18,
          smellDetails: { functionCount: 8, avgFunctionLength: 20, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 4 },
          functions: ['train()', 'predict()', 'evaluate()'],
          variables: ['weights', 'config'],
          types: ['ModelConfig']
        },
        { 
          id: 'file:src/AI/agent.ts', type: 'file', label: 'agent.ts', path: 'src/AI/agent.ts',
          lines: 320, lang: 'typescript', size: calcSize(320), exportedSymbols: 6, smellScore: 20,
          smellDetails: { functionCount: 10, avgFunctionLength: 18, maxFunctionLength: 40, maxNestingDepth: 3, importCount: 5 },
          functions: ['act()', 'learn()', 'reset()'],
          variables: ['state', 'memory'],
          types: ['AgentConfig', 'State']
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
        
        // Components - common
        { id: 'file:src/components/common/Button.tsx', type: 'file', label: 'Button.tsx', path: 'src/components/common/Button.tsx', lines: 95, lang: 'typescript', size: calcSize(95), exportedSymbols: 2, smellScore: 8, smellDetails: { functionCount: 3, avgFunctionLength: 12, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 3 }, functions: ['Button()'], variables: [], types: ['ButtonProps'] },
        { id: 'file:src/components/common/Modal.tsx', type: 'file', label: 'Modal.tsx', path: 'src/components/common/Modal.tsx', lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 3, smellScore: 15, smellDetails: { functionCount: 6, avgFunctionLength: 18, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 5 }, functions: ['Modal()', 'useModal()'], variables: [], types: ['ModalProps'] },
        { id: 'file:src/components/common/Table.tsx', type: 'file', label: 'Table.tsx', path: 'src/components/common/Table.tsx', lines: 340, lang: 'typescript', size: calcSize(340), exportedSymbols: 5, smellScore: 22, smellDetails: { functionCount: 11, avgFunctionLength: 20, maxFunctionLength: 55, maxNestingDepth: 4, importCount: 7 }, functions: ['Table()', 'TableRow()', 'TableCell()'], variables: [], types: ['TableProps', 'Column'] },
        
        // Components - forms
        { id: 'file:src/components/forms/Input.tsx', type: 'file', label: 'Input.tsx', path: 'src/components/forms/Input.tsx', lines: 110, lang: 'typescript', size: calcSize(110), exportedSymbols: 2, smellScore: 9, smellDetails: { functionCount: 4, avgFunctionLength: 13, maxFunctionLength: 28, maxNestingDepth: 2, importCount: 4 }, functions: ['Input()'], variables: [], types: ['InputProps'] },
        { id: 'file:src/components/forms/Form.tsx', type: 'file', label: 'Form.tsx', path: 'src/components/forms/Form.tsx', lines: 260, lang: 'typescript', size: calcSize(260), exportedSymbols: 4, smellScore: 18, smellDetails: { functionCount: 9, avgFunctionLength: 17, maxFunctionLength: 42, maxNestingDepth: 3, importCount: 6 }, functions: ['Form()', 'useForm()'], variables: [], types: ['FormProps', 'FormState'] },
        
        // Components - layout/header
        { id: 'file:src/components/layout/header/Header.tsx', type: 'file', label: 'Header.tsx', path: 'src/components/layout/header/Header.tsx', lines: 140, lang: 'typescript', size: calcSize(140), exportedSymbols: 2, smellScore: 12, smellDetails: { functionCount: 5, avgFunctionLength: 16, maxFunctionLength: 35, maxNestingDepth: 2, importCount: 4 }, functions: ['Header()'], variables: [], types: ['HeaderProps'] },
        { id: 'file:src/components/layout/header/Navigation.tsx', type: 'file', label: 'Navigation.tsx', path: 'src/components/layout/header/Navigation.tsx', lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 3, smellScore: 14, smellDetails: { functionCount: 6, avgFunctionLength: 18, maxFunctionLength: 40, maxNestingDepth: 3, importCount: 5 }, functions: ['Navigation()'], variables: [], types: ['NavigationProps'] },
        
        // Components - layout/footer
        { id: 'file:src/components/layout/footer/Footer.tsx', type: 'file', label: 'Footer.tsx', path: 'src/components/layout/footer/Footer.tsx', lines: 100, lang: 'typescript', size: calcSize(100), exportedSymbols: 1, smellScore: 9, smellDetails: { functionCount: 3, avgFunctionLength: 14, maxFunctionLength: 28, maxNestingDepth: 2, importCount: 3 }, functions: ['Footer()'], variables: [], types: ['FooterProps'] },
        { id: 'file:src/components/layout/footer/Copyright.tsx', type: 'file', label: 'Copyright.tsx', path: 'src/components/layout/footer/Copyright.tsx', lines: 60, lang: 'typescript', size: calcSize(60), exportedSymbols: 1, smellScore: 6, smellDetails: { functionCount: 1, avgFunctionLength: 12, maxFunctionLength: 12, maxNestingDepth: 1, importCount: 1 }, functions: ['Copyright()'], variables: [], types: [] },
        
        // Components - layout/sidebar
        { id: 'file:src/components/layout/sidebar/Sidebar.tsx', type: 'file', label: 'Sidebar.tsx', path: 'src/components/layout/sidebar/Sidebar.tsx', lines: 200, lang: 'typescript', size: calcSize(200), exportedSymbols: 3, smellScore: 16, smellDetails: { functionCount: 7, avgFunctionLength: 19, maxFunctionLength: 42, maxNestingDepth: 3, importCount: 6 }, functions: ['Sidebar()'], variables: [], types: ['SidebarProps'] },
        { id: 'file:src/components/layout/sidebar/Menu.tsx', type: 'file', label: 'Menu.tsx', path: 'src/components/layout/sidebar/Menu.tsx', lines: 160, lang: 'typescript', size: calcSize(160), exportedSymbols: 2, smellScore: 13, smellDetails: { functionCount: 5, avgFunctionLength: 17, maxFunctionLength: 38, maxNestingDepth: 3, importCount: 4 }, functions: ['Menu()'], variables: [], types: ['MenuProps'] },
        { id: 'file:src/components/layout/sidebar/MenuItem.tsx', type: 'file', label: 'MenuItem.tsx', path: 'src/components/layout/sidebar/MenuItem.tsx', lines: 80, lang: 'typescript', size: calcSize(80), exportedSymbols: 1, smellScore: 8, smellDetails: { functionCount: 2, avgFunctionLength: 14, maxFunctionLength: 26, maxNestingDepth: 2, importCount: 2 }, functions: ['MenuItem()'], variables: [], types: ['MenuItemProps'] },
        
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
        // Unit tests - services/auth
        { id: 'file:test/unit/services/auth/login.test.ts', type: 'file', label: 'login.test.ts', path: 'test/unit/services/auth/login.test.ts', lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 0, smellScore: 4, smellDetails: { functionCount: 12, avgFunctionLength: 11, maxFunctionLength: 28, maxNestingDepth: 2, importCount: 4 }, functions: [], variables: [], types: [] },
        { id: 'file:test/unit/services/auth/logout.test.ts', type: 'file', label: 'logout.test.ts', path: 'test/unit/services/auth/logout.test.ts', lines: 100, lang: 'typescript', size: calcSize(100), exportedSymbols: 0, smellScore: 3, smellDetails: { functionCount: 8, avgFunctionLength: 9, maxFunctionLength: 20, maxNestingDepth: 2, importCount: 3 }, functions: [], variables: [], types: [] },
        { id: 'file:test/unit/services/auth/token.test.ts', type: 'file', label: 'token.test.ts', path: 'test/unit/services/auth/token.test.ts', lines: 140, lang: 'typescript', size: calcSize(140), exportedSymbols: 0, smellScore: 4, smellDetails: { functionCount: 10, avgFunctionLength: 10, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 3 }, functions: [], variables: [], types: [] },
        
        // Unit tests - services/api
        { id: 'file:test/unit/services/api/fetch.test.ts', type: 'file', label: 'fetch.test.ts', path: 'test/unit/services/api/fetch.test.ts', lines: 160, lang: 'typescript', size: calcSize(160), exportedSymbols: 0, smellScore: 4, smellDetails: { functionCount: 11, avgFunctionLength: 10, maxFunctionLength: 26, maxNestingDepth: 2, importCount: 4 }, functions: [], variables: [], types: [] },
        { id: 'file:test/unit/services/api/error-handling.test.ts', type: 'file', label: 'error-handling.test.ts', path: 'test/unit/services/api/error-handling.test.ts', lines: 120, lang: 'typescript', size: calcSize(120), exportedSymbols: 0, smellScore: 3, smellDetails: { functionCount: 9, avgFunctionLength: 9, maxFunctionLength: 22, maxNestingDepth: 2, importCount: 3 }, functions: [], variables: [], types: [] },
        
        // Unit tests - utils
        { id: 'file:test/unit/utils/helpers.test.ts', type: 'file', label: 'helpers.test.ts', path: 'test/unit/utils/helpers.test.ts', lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 0, smellScore: 4, smellDetails: { functionCount: 20, avgFunctionLength: 7, maxFunctionLength: 15, maxNestingDepth: 1, importCount: 2 }, functions: [], variables: [], types: [] },
        { id: 'file:test/unit/utils/validator.test.ts', type: 'file', label: 'validator.test.ts', path: 'test/unit/utils/validator.test.ts', lines: 240, lang: 'typescript', size: calcSize(240), exportedSymbols: 0, smellScore: 5, smellDetails: { functionCount: 18, avgFunctionLength: 9, maxFunctionLength: 22, maxNestingDepth: 2, importCount: 3 }, functions: [], variables: [], types: [] },
        { id: 'file:test/unit/utils/crypto.test.ts', type: 'file', label: 'crypto.test.ts', path: 'test/unit/utils/crypto.test.ts', lines: 160, lang: 'typescript', size: calcSize(160), exportedSymbols: 0, smellScore: 4, smellDetails: { functionCount: 10, avgFunctionLength: 10, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 2 }, functions: [], variables: [], types: [] },
        
        // Unit tests - components
        { id: 'file:test/unit/components/Button.test.tsx', type: 'file', label: 'Button.test.tsx', path: 'test/unit/components/Button.test.tsx', lines: 120, lang: 'typescript', size: calcSize(120), exportedSymbols: 0, smellScore: 3, smellDetails: { functionCount: 8, avgFunctionLength: 10, maxFunctionLength: 22, maxNestingDepth: 2, importCount: 4 }, functions: [], variables: [], types: [] },
        { id: 'file:test/unit/components/Form.test.tsx', type: 'file', label: 'Form.test.tsx', path: 'test/unit/components/Form.test.tsx', lines: 200, lang: 'typescript', size: calcSize(200), exportedSymbols: 0, smellScore: 5, smellDetails: { functionCount: 14, avgFunctionLength: 11, maxFunctionLength: 28, maxNestingDepth: 3, importCount: 5 }, functions: [], variables: [], types: [] },
        { id: 'file:test/unit/components/Table.test.tsx', type: 'file', label: 'Table.test.tsx', path: 'test/unit/components/Table.test.tsx', lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 0, smellScore: 4, smellDetails: { functionCount: 12, avgFunctionLength: 10, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 4 }, functions: [], variables: [], types: [] },
        { id: 'file:test/unit/components/Modal.test.tsx', type: 'file', label: 'Modal.test.tsx', path: 'test/unit/components/Modal.test.tsx', lines: 160, lang: 'typescript', size: calcSize(160), exportedSymbols: 0, smellScore: 4, smellDetails: { functionCount: 11, avgFunctionLength: 10, maxFunctionLength: 24, maxNestingDepth: 2, importCount: 4 }, functions: [], variables: [], types: [] },
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
        },
        
        // Controllers - api
        { id: 'file:src/controllers/api/UserController.ts', type: 'file', label: 'UserController.ts', path: 'src/controllers/api/UserController.ts', lines: 240, lang: 'typescript', size: calcSize(240), exportedSymbols: 6, smellScore: 18, smellDetails: { functionCount: 8, avgFunctionLength: 20, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 5 }, functions: ['getUser()', 'createUser()', 'updateUser()', 'deleteUser()'], variables: [], types: ['UserController'] },
        { id: 'file:src/controllers/api/ProductController.ts', type: 'file', label: 'ProductController.ts', path: 'src/controllers/api/ProductController.ts', lines: 280, lang: 'typescript', size: calcSize(280), exportedSymbols: 7, smellScore: 20, smellDetails: { functionCount: 10, avgFunctionLength: 18, maxFunctionLength: 40, maxNestingDepth: 3, importCount: 6 }, functions: ['getProduct()', 'createProduct()', 'updateProduct()'], variables: [], types: ['ProductController'] },
        { id: 'file:src/controllers/api/OrderController.ts', type: 'file', label: 'OrderController.ts', path: 'src/controllers/api/OrderController.ts', lines: 320, lang: 'typescript', size: calcSize(320), exportedSymbols: 8, smellScore: 22, smellDetails: { functionCount: 12, avgFunctionLength: 19, maxFunctionLength: 50, maxNestingDepth: 4, importCount: 7 }, functions: ['getOrder()', 'createOrder()', 'cancelOrder()'], variables: [], types: ['OrderController'] },
        { id: 'file:src/controllers/api/PaymentController.ts', type: 'file', label: 'PaymentController.ts', path: 'src/controllers/api/PaymentController.ts', lines: 260, lang: 'typescript', size: calcSize(260), exportedSymbols: 6, smellScore: 19, smellDetails: { functionCount: 9, avgFunctionLength: 18, maxFunctionLength: 42, maxNestingDepth: 3, importCount: 5 }, functions: ['processPayment()', 'refund()'], variables: [], types: ['PaymentController'] },
        { id: 'file:src/controllers/api/SearchController.ts', type: 'file', label: 'SearchController.ts', path: 'src/controllers/api/SearchController.ts', lines: 220, lang: 'typescript', size: calcSize(220), exportedSymbols: 5, smellScore: 17, smellDetails: { functionCount: 7, avgFunctionLength: 18, maxFunctionLength: 40, maxNestingDepth: 3, importCount: 4 }, functions: ['search()', 'filter()'], variables: [], types: ['SearchController'] },
        
        // Controllers - admin
        { id: 'file:src/controllers/admin/AdminController.ts', type: 'file', label: 'AdminController.ts', path: 'src/controllers/admin/AdminController.ts', lines: 300, lang: 'typescript', size: calcSize(300), exportedSymbols: 8, smellScore: 21, smellDetails: { functionCount: 11, avgFunctionLength: 19, maxFunctionLength: 48, maxNestingDepth: 4, importCount: 7 }, functions: ['getDashboard()', 'getAnalytics()'], variables: [], types: ['AdminController'] },
        { id: 'file:src/controllers/admin/UserManagementController.ts', type: 'file', label: 'UserManagementController.ts', path: 'src/controllers/admin/UserManagementController.ts', lines: 280, lang: 'typescript', size: calcSize(280), exportedSymbols: 7, smellScore: 20, smellDetails: { functionCount: 10, avgFunctionLength: 18, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 6 }, functions: ['listUsers()', 'banUser()', 'unbanUser()'], variables: [], types: ['UserManagementController'] },
        { id: 'file:src/controllers/admin/SettingsController.ts', type: 'file', label: 'SettingsController.ts', path: 'src/controllers/admin/SettingsController.ts', lines: 200, lang: 'typescript', size: calcSize(200), exportedSymbols: 5, smellScore: 16, smellDetails: { functionCount: 7, avgFunctionLength: 17, maxFunctionLength: 38, maxNestingDepth: 3, importCount: 4 }, functions: ['getSettings()', 'updateSettings()'], variables: [], types: ['SettingsController'] },
        
        // Middleware
        { id: 'file:src/middleware/auth.ts', type: 'file', label: 'auth.ts', path: 'src/middleware/auth.ts', lines: 120, lang: 'typescript', size: calcSize(120), exportedSymbols: 3, smellScore: 11, smellDetails: { functionCount: 4, avgFunctionLength: 15, maxFunctionLength: 30, maxNestingDepth: 2, importCount: 3 }, functions: ['authenticate()', 'authorize()'], variables: [], types: [] },
        { id: 'file:src/middleware/cors.ts', type: 'file', label: 'cors.ts', path: 'src/middleware/cors.ts', lines: 80, lang: 'typescript', size: calcSize(80), exportedSymbols: 2, smellScore: 8, smellDetails: { functionCount: 2, avgFunctionLength: 12, maxFunctionLength: 25, maxNestingDepth: 1, importCount: 1 }, functions: ['corsMiddleware()'], variables: [], types: [] },
        { id: 'file:src/middleware/rateLimit.ts', type: 'file', label: 'rateLimit.ts', path: 'src/middleware/rateLimit.ts', lines: 140, lang: 'typescript', size: calcSize(140), exportedSymbols: 3, smellScore: 12, smellDetails: { functionCount: 5, avgFunctionLength: 14, maxFunctionLength: 28, maxNestingDepth: 2, importCount: 2 }, functions: ['rateLimiter()'], variables: [], types: [] },
        { id: 'file:src/middleware/errorHandler.ts', type: 'file', label: 'errorHandler.ts', path: 'src/middleware/errorHandler.ts', lines: 160, lang: 'typescript', size: calcSize(160), exportedSymbols: 4, smellScore: 13, smellDetails: { functionCount: 6, avgFunctionLength: 16, maxFunctionLength: 35, maxNestingDepth: 3, importCount: 3 }, functions: ['errorHandler()', 'notFound()'], variables: [], types: [] },
        { id: 'file:src/middleware/validation.ts', type: 'file', label: 'validation.ts', path: 'src/middleware/validation.ts', lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 5, smellScore: 14, smellDetails: { functionCount: 7, avgFunctionLength: 15, maxFunctionLength: 32, maxNestingDepth: 2, importCount: 4 }, functions: ['validateBody()', 'validateParams()'], variables: [], types: [] },
        { id: 'file:src/middleware/logger.ts', type: 'file', label: 'logger.ts', path: 'src/middleware/logger.ts', lines: 100, lang: 'typescript', size: calcSize(100), exportedSymbols: 2, smellScore: 9, smellDetails: { functionCount: 3, avgFunctionLength: 13, maxFunctionLength: 26, maxNestingDepth: 2, importCount: 2 }, functions: ['loggerMiddleware()'], variables: [], types: [] },
        { id: 'file:src/middleware/compression.ts', type: 'file', label: 'compression.ts', path: 'src/middleware/compression.ts', lines: 90, lang: 'typescript', size: calcSize(90), exportedSymbols: 2, smellScore: 8, smellDetails: { functionCount: 2, avgFunctionLength: 12, maxFunctionLength: 24, maxNestingDepth: 1, importCount: 1 }, functions: ['compressionMiddleware()'], variables: [], types: [] },
        
        // Routes
        { id: 'file:src/routes/userRoutes.ts', type: 'file', label: 'userRoutes.ts', path: 'src/routes/userRoutes.ts', lines: 110, lang: 'typescript', size: calcSize(110), exportedSymbols: 1, smellScore: 10, smellDetails: { functionCount: 1, avgFunctionLength: 30, maxFunctionLength: 30, maxNestingDepth: 1, importCount: 3 }, functions: [], variables: ['userRouter'], types: [] },
        { id: 'file:src/routes/productRoutes.ts', type: 'file', label: 'productRoutes.ts', path: 'src/routes/productRoutes.ts', lines: 130, lang: 'typescript', size: calcSize(130), exportedSymbols: 1, smellScore: 11, smellDetails: { functionCount: 1, avgFunctionLength: 35, maxFunctionLength: 35, maxNestingDepth: 1, importCount: 3 }, functions: [], variables: ['productRouter'], types: [] },
        { id: 'file:src/routes/orderRoutes.ts', type: 'file', label: 'orderRoutes.ts', path: 'src/routes/orderRoutes.ts', lines: 140, lang: 'typescript', size: calcSize(140), exportedSymbols: 1, smellScore: 12, smellDetails: { functionCount: 1, avgFunctionLength: 38, maxFunctionLength: 38, maxNestingDepth: 1, importCount: 3 }, functions: [], variables: ['orderRouter'], types: [] },
        { id: 'file:src/routes/authRoutes.ts', type: 'file', label: 'authRoutes.ts', path: 'src/routes/authRoutes.ts', lines: 90, lang: 'typescript', size: calcSize(90), exportedSymbols: 1, smellScore: 9, smellDetails: { functionCount: 1, avgFunctionLength: 25, maxFunctionLength: 25, maxNestingDepth: 1, importCount: 2 }, functions: [], variables: ['authRouter'], types: [] },
        { id: 'file:src/routes/paymentRoutes.ts', type: 'file', label: 'paymentRoutes.ts', path: 'src/routes/paymentRoutes.ts', lines: 100, lang: 'typescript', size: calcSize(100), exportedSymbols: 1, smellScore: 10, smellDetails: { functionCount: 1, avgFunctionLength: 28, maxFunctionLength: 28, maxNestingDepth: 1, importCount: 2 }, functions: [], variables: ['paymentRouter'], types: [] },
        { id: 'file:src/routes/index.ts', type: 'file', label: 'index.ts', path: 'src/routes/index.ts', lines: 70, lang: 'typescript', size: calcSize(70), exportedSymbols: 1, smellScore: 7, smellDetails: { functionCount: 1, avgFunctionLength: 20, maxFunctionLength: 20, maxNestingDepth: 1, importCount: 6 }, functions: ['setupRoutes()'], variables: [], types: [] },
        
        // Hooks
        { id: 'file:src/hooks/useAuth.ts', type: 'file', label: 'useAuth.ts', path: 'src/hooks/useAuth.ts', lines: 90, lang: 'typescript', size: calcSize(90), exportedSymbols: 1, smellScore: 9, smellDetails: { functionCount: 1, avgFunctionLength: 30, maxFunctionLength: 30, maxNestingDepth: 2, importCount: 3 }, functions: ['useAuth()'], variables: [], types: [] },
        { id: 'file:src/hooks/useForm.ts', type: 'file', label: 'useForm.ts', path: 'src/hooks/useForm.ts', lines: 150, lang: 'typescript', size: calcSize(150), exportedSymbols: 1, smellScore: 13, smellDetails: { functionCount: 1, avgFunctionLength: 45, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 2 }, functions: ['useForm()'], variables: [], types: [] },
        { id: 'file:src/hooks/useFetch.ts', type: 'file', label: 'useFetch.ts', path: 'src/hooks/useFetch.ts', lines: 120, lang: 'typescript', size: calcSize(120), exportedSymbols: 1, smellScore: 11, smellDetails: { functionCount: 1, avgFunctionLength: 38, maxFunctionLength: 38, maxNestingDepth: 3, importCount: 2 }, functions: ['useFetch()'], variables: [], types: [] },
        { id: 'file:src/hooks/useLocalStorage.ts', type: 'file', label: 'useLocalStorage.ts', path: 'src/hooks/useLocalStorage.ts', lines: 80, lang: 'typescript', size: calcSize(80), exportedSymbols: 1, smellScore: 8, smellDetails: { functionCount: 1, avgFunctionLength: 25, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 1 }, functions: ['useLocalStorage()'], variables: [], types: [] },
        { id: 'file:src/hooks/useDebounce.ts', type: 'file', label: 'useDebounce.ts', path: 'src/hooks/useDebounce.ts', lines: 60, lang: 'typescript', size: calcSize(60), exportedSymbols: 1, smellScore: 6, smellDetails: { functionCount: 1, avgFunctionLength: 18, maxFunctionLength: 18, maxNestingDepth: 2, importCount: 1 }, functions: ['useDebounce()'], variables: [], types: [] },
        { id: 'file:src/hooks/useThrottle.ts', type: 'file', label: 'useThrottle.ts', path: 'src/hooks/useThrottle.ts', lines: 65, lang: 'typescript', size: calcSize(65), exportedSymbols: 1, smellScore: 7, smellDetails: { functionCount: 1, avgFunctionLength: 20, maxFunctionLength: 20, maxNestingDepth: 2, importCount: 1 }, functions: ['useThrottle()'], variables: [], types: [] },
        { id: 'file:src/hooks/useModal.ts', type: 'file', label: 'useModal.ts', path: 'src/hooks/useModal.ts', lines: 100, lang: 'typescript', size: calcSize(100), exportedSymbols: 1, smellScore: 10, smellDetails: { functionCount: 1, avgFunctionLength: 32, maxFunctionLength: 32, maxNestingDepth: 2, importCount: 2 }, functions: ['useModal()'], variables: [], types: [] },
        { id: 'file:src/hooks/useToast.ts', type: 'file', label: 'useToast.ts', path: 'src/hooks/useToast.ts', lines: 110, lang: 'typescript', size: calcSize(110), exportedSymbols: 1, smellScore: 11, smellDetails: { functionCount: 1, avgFunctionLength: 35, maxFunctionLength: 35, maxNestingDepth: 2, importCount: 2 }, functions: ['useToast()'], variables: [], types: [] },
        { id: 'file:src/hooks/useWebSocket.ts', type: 'file', label: 'useWebSocket.ts', path: 'src/hooks/useWebSocket.ts', lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 1, smellScore: 15, smellDetails: { functionCount: 1, avgFunctionLength: 55, maxFunctionLength: 55, maxNestingDepth: 4, importCount: 3 }, functions: ['useWebSocket()'], variables: [], types: [] },
        { id: 'file:src/hooks/usePagination.ts', type: 'file', label: 'usePagination.ts', path: 'src/hooks/usePagination.ts', lines: 140, lang: 'typescript', size: calcSize(140), exportedSymbols: 1, smellScore: 12, smellDetails: { functionCount: 1, avgFunctionLength: 42, maxFunctionLength: 42, maxNestingDepth: 3, importCount: 2 }, functions: ['usePagination()'], variables: [], types: [] },
        
        // Contexts
        { id: 'file:src/contexts/AuthContext.tsx', type: 'file', label: 'AuthContext.tsx', path: 'src/contexts/AuthContext.tsx', lines: 200, lang: 'typescript', size: calcSize(200), exportedSymbols: 3, smellScore: 16, smellDetails: { functionCount: 5, avgFunctionLength: 22, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 4 }, functions: ['AuthProvider()'], variables: [], types: ['AuthContextType'] },
        { id: 'file:src/contexts/ThemeContext.tsx', type: 'file', label: 'ThemeContext.tsx', path: 'src/contexts/ThemeContext.tsx', lines: 150, lang: 'typescript', size: calcSize(150), exportedSymbols: 3, smellScore: 13, smellDetails: { functionCount: 4, avgFunctionLength: 20, maxFunctionLength: 38, maxNestingDepth: 2, importCount: 3 }, functions: ['ThemeProvider()'], variables: [], types: ['ThemeContextType'] },
        { id: 'file:src/contexts/CartContext.tsx', type: 'file', label: 'CartContext.tsx', path: 'src/contexts/CartContext.tsx', lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 3, smellScore: 15, smellDetails: { functionCount: 6, avgFunctionLength: 18, maxFunctionLength: 40, maxNestingDepth: 3, importCount: 4 }, functions: ['CartProvider()'], variables: [], types: ['CartContextType'] },
        { id: 'file:src/contexts/NotificationContext.tsx', type: 'file', label: 'NotificationContext.tsx', path: 'src/contexts/NotificationContext.tsx', lines: 160, lang: 'typescript', size: calcSize(160), exportedSymbols: 3, smellScore: 14, smellDetails: { functionCount: 5, avgFunctionLength: 19, maxFunctionLength: 42, maxNestingDepth: 3, importCount: 3 }, functions: ['NotificationProvider()'], variables: [], types: ['NotificationContextType'] },
        { id: 'file:src/contexts/ModalContext.tsx', type: 'file', label: 'ModalContext.tsx', path: 'src/contexts/ModalContext.tsx', lines: 120, lang: 'typescript', size: calcSize(120), exportedSymbols: 3, smellScore: 11, smellDetails: { functionCount: 4, avgFunctionLength: 17, maxFunctionLength: 35, maxNestingDepth: 2, importCount: 3 }, functions: ['ModalProvider()'], variables: [], types: ['ModalContextType'] },
        
        // Types
        { id: 'file:src/types/api.ts', type: 'file', label: 'api.ts', path: 'src/types/api.ts', lines: 80, lang: 'typescript', size: calcSize(80), exportedSymbols: 8, smellScore: 5, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: ['ApiRequest', 'ApiResponse', 'ApiError'] },
        { id: 'file:src/types/user.ts', type: 'file', label: 'user.ts', path: 'src/types/user.ts', lines: 60, lang: 'typescript', size: calcSize(60), exportedSymbols: 5, smellScore: 4, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: ['UserType', 'UserRole'] },
        { id: 'file:src/types/product.ts', type: 'file', label: 'product.ts', path: 'src/types/product.ts', lines: 70, lang: 'typescript', size: calcSize(70), exportedSymbols: 6, smellScore: 4, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: ['ProductType', 'Category'] },
        { id: 'file:src/types/order.ts', type: 'file', label: 'order.ts', path: 'src/types/order.ts', lines: 90, lang: 'typescript', size: calcSize(90), exportedSymbols: 7, smellScore: 5, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 1 }, functions: [], variables: [], types: ['OrderType', 'OrderStatus'] },
        { id: 'file:src/types/payment.ts', type: 'file', label: 'payment.ts', path: 'src/types/payment.ts', lines: 75, lang: 'typescript', size: calcSize(75), exportedSymbols: 6, smellScore: 4, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: ['PaymentType', 'PaymentMethod'] },
        { id: 'file:src/types/cart.ts', type: 'file', label: 'cart.ts', path: 'src/types/cart.ts', lines: 65, lang: 'typescript', size: calcSize(65), exportedSymbols: 5, smellScore: 4, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 1 }, functions: [], variables: [], types: ['CartType', 'CartItem'] },
        { id: 'file:src/types/notification.ts', type: 'file', label: 'notification.ts', path: 'src/types/notification.ts', lines: 55, lang: 'typescript', size: calcSize(55), exportedSymbols: 4, smellScore: 3, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: ['NotificationType'] },
        { id: 'file:src/types/common.ts', type: 'file', label: 'common.ts', path: 'src/types/common.ts', lines: 100, lang: 'typescript', size: calcSize(100), exportedSymbols: 10, smellScore: 6, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: ['ID', 'Timestamp', 'Nullable'] },
        { id: 'file:src/types/index.ts', type: 'file', label: 'index.ts', path: 'src/types/index.ts', lines: 40, lang: 'typescript', size: calcSize(40), exportedSymbols: 0, smellScore: 2, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 8 }, functions: [], variables: [], types: [] },
        
        // E2E tests
        { id: 'file:test/e2e/login.e2e.ts', type: 'file', label: 'login.e2e.ts', path: 'test/e2e/login.e2e.ts', lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 0, smellScore: 5, smellDetails: { functionCount: 5, avgFunctionLength: 22, maxFunctionLength: 50, maxNestingDepth: 3, importCount: 4 }, functions: [], variables: [], types: [] },
        { id: 'file:test/e2e/checkout.e2e.ts', type: 'file', label: 'checkout.e2e.ts', path: 'test/e2e/checkout.e2e.ts', lines: 240, lang: 'typescript', size: calcSize(240), exportedSymbols: 0, smellScore: 6, smellDetails: { functionCount: 6, avgFunctionLength: 28, maxFunctionLength: 60, maxNestingDepth: 4, importCount: 5 }, functions: [], variables: [], types: [] },
        { id: 'file:test/e2e/product-search.e2e.ts', type: 'file', label: 'product-search.e2e.ts', path: 'test/e2e/product-search.e2e.ts', lines: 160, lang: 'typescript', size: calcSize(160), exportedSymbols: 0, smellScore: 5, smellDetails: { functionCount: 4, avgFunctionLength: 25, maxFunctionLength: 48, maxNestingDepth: 3, importCount: 3 }, functions: [], variables: [], types: [] },
        { id: 'file:test/e2e/user-registration.e2e.ts', type: 'file', label: 'user-registration.e2e.ts', path: 'test/e2e/user-registration.e2e.ts', lines: 200, lang: 'typescript', size: calcSize(200), exportedSymbols: 0, smellScore: 5, smellDetails: { functionCount: 5, avgFunctionLength: 24, maxFunctionLength: 52, maxNestingDepth: 3, importCount: 4 }, functions: [], variables: [], types: [] },
        { id: 'file:test/e2e/cart-management.e2e.ts', type: 'file', label: 'cart-management.e2e.ts', path: 'test/e2e/cart-management.e2e.ts', lines: 220, lang: 'typescript', size: calcSize(220), exportedSymbols: 0, smellScore: 6, smellDetails: { functionCount: 6, avgFunctionLength: 26, maxFunctionLength: 55, maxNestingDepth: 4, importCount: 5 }, functions: [], variables: [], types: [] },
        { id: 'file:test/e2e/payment-flow.e2e.ts', type: 'file', label: 'payment-flow.e2e.ts', path: 'test/e2e/payment-flow.e2e.ts', lines: 260, lang: 'typescript', size: calcSize(260), exportedSymbols: 0, smellScore: 7, smellDetails: { functionCount: 7, avgFunctionLength: 27, maxFunctionLength: 58, maxNestingDepth: 4, importCount: 6 }, functions: [], variables: [], types: [] },
        { id: 'file:test/e2e/admin-panel.e2e.ts', type: 'file', label: 'admin-panel.e2e.ts', path: 'test/e2e/admin-panel.e2e.ts', lines: 280, lang: 'typescript', size: calcSize(280), exportedSymbols: 0, smellScore: 7, smellDetails: { functionCount: 8, avgFunctionLength: 26, maxFunctionLength: 60, maxNestingDepth: 4, importCount: 6 }, functions: [], variables: [], types: [] },
        { id: 'file:test/e2e/notification.e2e.ts', type: 'file', label: 'notification.e2e.ts', path: 'test/e2e/notification.e2e.ts', lines: 140, lang: 'typescript', size: calcSize(140), exportedSymbols: 0, smellScore: 4, smellDetails: { functionCount: 4, avgFunctionLength: 22, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 3 }, functions: [], variables: [], types: [] },
        
        // Test fixtures
        { id: 'file:test/fixtures/users.json', type: 'file', label: 'users.json', path: 'test/fixtures/users.json', lines: 120, lang: 'json', size: calcSize(120), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:test/fixtures/products.json', type: 'file', label: 'products.json', path: 'test/fixtures/products.json', lines: 200, lang: 'json', size: calcSize(200), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:test/fixtures/orders.json', type: 'file', label: 'orders.json', path: 'test/fixtures/orders.json', lines: 180, lang: 'json', size: calcSize(180), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:test/fixtures/mockApi.ts', type: 'file', label: 'mockApi.ts', path: 'test/fixtures/mockApi.ts', lines: 240, lang: 'typescript', size: calcSize(240), exportedSymbols: 15, smellScore: 8, smellDetails: { functionCount: 20, avgFunctionLength: 10, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 3 }, functions: ['mockGetUser()', 'mockCreateOrder()'], variables: [], types: [] },
        { id: 'file:test/fixtures/testHelpers.ts', type: 'file', label: 'testHelpers.ts', path: 'test/fixtures/testHelpers.ts', lines: 160, lang: 'typescript', size: calcSize(160), exportedSymbols: 12, smellScore: 6, smellDetails: { functionCount: 15, avgFunctionLength: 9, maxFunctionLength: 22, maxNestingDepth: 2, importCount: 2 }, functions: ['createTestUser()', 'setupTestDb()'], variables: [], types: [] },
        { id: 'file:test/fixtures/factories.ts', type: 'file', label: 'factories.ts', path: 'test/fixtures/factories.ts', lines: 220, lang: 'typescript', size: calcSize(220), exportedSymbols: 10, smellScore: 7, smellDetails: { functionCount: 12, avgFunctionLength: 12, maxFunctionLength: 28, maxNestingDepth: 2, importCount: 4 }, functions: ['userFactory()', 'productFactory()'], variables: [], types: [] },
        { id: 'file:test/fixtures/seedData.ts', type: 'file', label: 'seedData.ts', path: 'test/fixtures/seedData.ts', lines: 180, lang: 'typescript', size: calcSize(180), exportedSymbols: 8, smellScore: 6, smellDetails: { functionCount: 10, avgFunctionLength: 11, maxFunctionLength: 25, maxNestingDepth: 2, importCount: 3 }, functions: ['seedUsers()', 'seedProducts()'], variables: [], types: [] },
        { id: 'file:test/fixtures/mockData.ts', type: 'file', label: 'mockData.ts', path: 'test/fixtures/mockData.ts', lines: 300, lang: 'typescript', size: calcSize(300), exportedSymbols: 20, smellScore: 10, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: ['mockUsers', 'mockProducts', 'mockOrders'], types: [] },
        { id: 'file:test/fixtures/testConfig.ts', type: 'file', label: 'testConfig.ts', path: 'test/fixtures/testConfig.ts', lines: 80, lang: 'typescript', size: calcSize(80), exportedSymbols: 5, smellScore: 4, smellDetails: { functionCount: 2, avgFunctionLength: 8, maxFunctionLength: 15, maxNestingDepth: 1, importCount: 1 }, functions: ['getTestConfig()'], variables: ['testConfig'], types: [] },
        { id: 'file:test/fixtures/matchers.ts', type: 'file', label: 'matchers.ts', path: 'test/fixtures/matchers.ts', lines: 140, lang: 'typescript', size: calcSize(140), exportedSymbols: 8, smellScore: 5, smellDetails: { functionCount: 10, avgFunctionLength: 10, maxFunctionLength: 20, maxNestingDepth: 2, importCount: 2 }, functions: ['toBeValidUser()', 'toHaveStatus()'], variables: [], types: [] },
        
        // Docs
        { id: 'file:docs/API.md', type: 'file', label: 'API.md', path: 'docs/API.md', lines: 450, lang: 'markdown', size: calcSize(450), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:docs/ARCHITECTURE.md', type: 'file', label: 'ARCHITECTURE.md', path: 'docs/ARCHITECTURE.md', lines: 380, lang: 'markdown', size: calcSize(380), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:docs/DEPLOYMENT.md', type: 'file', label: 'DEPLOYMENT.md', path: 'docs/DEPLOYMENT.md', lines: 280, lang: 'markdown', size: calcSize(280), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:docs/CONTRIBUTING.md', type: 'file', label: 'CONTRIBUTING.md', path: 'docs/CONTRIBUTING.md', lines: 220, lang: 'markdown', size: calcSize(220), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:docs/TESTING.md', type: 'file', label: 'TESTING.md', path: 'docs/TESTING.md', lines: 320, lang: 'markdown', size: calcSize(320), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:docs/SECURITY.md', type: 'file', label: 'SECURITY.md', path: 'docs/SECURITY.md', lines: 180, lang: 'markdown', size: calcSize(180), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:docs/CHANGELOG.md', type: 'file', label: 'CHANGELOG.md', path: 'docs/CHANGELOG.md', lines: 520, lang: 'markdown', size: calcSize(520), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        
        // Scripts
        { id: 'file:scripts/build.sh', type: 'file', label: 'build.sh', path: 'scripts/build.sh', lines: 120, lang: 'shell', size: calcSize(120), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:scripts/deploy.sh', type: 'file', label: 'deploy.sh', path: 'scripts/deploy.sh', lines: 180, lang: 'shell', size: calcSize(180), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:scripts/test.sh', type: 'file', label: 'test.sh', path: 'scripts/test.sh', lines: 90, lang: 'shell', size: calcSize(90), exportedSymbols: 0, smellScore: 0, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 0 }, functions: [], variables: [], types: [] },
        { id: 'file:scripts/seed.ts', type: 'file', label: 'seed.ts', path: 'scripts/seed.ts', lines: 240, lang: 'typescript', size: calcSize(240), exportedSymbols: 5, smellScore: 8, smellDetails: { functionCount: 8, avgFunctionLength: 18, maxFunctionLength: 40, maxNestingDepth: 3, importCount: 6 }, functions: ['seedDatabase()', 'clearDatabase()'], variables: [], types: [] },
        { id: 'file:scripts/migrate.ts', type: 'file', label: 'migrate.ts', path: 'scripts/migrate.ts', lines: 200, lang: 'typescript', size: calcSize(200), exportedSymbols: 4, smellScore: 7, smellDetails: { functionCount: 6, avgFunctionLength: 20, maxFunctionLength: 45, maxNestingDepth: 3, importCount: 5 }, functions: ['runMigrations()', 'rollback()'], variables: [], types: [] },
        { id: 'file:scripts/backup.ts', type: 'file', label: 'backup.ts', path: 'scripts/backup.ts', lines: 160, lang: 'typescript', size: calcSize(160), exportedSymbols: 3, smellScore: 6, smellDetails: { functionCount: 5, avgFunctionLength: 18, maxFunctionLength: 38, maxNestingDepth: 2, importCount: 4 }, functions: ['createBackup()', 'restoreBackup()'], variables: [], types: [] },
        { id: 'file:scripts/cleanup.ts', type: 'file', label: 'cleanup.ts', path: 'scripts/cleanup.ts', lines: 100, lang: 'typescript', size: calcSize(100), exportedSymbols: 2, smellScore: 5, smellDetails: { functionCount: 4, avgFunctionLength: 15, maxFunctionLength: 30, maxNestingDepth: 2, importCount: 3 }, functions: ['cleanupOldData()'], variables: [], types: [] },
        { id: 'file:scripts/generate.ts', type: 'file', label: 'generate.ts', path: 'scripts/generate.ts', lines: 220, lang: 'typescript', size: calcSize(220), exportedSymbols: 6, smellScore: 7, smellDetails: { functionCount: 8, avgFunctionLength: 16, maxFunctionLength: 35, maxNestingDepth: 3, importCount: 4 }, functions: ['generateTypes()', 'generateDocs()'], variables: [], types: [] },
        
        // Config
        { id: 'file:config/database.ts', type: 'file', label: 'database.ts', path: 'config/database.ts', lines: 80, lang: 'typescript', size: calcSize(80), exportedSymbols: 2, smellScore: 4, smellDetails: { functionCount: 1, avgFunctionLength: 15, maxFunctionLength: 15, maxNestingDepth: 1, importCount: 1 }, functions: [], variables: ['dbConfig'], types: ['DatabaseConfig'] },
        { id: 'file:config/redis.ts', type: 'file', label: 'redis.ts', path: 'config/redis.ts', lines: 60, lang: 'typescript', size: calcSize(60), exportedSymbols: 2, smellScore: 3, smellDetails: { functionCount: 1, avgFunctionLength: 12, maxFunctionLength: 12, maxNestingDepth: 1, importCount: 1 }, functions: [], variables: ['redisConfig'], types: ['RedisConfig'] },
        { id: 'file:config/auth.ts', type: 'file', label: 'auth.ts', path: 'config/auth.ts', lines: 70, lang: 'typescript', size: calcSize(70), exportedSymbols: 2, smellScore: 3, smellDetails: { functionCount: 1, avgFunctionLength: 13, maxFunctionLength: 13, maxNestingDepth: 1, importCount: 1 }, functions: [], variables: ['authConfig'], types: ['AuthConfig'] },
        { id: 'file:config/app.ts', type: 'file', label: 'app.ts', path: 'config/app.ts', lines: 90, lang: 'typescript', size: calcSize(90), exportedSymbols: 3, smellScore: 4, smellDetails: { functionCount: 1, avgFunctionLength: 18, maxFunctionLength: 18, maxNestingDepth: 1, importCount: 2 }, functions: [], variables: ['appConfig'], types: ['AppConfig'] },
        { id: 'file:config/email.ts', type: 'file', label: 'email.ts', path: 'config/email.ts', lines: 65, lang: 'typescript', size: calcSize(65), exportedSymbols: 2, smellScore: 3, smellDetails: { functionCount: 1, avgFunctionLength: 12, maxFunctionLength: 12, maxNestingDepth: 1, importCount: 1 }, functions: [], variables: ['emailConfig'], types: ['EmailConfig'] },
        { id: 'file:config/index.ts', type: 'file', label: 'index.ts', path: 'config/index.ts', lines: 50, lang: 'typescript', size: calcSize(50), exportedSymbols: 1, smellScore: 2, smellDetails: { functionCount: 0, avgFunctionLength: 0, maxFunctionLength: 0, maxNestingDepth: 0, importCount: 6 }, functions: [], variables: [], types: [] }
      ],
      edges: [
        // Directory containment - Root
        { source: 'dir:src', target: 'dir:src/services', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/AI', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/utils', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/components', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/models', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/controllers', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/middleware', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/routes', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/hooks', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/contexts', type: 'contains' },
        { source: 'dir:src', target: 'dir:src/types', type: 'contains' },
        { source: 'dir:src', target: 'file:src/index.ts', type: 'contains' },
        { source: 'dir:src', target: 'file:src/app.ts', type: 'contains' },
        { source: 'dir:test', target: 'dir:test/unit', type: 'contains' },
        { source: 'dir:test', target: 'dir:test/integration', type: 'contains' },
        { source: 'dir:test', target: 'dir:test/e2e', type: 'contains' },
        { source: 'dir:test', target: 'dir:test/fixtures', type: 'contains' },
        
        // Services
        { source: 'dir:src/services', target: 'file:src/services/auth.ts', type: 'contains' },
        { source: 'dir:src/services', target: 'file:src/services/api.ts', type: 'contains' },
        { source: 'dir:src/services', target: 'file:src/services/database.ts', type: 'contains' },
        { source: 'dir:src/services', target: 'file:src/services/cache.ts', type: 'contains' },
        
        // AI
        { source: 'dir:src/AI', target: 'file:src/AI/model.ts', type: 'contains' },
        { source: 'dir:src/AI', target: 'file:src/AI/agent.ts', type: 'contains' },
        
        // Utils
        { source: 'dir:src/utils', target: 'file:src/utils/helpers.ts', type: 'contains' },
        { source: 'dir:src/utils', target: 'file:src/utils/logger.ts', type: 'contains' },
        { source: 'dir:src/utils', target: 'file:src/utils/validator.ts', type: 'contains' },
        { source: 'dir:src/utils', target: 'file:src/utils/crypto.ts', type: 'contains' },
        
        // Components - nested structure
        { source: 'dir:src/components', target: 'dir:src/components/common', type: 'contains' },
        { source: 'dir:src/components', target: 'dir:src/components/forms', type: 'contains' },
        { source: 'dir:src/components', target: 'dir:src/components/layout', type: 'contains' },
        { source: 'dir:src/components/common', target: 'file:src/components/common/Button.tsx', type: 'contains' },
        { source: 'dir:src/components/common', target: 'file:src/components/common/Modal.tsx', type: 'contains' },
        { source: 'dir:src/components/common', target: 'file:src/components/common/Table.tsx', type: 'contains' },
        { source: 'dir:src/components/forms', target: 'file:src/components/forms/Input.tsx', type: 'contains' },
        { source: 'dir:src/components/forms', target: 'file:src/components/forms/Form.tsx', type: 'contains' },
        { source: 'dir:src/components/layout', target: 'dir:src/components/layout/header', type: 'contains' },
        { source: 'dir:src/components/layout', target: 'dir:src/components/layout/footer', type: 'contains' },
        { source: 'dir:src/components/layout', target: 'dir:src/components/layout/sidebar', type: 'contains' },
        { source: 'dir:src/components/layout/header', target: 'file:src/components/layout/header/Header.tsx', type: 'contains' },
        { source: 'dir:src/components/layout/header', target: 'file:src/components/layout/header/Navigation.tsx', type: 'contains' },
        { source: 'dir:src/components/layout/footer', target: 'file:src/components/layout/footer/Footer.tsx', type: 'contains' },
        { source: 'dir:src/components/layout/footer', target: 'file:src/components/layout/footer/Copyright.tsx', type: 'contains' },
        { source: 'dir:src/components/layout/sidebar', target: 'file:src/components/layout/sidebar/Sidebar.tsx', type: 'contains' },
        { source: 'dir:src/components/layout/sidebar', target: 'file:src/components/layout/sidebar/Menu.tsx', type: 'contains' },
        { source: 'dir:src/components/layout/sidebar', target: 'file:src/components/layout/sidebar/MenuItem.tsx', type: 'contains' },
        
        // Models
        { source: 'dir:src/models', target: 'file:src/models/User.ts', type: 'contains' },
        { source: 'dir:src/models', target: 'file:src/models/Product.ts', type: 'contains' },
        { source: 'dir:src/models', target: 'file:src/models/Order.ts', type: 'contains' },
        
        // Unit tests - nested structure
        { source: 'dir:test/unit', target: 'dir:test/unit/services', type: 'contains' },
        { source: 'dir:test/unit', target: 'dir:test/unit/utils', type: 'contains' },
        { source: 'dir:test/unit', target: 'dir:test/unit/components', type: 'contains' },
        { source: 'dir:test/unit/services', target: 'dir:test/unit/services/auth', type: 'contains' },
        { source: 'dir:test/unit/services', target: 'dir:test/unit/services/api', type: 'contains' },
        { source: 'dir:test/unit/services/auth', target: 'file:test/unit/services/auth/login.test.ts', type: 'contains' },
        { source: 'dir:test/unit/services/auth', target: 'file:test/unit/services/auth/logout.test.ts', type: 'contains' },
        { source: 'dir:test/unit/services/auth', target: 'file:test/unit/services/auth/token.test.ts', type: 'contains' },
        { source: 'dir:test/unit/services/api', target: 'file:test/unit/services/api/fetch.test.ts', type: 'contains' },
        { source: 'dir:test/unit/services/api', target: 'file:test/unit/services/api/error-handling.test.ts', type: 'contains' },
        { source: 'dir:test/unit/utils', target: 'file:test/unit/utils/helpers.test.ts', type: 'contains' },
        { source: 'dir:test/unit/utils', target: 'file:test/unit/utils/validator.test.ts', type: 'contains' },
        { source: 'dir:test/unit/utils', target: 'file:test/unit/utils/crypto.test.ts', type: 'contains' },
        { source: 'dir:test/unit/components', target: 'file:test/unit/components/Button.test.tsx', type: 'contains' },
        { source: 'dir:test/unit/components', target: 'file:test/unit/components/Form.test.tsx', type: 'contains' },
        { source: 'dir:test/unit/components', target: 'file:test/unit/components/Table.test.tsx', type: 'contains' },
        { source: 'dir:test/unit/components', target: 'file:test/unit/components/Modal.test.tsx', type: 'contains' },
        
        // Integration tests
        { source: 'dir:test/integration', target: 'file:test/integration/auth-flow.test.ts', type: 'contains' },
        { source: 'dir:test/integration', target: 'file:test/integration/api-flow.test.ts', type: 'contains' },
        { source: 'dir:test/integration', target: 'file:test/integration/database.test.ts', type: 'contains' },
        
        // Controllers - nested structure
        { source: 'dir:src/controllers', target: 'dir:src/controllers/api', type: 'contains' },
        { source: 'dir:src/controllers', target: 'dir:src/controllers/admin', type: 'contains' },
        { source: 'dir:src/controllers/api', target: 'file:src/controllers/api/UserController.ts', type: 'contains' },
        { source: 'dir:src/controllers/api', target: 'file:src/controllers/api/ProductController.ts', type: 'contains' },
        { source: 'dir:src/controllers/api', target: 'file:src/controllers/api/OrderController.ts', type: 'contains' },
        { source: 'dir:src/controllers/api', target: 'file:src/controllers/api/PaymentController.ts', type: 'contains' },
        { source: 'dir:src/controllers/api', target: 'file:src/controllers/api/SearchController.ts', type: 'contains' },
        { source: 'dir:src/controllers/admin', target: 'file:src/controllers/admin/AdminController.ts', type: 'contains' },
        { source: 'dir:src/controllers/admin', target: 'file:src/controllers/admin/UserManagementController.ts', type: 'contains' },
        { source: 'dir:src/controllers/admin', target: 'file:src/controllers/admin/SettingsController.ts', type: 'contains' },
        
        // Middleware
        { source: 'dir:src/middleware', target: 'file:src/middleware/auth.ts', type: 'contains' },
        { source: 'dir:src/middleware', target: 'file:src/middleware/cors.ts', type: 'contains' },
        { source: 'dir:src/middleware', target: 'file:src/middleware/rateLimit.ts', type: 'contains' },
        { source: 'dir:src/middleware', target: 'file:src/middleware/errorHandler.ts', type: 'contains' },
        { source: 'dir:src/middleware', target: 'file:src/middleware/validation.ts', type: 'contains' },
        { source: 'dir:src/middleware', target: 'file:src/middleware/logger.ts', type: 'contains' },
        { source: 'dir:src/middleware', target: 'file:src/middleware/compression.ts', type: 'contains' },
        
        // Routes
        { source: 'dir:src/routes', target: 'file:src/routes/userRoutes.ts', type: 'contains' },
        { source: 'dir:src/routes', target: 'file:src/routes/productRoutes.ts', type: 'contains' },
        { source: 'dir:src/routes', target: 'file:src/routes/orderRoutes.ts', type: 'contains' },
        { source: 'dir:src/routes', target: 'file:src/routes/authRoutes.ts', type: 'contains' },
        { source: 'dir:src/routes', target: 'file:src/routes/paymentRoutes.ts', type: 'contains' },
        { source: 'dir:src/routes', target: 'file:src/routes/index.ts', type: 'contains' },
        
        // Hooks
        { source: 'dir:src/hooks', target: 'file:src/hooks/useAuth.ts', type: 'contains' },
        { source: 'dir:src/hooks', target: 'file:src/hooks/useForm.ts', type: 'contains' },
        { source: 'dir:src/hooks', target: 'file:src/hooks/useFetch.ts', type: 'contains' },
        { source: 'dir:src/hooks', target: 'file:src/hooks/useLocalStorage.ts', type: 'contains' },
        { source: 'dir:src/hooks', target: 'file:src/hooks/useDebounce.ts', type: 'contains' },
        { source: 'dir:src/hooks', target: 'file:src/hooks/useThrottle.ts', type: 'contains' },
        { source: 'dir:src/hooks', target: 'file:src/hooks/useModal.ts', type: 'contains' },
        { source: 'dir:src/hooks', target: 'file:src/hooks/useToast.ts', type: 'contains' },
        { source: 'dir:src/hooks', target: 'file:src/hooks/useWebSocket.ts', type: 'contains' },
        { source: 'dir:src/hooks', target: 'file:src/hooks/usePagination.ts', type: 'contains' },
        
        // Contexts
        { source: 'dir:src/contexts', target: 'file:src/contexts/AuthContext.tsx', type: 'contains' },
        { source: 'dir:src/contexts', target: 'file:src/contexts/ThemeContext.tsx', type: 'contains' },
        { source: 'dir:src/contexts', target: 'file:src/contexts/CartContext.tsx', type: 'contains' },
        { source: 'dir:src/contexts', target: 'file:src/contexts/NotificationContext.tsx', type: 'contains' },
        { source: 'dir:src/contexts', target: 'file:src/contexts/ModalContext.tsx', type: 'contains' },
        
        // Types
        { source: 'dir:src/types', target: 'file:src/types/api.ts', type: 'contains' },
        { source: 'dir:src/types', target: 'file:src/types/user.ts', type: 'contains' },
        { source: 'dir:src/types', target: 'file:src/types/product.ts', type: 'contains' },
        { source: 'dir:src/types', target: 'file:src/types/order.ts', type: 'contains' },
        { source: 'dir:src/types', target: 'file:src/types/payment.ts', type: 'contains' },
        { source: 'dir:src/types', target: 'file:src/types/cart.ts', type: 'contains' },
        { source: 'dir:src/types', target: 'file:src/types/notification.ts', type: 'contains' },
        { source: 'dir:src/types', target: 'file:src/types/common.ts', type: 'contains' },
        { source: 'dir:src/types', target: 'file:src/types/index.ts', type: 'contains' },
        
        // E2E tests
        { source: 'dir:test/e2e', target: 'file:test/e2e/login.e2e.ts', type: 'contains' },
        { source: 'dir:test/e2e', target: 'file:test/e2e/checkout.e2e.ts', type: 'contains' },
        { source: 'dir:test/e2e', target: 'file:test/e2e/product-search.e2e.ts', type: 'contains' },
        { source: 'dir:test/e2e', target: 'file:test/e2e/user-registration.e2e.ts', type: 'contains' },
        { source: 'dir:test/e2e', target: 'file:test/e2e/cart-management.e2e.ts', type: 'contains' },
        { source: 'dir:test/e2e', target: 'file:test/e2e/payment-flow.e2e.ts', type: 'contains' },
        { source: 'dir:test/e2e', target: 'file:test/e2e/admin-panel.e2e.ts', type: 'contains' },
        { source: 'dir:test/e2e', target: 'file:test/e2e/notification.e2e.ts', type: 'contains' },
        
        // Test fixtures
        { source: 'dir:test/fixtures', target: 'file:test/fixtures/users.json', type: 'contains' },
        { source: 'dir:test/fixtures', target: 'file:test/fixtures/products.json', type: 'contains' },
        { source: 'dir:test/fixtures', target: 'file:test/fixtures/orders.json', type: 'contains' },
        { source: 'dir:test/fixtures', target: 'file:test/fixtures/mockApi.ts', type: 'contains' },
        { source: 'dir:test/fixtures', target: 'file:test/fixtures/testHelpers.ts', type: 'contains' },
        { source: 'dir:test/fixtures', target: 'file:test/fixtures/factories.ts', type: 'contains' },
        { source: 'dir:test/fixtures', target: 'file:test/fixtures/seedData.ts', type: 'contains' },
        { source: 'dir:test/fixtures', target: 'file:test/fixtures/mockData.ts', type: 'contains' },
        { source: 'dir:test/fixtures', target: 'file:test/fixtures/testConfig.ts', type: 'contains' },
        { source: 'dir:test/fixtures', target: 'file:test/fixtures/matchers.ts', type: 'contains' },
        
        // Docs
        { source: 'dir:docs', target: 'file:docs/API.md', type: 'contains' },
        { source: 'dir:docs', target: 'file:docs/ARCHITECTURE.md', type: 'contains' },
        { source: 'dir:docs', target: 'file:docs/DEPLOYMENT.md', type: 'contains' },
        { source: 'dir:docs', target: 'file:docs/CONTRIBUTING.md', type: 'contains' },
        { source: 'dir:docs', target: 'file:docs/TESTING.md', type: 'contains' },
        { source: 'dir:docs', target: 'file:docs/SECURITY.md', type: 'contains' },
        { source: 'dir:docs', target: 'file:docs/CHANGELOG.md', type: 'contains' },
        
        // Scripts
        { source: 'dir:scripts', target: 'file:scripts/build.sh', type: 'contains' },
        { source: 'dir:scripts', target: 'file:scripts/deploy.sh', type: 'contains' },
        { source: 'dir:scripts', target: 'file:scripts/test.sh', type: 'contains' },
        { source: 'dir:scripts', target: 'file:scripts/seed.ts', type: 'contains' },
        { source: 'dir:scripts', target: 'file:scripts/migrate.ts', type: 'contains' },
        { source: 'dir:scripts', target: 'file:scripts/backup.ts', type: 'contains' },
        { source: 'dir:scripts', target: 'file:scripts/cleanup.ts', type: 'contains' },
        { source: 'dir:scripts', target: 'file:scripts/generate.ts', type: 'contains' },
        
        // Config
        { source: 'dir:config', target: 'file:config/database.ts', type: 'contains' },
        { source: 'dir:config', target: 'file:config/redis.ts', type: 'contains' },
        { source: 'dir:config', target: 'file:config/auth.ts', type: 'contains' },
        { source: 'dir:config', target: 'file:config/app.ts', type: 'contains' },
        { source: 'dir:config', target: 'file:config/email.ts', type: 'contains' },
        { source: 'dir:config', target: 'file:config/index.ts', type: 'contains' },
        
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

function getDependencyGraphMockDataScript(): string {
  return `
    const mockGraphData = {
      nodes: [
        { id: 'file:src/index.ts', type: 'file', label: 'index.ts', path: 'src/index.ts', lang: 'typescript', size: 150, inDegree: 0, outDegree: 4 },
        { id: 'file:src/app.ts', type: 'file', label: 'app.ts', path: 'src/app.ts', lang: 'typescript', size: 280, inDegree: 1, outDegree: 3 },
        { id: 'file:src/services/auth.ts', type: 'file', label: 'auth.ts', path: 'src/services/auth.ts', lang: 'typescript', size: 450, inDegree: 2, outDegree: 6 },
        { id: 'file:src/services/api.ts', type: 'file', label: 'api.ts', path: 'src/services/api.ts', lang: 'typescript', size: 320, inDegree: 3, outDegree: 2 },
        { id: 'file:src/services/database.ts', type: 'file', label: 'database.ts', path: 'src/services/database.ts', lang: 'typescript', size: 520, inDegree: 2, outDegree: 4 },
        { id: 'file:src/services/cache.ts', type: 'file', label: 'cache.ts', path: 'src/services/cache.ts', lang: 'typescript', size: 180, inDegree: 2, outDegree: 1 },
        { id: 'file:src/utils/helpers.ts', type: 'file', label: 'helpers.ts', path: 'src/utils/helpers.ts', lang: 'typescript', size: 100, inDegree: 5, outDegree: 0 },
        { id: 'file:src/utils/logger.ts', type: 'file', label: 'logger.ts', path: 'src/utils/logger.ts', lang: 'typescript', size: 80, inDegree: 7, outDegree: 0 },
        { id: 'file:src/utils/validator.ts', type: 'file', label: 'validator.ts', path: 'src/utils/validator.ts', lang: 'typescript', size: 220, inDegree: 3, outDegree: 1 },
        { id: 'file:src/utils/crypto.ts', type: 'file', label: 'crypto.ts', path: 'src/utils/crypto.ts', lang: 'typescript', size: 140, inDegree: 1, outDegree: 0 },
        { id: 'file:src/models/User.ts', type: 'file', label: 'User.ts', path: 'src/models/User.ts', lang: 'typescript', size: 120, inDegree: 2, outDegree: 0 },
        { id: 'file:src/models/Product.ts', type: 'file', label: 'Product.ts', path: 'src/models/Product.ts', lang: 'typescript', size: 90, inDegree: 1, outDegree: 0 },
        { id: 'file:src/models/Order.ts', type: 'file', label: 'Order.ts', path: 'src/models/Order.ts', lang: 'typescript', size: 150, inDegree: 1, outDegree: 0 },
        { id: 'file:src/components/Button.tsx', type: 'file', label: 'Button.tsx', path: 'src/components/Button.tsx', lang: 'typescript', size: 95, inDegree: 3, outDegree: 0 },
        { id: 'file:src/components/Form.tsx', type: 'file', label: 'Form.tsx', path: 'src/components/Form.tsx', lang: 'typescript', size: 260, inDegree: 1, outDegree: 3 },
        { id: 'file:src/components/Input.tsx', type: 'file', label: 'Input.tsx', path: 'src/components/Input.tsx', lang: 'typescript', size: 110, inDegree: 1, outDegree: 0 }
      ],
      edges: [
        { source: 'file:src/index.ts', target: 'file:src/app.ts', type: 'imports', weight: 5 },
        { source: 'file:src/index.ts', target: 'file:src/services/auth.ts', type: 'imports', weight: 3 },
        { source: 'file:src/index.ts', target: 'file:src/services/api.ts', type: 'imports', weight: 2 },
        { source: 'file:src/index.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 1 },
        { source: 'file:src/app.ts', target: 'file:src/services/database.ts', type: 'imports', weight: 4 },
        { source: 'file:src/app.ts', target: 'file:src/services/cache.ts', type: 'imports', weight: 2 },
        { source: 'file:src/app.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 3 },
        { source: 'file:src/services/auth.ts', target: 'file:src/services/database.ts', type: 'imports', weight: 5 },
        { source: 'file:src/services/auth.ts', target: 'file:src/services/cache.ts', type: 'imports', weight: 3 },
        { source: 'file:src/services/auth.ts', target: 'file:src/utils/crypto.ts', type: 'imports', weight: 4 },
        { source: 'file:src/services/auth.ts', target: 'file:src/utils/validator.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/auth.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/auth.ts', target: 'file:src/models/User.ts', type: 'imports', weight: 6 },
        { source: 'file:src/services/api.ts', target: 'file:src/utils/helpers.ts', type: 'imports', weight: 3 },
        { source: 'file:src/services/api.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/database.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 4 },
        { source: 'file:src/services/database.ts', target: 'file:src/models/User.ts', type: 'imports', weight: 3 },
        { source: 'file:src/services/database.ts', target: 'file:src/models/Product.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/database.ts', target: 'file:src/models/Order.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/cache.ts', target: 'file:src/utils/logger.ts', type: 'imports', weight: 1 },
        { source: 'file:src/utils/validator.ts', target: 'file:src/utils/helpers.ts', type: 'imports', weight: 2 },
        { source: 'file:src/components/Form.tsx', target: 'file:src/components/Input.tsx', type: 'imports', weight: 4 },
        { source: 'file:src/components/Form.tsx', target: 'file:src/components/Button.tsx', type: 'imports', weight: 3 },
        { source: 'file:src/components/Form.tsx', target: 'file:src/utils/validator.ts', type: 'imports', weight: 2 },
        { source: 'file:src/services/api.ts', target: 'file:src/services/auth.ts', type: 'calls', weight: 2 }
      ]
    };
    
    window.__handleWebviewMessage = function(message) {
      switch (message.type) {
        case 'ready':
          console.log('[Mock] Sending dependency graph data...');
          if (window.__devLog) window.__devLog('✅ Ready, sending data...');
          setTimeout(() => {
            console.log('[Mock] Sending graph:update with', mockGraphData.nodes.length, 'nodes');
            if (window.__devLog) window.__devLog('📊 Sent ' + mockGraphData.nodes.length + ' nodes');
            window.__postMessageToWebview({ type: 'graph:update', data: mockGraphData });
          }, 100);
          break;
        case 'file:open':
          alert('Would open file: ' + message.filePath);
          break;
        case 'file:copy':
          navigator.clipboard.writeText(message.filePath).then(() => alert('Copied: ' + message.filePath));
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
      
      <a href="/panel/dependency-graph" class="panel-card">
        <div class="panel-icon">🔗</div>
        <div class="panel-name">Dependency Graph</div>
        <div class="panel-desc">File-to-file dependency visualization</div>
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

      // Handle panel requests: /panel/files-map, /panel/symbol-changes, /panel/dependency-graph
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
║    • http://localhost:${PORT}/panel/dependency-graph          ║
║                                                            ║
║  Press Ctrl+C to stop                                      ║
╚════════════════════════════════════════════════════════════╝
`);
  });
}

// Run server
startServer();


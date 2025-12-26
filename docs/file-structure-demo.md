# File Structure Demo Documentation

## Overview

The File Structure Demo is a standalone HTML file that demonstrates the Radium File Structure visualization without requiring VSCode or any installation. It uses the exact same rendering code as the extension but with mock data.

## File Location

`demo/file-structure-demo.html`

## Features

### Demo-Specific Features

1. **Auto-Load on Page Open**
   - Demo data loads automatically when page opens
   - Shows Stormline.Game project structure immediately
   - No button clicks required

2. **Notification System**
   - Toast notifications for user actions
   - Shows when demo data is loaded
   - Shows when files are "opened"

3. **Mock VSCode API**
   - Simulates `vscode.postMessage()` calls
   - Logs file open requests to console
   - Shows notifications instead of opening files

4. **Demo Structure**
   - **Stormline.Game**: C# game project structure
   - Loads automatically on page open

### Visualization Features (from Extension)

All the core visualization features from the extension are preserved:

1. **Table Layout**
   - Root header showing project name
   - Category columns for top-level directories
   - Subdirectories with files listed underneath
   - Clean bordered table design

2. **Styling**
   - Dark theme (#1e1e1e background)
   - Purple category headers (#c8b6ff)
   - Blue subdirectory names (#4a9eff)
   - Hover effects on files

3. **Interactivity**
   - Clickable file names
   - Hover highlighting
   - Responsive layout

## Mock Data Structure

### Stormline.Game (C# Game Project)

```javascript
{
  "Views": {
    subdirectories: {
      "Screens": ["MainWindow.cs", "GameWindow.cs", "SettingsWindow.cs"],
      "Panels": ["UnitPanel.cs", "InventoryPanel.cs", "MapPanel.cs"],
      "Components": ["Button.cs", "Label.cs", "Icon.cs"]
    },
    files: ["ViewManager.cs", "BaseView.cs"]
  },
  "Services": {
    subdirectories: {
      "Network": ["ApiClient.cs", "WebSocketManager.cs"],
      "Storage": ["DatabaseService.cs", "CacheService.cs"]
    },
    files: ["ServiceA.cs", "ServiceB.cs", "ServiceC.cs", "ServiceRegistry.cs"]
  },
  // ... more directories
}
```

### MyWebApp (React/TypeScript Project)

```javascript
{
  "src": {
    subdirectories: {
      "components": ["Header.tsx", "Footer.tsx", "Sidebar.tsx", "Modal.tsx"],
      "pages": ["Home.tsx", "About.tsx", "Contact.tsx", "Dashboard.tsx"],
      "hooks": ["useAuth.ts", "useFetch.ts", "useLocalStorage.ts"],
      "utils": ["api.ts", "helpers.ts", "validators.ts"]
    },
    files: ["index.tsx", "App.tsx", "routes.tsx"]
  },
  // ... more directories
}
```

## Code Structure

### HTML Structure

```html
<div id="demo-header">
  <!-- Demo controls -->
</div>

<div id="demo-notification">
  <!-- Toast notifications -->
</div>

<div id="container">
  <table id="structure-table">
    <thead>
      <tr>
        <th id="root-header">Project Name/</th>
      </tr>
    </thead>
    <tbody id="structure-body">
      <!-- Dynamically generated rows -->
    </tbody>
  </table>
</div>
```

### JavaScript Components

1. **Mock VSCode API**
   ```javascript
   const vscode = {
     postMessage: function(message) {
       // Handle demo actions
     }
   };
   ```

2. **Data Generators**
   - `generateMockStructure()` - Creates Stormline.Game data
   - `generateAlternativeMockStructure()` - Creates MyWebApp data

3. **UI Functions**
   - `showNotification(message)` - Shows toast notifications
   - `renderStructure(structure)` - Core rendering logic (from extension)

4. **Event Handlers**
   - Load button click handler
   - File click handlers (in renderStructure)

## Styling Differences from Extension

### Demo-Specific Styles

```css
#demo-header {
  /* Purple gradient header */
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

#demo-notification {
  /* Toast notification styling */
  position: fixed;
  top: 80px;
  right: 20px;
}
```

### Adjustments for Demo

- `body { padding-top: 80px; }` - Space for demo header
- `th { top: 70px; }` - Adjusted sticky header position

## Usage Instructions

### For Users

1. Download or open `file-structure-demo.html`
2. Open in any modern browser
3. Demo data loads automatically
4. Click file names to see simulated opening

### For Developers

To change the demo structure:

```javascript
// Modify the auto-load handler
window.addEventListener('load', () => {
  const structure = { name: "YourProject", data: generateYourStructure() };
  document.getElementById('root-header').textContent = structure.name + '/';
  renderStructure(structure.data);
});
```

## Browser Compatibility

Tested and working on:
- ✅ Chrome/Edge (Chromium)
- ✅ Firefox
- ✅ Safari
- ✅ Opera

Requires:
- Modern JavaScript (ES6+)
- CSS Grid/Flexbox support
- DOM manipulation APIs

## Differences from Extension

### What's Included
- ✅ Exact same rendering logic
- ✅ Same visual styling
- ✅ Same table layout algorithm
- ✅ File click interactions
- ✅ Hover effects

### What's Not Included
- ❌ Real file system access
- ❌ VSCode integration
- ❌ Actually opening files
- ❌ Radiumignore filtering
- ❌ Dynamic reloading
- ❌ Multi-root workspace support

## Future Enhancements

Potential improvements for the demo:

1. **More Demo Data**
   - Add 3-4 more project structures
   - Include different programming languages
   - Show deeply nested directories

2. **Interactive Features**
   - Search/filter functionality
   - Collapsible sections
   - Sort options

3. **Visual Enhancements**
   - File type icons
   - Color coding by file type
   - Line count badges

4. **Educational Features**
   - Tooltips explaining features
   - Guided tour
   - Code snippets showing how it works

## Maintenance

When updating the extension's File Structure view:

1. Copy the CSS from `file-structure-panel.ts` to demo
2. Copy the `renderStructure()` function
3. Adjust for demo-specific styling (padding, header position)
4. Test in multiple browsers
5. Update mock data if structure format changes

## Related Files

- Source: `src/views/file-structure-panel.ts`
- Documentation: `docs/file-structure-view.md`
- Demo README: `demo/README.md`
- Main README: `README.md`


# Symbol Visualization Refactor

## Overview
Complete refactor of the symbol changes visualization to implement a minimalist, two-column layout design.

## Key Changes

### 1. Layout Architecture

#### Dynamic Row-Based System
- **Adaptive Layout**: Only displays rows for symbol categories that have changes
- **Row Categories** (in order):
  1. Variables & Constants (circles)
  2. Types & Interfaces (rectangles)
  3. Classes (rectangles)
  4. Functions & Methods (rectangles)
- **Horizontal Flow**: Symbols flow left-to-right within each row
- **File Width**: 600px per file (accommodates multiple symbols per row)

#### Symbol Positioning Logic
```javascript
// Row assignment by category
getSymbolCategory(type):
  'variable' | 'constant' → 'variables' (Row 1)
  'interface' | 'type' → 'types' (Row 2)
  'class' → 'classes' (Row 3)
  'function' | 'method' → 'functions' (Row 4)

// Position calculation
Y = ROW_START_Y + (rowIndex × (SYMBOL_HEIGHT + ROW_SPACING))
X = group.x + 10 + (indexInRow × (SYMBOL_WIDTH + SYMBOL_SPACING_X))

// Spacing constants
SYMBOL_SPACING_X = 15px  // Between symbols in a row
ROW_SPACING = 25px       // Between rows
```

### 2. Visual Design

#### Minimalist Styling
- **Borders**: Reduced from 3px to 1.5px
- **Backgrounds**: Transparent with 3% color tint
- **Shadows**: Removed (replaced with subtle border animations)
- **Padding**: Reduced to 6px 10px (very compact)
- **Content**: Only name + change symbol (`*`, `~`, `-`)

#### Shape Definitions
```css
Variables/Constants:
- border-radius: 50% (perfect circles)
- width/height: 70px
- display: flex (for centering content)

Functions/Classes/Methods:
- border-radius: 4-8px (rounded rectangles)
- width: 160px
- height: 50px (fixed height)
- display: flex (for centering content)
```

#### Typography
- **Symbol name**: 12px, weight 400, centered
- **Change symbol**: 14px, weight 600, opacity 0.7
- **File labels**: 13px, weight 500, opacity 0.7

#### Content Structure
```html
<div class="symbol-box function">
  <div class="symbol-content">
    <span class="symbol-name">functionName</span>
    <span class="change-symbol">*</span>
  </div>
</div>
```

**Design Rule**: Each box contains ONLY:
1. The symbol name (function/variable/type/class)
2. A change indicator (`*` = added, `~` = modified, `-` = deleted)

### 3. Animation Updates

#### Border Pulse (Replaces Box-Shadow Pulse)
```css
@keyframes pulseGreen {
  0%, 100% { border-color: #4EC9B0; opacity: 1; }
  50% { border-color: #6EDDC0; opacity: 0.85; }
}
```

- **Duration**: 3 seconds (up from 2s)
- **Effect**: Subtle border color shift
- **Types**: Green (added), Yellow (modified), Orange (value changed), Red (deleted)

### 4. Code Architecture

#### File Group Structure
```javascript
fileGroups = {
  symbols: Map(),           // symbolKey -> elements[]
  symbolPositions: Map(),   // symbolName -> {name, element, x, y}
  x: number,               // File column X position
  elements: [],            // All DOM elements
  fileLabel: HTMLElement   // File path label
}
```

#### Symbol Positioning Logic
1. Determine symbol type (variable vs function/class/etc)
2. Get existing symbols in file, separate by column
3. Calculate index within appropriate column
4. Position based on column and index
5. Store position in `symbolPositions` map for connections

### 5. Connection System

#### Symbol Position Tracking
- Each symbol's center position stored in `group.symbolPositions`
- Persists across symbol updates
- Used for drawing call relationship lines

#### Connection Drawing
```javascript
// Retrieve positions from map
const fromSymbol = group.symbolPositions.get(call.from);
const toSymbol = group.symbolPositions.get(call.to);

// Draw curved path between centers
const midX = (x1 + x2) / 2;
const midY = (y1 + y2) / 2 - 50;
const path = `M ${x1} ${y1} Q ${midX} ${midY} ${x2} ${y2}`;
```

### 6. UI Controls

#### Minimalist Controls
- **Zoom buttons**: 32×32px (down from 40×40px)
- **Backgrounds**: Transparent
- **Borders**: 1px, subtle
- **Opacity**: 0.6 default, 1.0 on hover
- **Clear button**: Smaller, cleaner styling

### 7. Constants

```javascript
FILE_COLUMN_WIDTH = 600    // Total width per file
FUNCTION_WIDTH = 160       // Rectangle width (compact)
FUNCTION_HEIGHT = 50       // Rectangle height (compact)
VARIABLE_SIZE = 70         // Circle diameter (compact)
SYMBOL_SPACING_X = 12      // Horizontal spacing between symbols
SYMBOL_SPACING_Y = 15      // Vertical spacing (legacy, kept for compatibility)
ROW_SPACING = 20           // Spacing between rows
FILE_LABEL_HEIGHT = 45     // Space for file label
ROW_START_Y = 95           // Where first row starts (50 + FILE_LABEL_HEIGHT)
```

### 8. Change Symbols

```javascript
getChangeSymbol(changeType):
  'added' → '*'
  'modified' → '~'
  'deleted' → '-'
  'value_changed' → '~'
```

## Benefits

### User Experience
1. **Cleaner Visual Hierarchy**: Clear separation between data (variables) and behavior (functions)
2. **Reduced Visual Noise**: Minimalist styling focuses attention on content
3. **Better Space Utilization**: Two-column layout is more compact
4. **Improved Scannability**: Distinct shapes make symbol types immediately recognizable

### Technical
1. **Persistent Position Tracking**: `symbolPositions` map enables reliable connections
2. **Column-Based Layout**: Independent vertical stacking per column
3. **Scalable Architecture**: Easy to add new symbol types to appropriate column
4. **Clean Separation**: Logic clearly separated by symbol category

## Testing Checklist

- [ ] Variables appear as circles in left column
- [ ] Functions appear as rectangles in right column
- [ ] Multiple symbols stack correctly within columns
- [ ] Call relationships draw correctly between symbols
- [ ] Animations are subtle and non-distracting
- [ ] Hover tooltips work for all symbol types
- [ ] File labels are centered correctly
- [ ] Zoom and pan work smoothly
- [ ] Clear button removes all symbols

## Future Enhancements

1. **Collapsible Columns**: Allow hiding variables or functions column
2. **Symbol Filtering**: Filter by symbol type or change type
3. **Grouping**: Group related symbols (e.g., class methods together)
4. **Search**: Find specific symbols by name
5. **Export**: Export visualization as image or data


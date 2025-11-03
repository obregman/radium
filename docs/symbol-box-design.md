# Symbol Box Design Specification

## Clean Design Rule

Each symbol box contains **ONLY TWO ELEMENTS**:
1. **Symbol name** (function/variable/type/class name)
2. **Change symbol** (`*`, `~`, or `-`)

## Visual Examples

### Functions
```
┌─────────────────────┐
│  functionName  *    │  ← Added
└─────────────────────┘

┌─────────────────────┐
│  updateUser  ~      │  ← Modified
└─────────────────────┘

┌─────────────────────┐
│  deleteItem  -      │  ← Deleted
└─────────────────────┘
```

### Variables (Circles)
```
    ┌─────────┐
   │  count  │
   │    *    │  ← Added
    └─────────┘

    ┌─────────┐
   │  total  │
   │    ~    │  ← Modified
    └─────────┘
```

### Complete File Example
```
src/userService.ts
────────────────────────────────────────

Row 1 (Variables):
  ⭕ userId *    ⭕ userName ~

Row 2 (Functions):
  ▭ getUser *    ▭ updateUser ~    ▭ deleteUser -
```

## Change Symbols

| Symbol | Meaning | Change Type |
|--------|---------|-------------|
| `*` | Added | New symbol created |
| `~` | Modified | Code or value changed |
| `-` | Deleted | Symbol removed |

## Dimensions

### Rectangles (Functions/Classes/Types)
- **Width**: 160px
- **Height**: 50px
- **Padding**: 6px 10px
- **Border**: 1.5px solid
- **Border radius**: 4-8px (depends on type)

### Circles (Variables/Constants)
- **Diameter**: 70px
- **Padding**: 6px
- **Border**: 1.5px solid
- **Border radius**: 50%

## Typography

### Symbol Name
```css
font-size: 12px
font-weight: 400
text-align: center
overflow: hidden
text-overflow: ellipsis
white-space: nowrap
```

### Change Symbol
```css
font-size: 14px
font-weight: 600
opacity: 0.7
```

## Layout Structure

```html
<div class="symbol-box function added">
  <div class="symbol-content">
    <span class="symbol-name">functionName</span>
    <span class="change-symbol">*</span>
  </div>
</div>
```

## Color Coding

### By Symbol Type
- **Functions**: Teal border (#4EC9B0)
- **Classes**: Blue border (#4FC1FF)
- **Methods**: Purple border (#C586C0)
- **Interfaces**: Light blue dashed (#9CDCFE)
- **Types**: Light blue dashed (#9CDCFE)
- **Variables**: Yellow border (#DCDCAA)
- **Constants**: Gold border (#D7BA7D)

### By Change Type (Animation)
- **Added** (`*`): Green border pulse
- **Modified** (`~`): Yellow border pulse
- **Deleted** (`-`): Red border pulse, 40% opacity

## Spacing

### Within Rows
- **Horizontal spacing**: 12px between symbols
- **Vertical spacing**: 20px between rows

### File Layout
```
File Label (13px, centered)
     ↓
   [45px gap]
     ↓
Row 1: Variables (if any)
     ↓
   [20px gap]
     ↓
Row 2: Types (if any)
     ↓
   [20px gap]
     ↓
Row 3: Classes (if any)
     ↓
   [20px gap]
     ↓
Row 4: Functions (if any)
```

## Design Principles

1. **Minimalism**: Only essential information
2. **Scannability**: Quick visual parsing
3. **Clarity**: Obvious change indicators
4. **Consistency**: Same pattern for all symbols
5. **Compactness**: Efficient use of space

## Anti-Patterns (What NOT to Include)

❌ Symbol type labels ("FUNCTION", "VARIABLE")
❌ Line numbers or file paths in boxes
❌ Detailed change statistics (+5/-3)
❌ Multiple lines of text
❌ Icons or emojis
❌ Background gradients
❌ Heavy shadows

## Why This Design Works

1. **Fast Recognition**: Shape + color = instant type identification
2. **Change Clarity**: Symbol (`*`/`~`/`-`) = immediate understanding
3. **Clean Aesthetics**: Minimal visual noise
4. **Space Efficient**: More symbols visible at once
5. **Scalable**: Works with many symbols per file

## Hover Behavior

On hover:
- Border width increases to 2px
- Scale increases to 1.03
- Tooltip shows detailed diff (after 1 second)

## Accessibility

- **Color blind friendly**: Shape differentiation (circles vs rectangles)
- **Text symbols**: `*`, `~`, `-` are universally understood
- **High contrast**: 1.5px borders ensure visibility
- **Readable fonts**: 12px minimum for names


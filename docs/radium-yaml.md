# radium.yaml Configuration Guide

## Overview

The `radium.yaml` file allows you to define custom logical components for your codebase visualization. Instead of displaying files grouped by directory structure, you can organize them by functional components that better represent your architecture.

## Location

Place the `radium.yaml` file at the root of your workspace:

```
/your-project/
  radium.yaml
  src/
  package.json
  ...
```

## Basic Syntax

```yaml
project-spec:
  components:
    - componentKey:
        name: Display Name
        description: Optional description shown as tooltip
        files:
          - path/to/files/**
          - specific/file.ts
```

## Structure

### Project Spec

The root element must be `project-spec` with a `components` array.

### Components

Each component is defined as an object with a single key (the component identifier). The value contains:

- **name** (required): Display name shown in the visualization
- **description** (optional): Tooltip text when hovering over the component box
- **files** (required): Array of file paths or glob patterns

### File Patterns

File patterns support:

1. **Exact paths**: `src/views/map-panel.ts`
2. **Wildcards**: `src/views/*.ts` (matches all .ts files in views/)
3. **Recursive wildcards**: `src/views/**` (matches everything under views/)
4. **Glob patterns**: `src/**/test_*.py` (matches test files anywhere under src/)

## Complete Example

```yaml
project-spec:
  components:
    - visualization:
        name: Visualization Layer
        description: All UI rendering and interactive components
        files:
          - src/views/**
          - src/webview/**
    
    - data-layer:
        name: Data Layer
        description: Database and storage management
        files:
          - src/store/**
          - src/indexer/**
    
    - integrations:
        name: External Integrations
        description: Git, LLM, and third-party integrations
        files:
          - src/git/**
          - src/orchestrator/**
    
    - core:
        name: Core Logic
        description: Business logic and analysis
        files:
          - src/analysis/**
          - src/config/**
          - src/extension.ts
```

## How It Works

### Component Matching

When Radium loads the map:

1. It reads `radium.yaml` from the workspace root
2. For each indexed file, it checks if the file path matches any component's file patterns
3. Files are grouped by their first matching component
4. Files that don't match any component fall back to directory-based grouping

### Visualization

- **Component boxes**: Larger cyan boxes representing logical components
- **File boxes**: Standard file boxes nested within component boxes
- **Edges**: Import relationships and dependencies between files
- **Classes/Interfaces**: Individual symbols shown as circles within files

## Benefits

### Logical Grouping

Instead of:
```
src/
  views/
  store/
  indexer/
```

You see:
```
[Visualization Layer]
  - map-panel.ts
  - sessions-tree.ts

[Data Layer]
  - schema.ts
  - indexer.ts
```

### Architecture Communication

- Clearly communicate system boundaries
- Show which files belong to which architectural layers
- Make onboarding easier for new developers

### Multi-Directory Components

Group related files that span multiple directories:

```yaml
- authentication:
    name: Authentication
    files:
      - src/auth/**
      - src/middleware/auth.ts
      - src/models/user.ts
```

## Tips

### Start Simple

Begin with high-level components and refine:

```yaml
project-spec:
  components:
    - frontend:
        name: Frontend
        files:
          - src/ui/**
    
    - backend:
        name: Backend
        files:
          - src/api/**
```

### Use Descriptions

Add helpful descriptions for component tooltips:

```yaml
- data-access:
    name: Data Access
    description: Repository pattern implementations and database queries
    files:
      - src/repositories/**
```

### Avoid Overlapping Patterns

Each file should match only one component. If patterns overlap, the first match wins:

```yaml
# ❌ Problematic - files in src/api/auth/ match both
- api:
    files:
      - src/api/**
- auth:
    files:
      - src/api/auth/**

# ✅ Better - more specific first
- auth:
    files:
      - src/api/auth/**
- api:
    files:
      - src/api/**
```

### Match Your Architecture

Align components with your architectural patterns:

**Layered Architecture:**
```yaml
- presentation:
    name: Presentation
- business:
    name: Business Logic
- data:
    name: Data Access
```

**Feature-Based:**
```yaml
- user-management:
    name: User Management
- billing:
    name: Billing System
- notifications:
    name: Notifications
```

## Troubleshooting

### Components Not Showing

1. Check file is named exactly `radium.yaml` at workspace root
2. Verify YAML syntax is valid
3. Check VS Code output for parsing errors
4. Reload window after editing radium.yaml

### Files Not Grouping Correctly

1. Verify file paths match from workspace root
2. Check for typos in glob patterns
3. Test patterns are more specific if overlapping
4. Remember paths are relative to workspace root

### Performance

Large glob patterns may impact initial load time. Be as specific as possible:

```yaml
# ❌ Too broad
files:
  - "**"

# ✅ Specific
files:
  - src/auth/**
```

## Reloading Configuration

After editing `radium.yaml`:

1. Save the file
2. Reload the VS Code window (Cmd/Ctrl + R)
3. Open Radium map to see updated grouping

Or programmatically reload:
```typescript
configLoader.load();
```

## Related

- [Architecture Documentation](./architecture.md)
- [Usage Guide](./usage-guide.md)
- [README](../README.md)

## Example Repository

See the Radium project's own `radium.yaml.example` for a working configuration.


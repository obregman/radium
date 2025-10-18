# radium-components.yaml Configuration Guide

## Overview

The `radium-components.yaml` file allows you to define custom logical components for your codebase visualization. Instead of displaying files grouped by directory structure, you can organize them by functional components that better represent your architecture.

## Location

Place the `radium-components.yaml` file at the root of your workspace:

```
/your-project/
  radium-components.yaml
  src/
  package.json
  ...
```

## Basic Syntax

```yaml
spec:
  components:
    - componentKey:
        name: Display Name
        description: Optional description shown as tooltip
        files:
          - path/to/files/**
          - specific/file.ts
```

## Structure

### Spec

The root element must be `spec` with a `components` array.

### Components

Each component is defined as an object with a single key (the component identifier). The value contains:

- **name** (required): Display name shown in the visualization
- **description** (optional): Tooltip text when hovering over the component box
- **files** (required): Array of file paths or glob patterns
- **external** (optional): Array of external objects (databases, APIs, services) that the component interacts with

### File Patterns

File patterns support:

1. **Exact paths**: `src/views/map-panel.ts`
2. **Wildcards**: `src/views/*.ts` (matches all .ts files in views/)
3. **Recursive wildcards**: `src/views/**` (matches everything under views/)
4. **Glob patterns**: `src/**/test_*.py` (matches test files anywhere under src/)

### External Objects

External objects represent systems, services, or resources outside your codebase that components interact with. Each external object contains:

- **type** (required): The type of external resource (e.g., PostgreSQL, S3, API, Redis, RabbitMQ)
- **name** (required): Display name of the external object
- **description** (optional): Additional details about the external resource

External objects are displayed as white rounded rectangles with black text in the visualization, connected to their parent component.

## Complete Example

```yaml
spec:
  components:
    - visualization:
        name: Visualization Layer
        description: All UI rendering and interactive components
        files:
          - src/views/**
          - src/webview/**
        external:
    
    - data-layer:
        name: Data Layer
        description: Database and storage management
        files:
          - src/store/**
          - src/indexer/**
        external:
          - type: SQLite
            name: GraphDB
            description: Stores code graph and analysis data
    
    - integrations:
        name: External Integrations
        description: Git, LLM, and third-party integrations
        files:
          - src/git/**
          - src/orchestrator/**
        external:
          - type: API
            name: OpenAI API
            description: LLM service for code analysis
    
    - core:
        name: Core Logic
        description: Business logic and analysis
        files:
          - src/analysis/**
          - src/config/**
          - src/extension.ts
        external:
```

## How It Works

### Component Matching

When Radium loads the map:

1. It reads `radium-components.yaml` from the workspace root
2. For each indexed file, it checks if the file path matches any component's file patterns
3. Files are grouped by their first matching component
4. Files that don't match any component fall back to directory-based grouping

### Visualization

- **Component boxes**: Larger colored boxes representing logical components (color-coded by component)
- **File boxes**: Standard file boxes nested within component boxes, with colored borders matching their component
- **External objects**: White rounded rectangles with black text, connected to their parent component
- **Edges**: Import relationships and dependencies between files and components

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

### Visualize External Dependencies

Show external systems and services your components depend on:

```yaml
- api-gateway:
    name: API Gateway
    files:
      - src/api/**
    external:
      - type: PostgreSQL
        name: UserDB
        description: Primary user database
      - type: Redis
        name: SessionCache
        description: Session storage and caching
      - type: S3
        name: MediaBucket
        description: User uploaded media files
```

This helps visualize the complete architecture including external dependencies.

## Tips

### Start Simple

Begin with high-level components and refine:

```yaml
spec:
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

1. Check file is named exactly `radium-components.yaml` at workspace root
2. Verify YAML syntax is valid
3. Check VS Code output for parsing errors
4. Reload window after editing radium-components.yaml

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

After editing `radium-components.yaml`:

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

See the Radium project's own `radium-components.yaml.example` for a working configuration.


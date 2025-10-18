# radium-features.yaml Configuration Guide

## Overview

The `radium-features.yaml` file allows you to define and visualize your product features, their relationships to components, and dependencies between features. This provides a high-level view of your product roadmap and how features map to your technical architecture.

## Location

Place the `radium-features.yaml` file at the root of your workspace:

```
/your-project/
  radium-features.yaml
  radium-components.yaml
  src/
  package.json
  ...
```

## Basic Syntax

```yaml
spec:
  features:
  - featureKey:
      name: Display Name
      description: Feature description
      status: in-progress
      owner: Team or person name
      components:
        - component-key-1
        - component-key-2
      dependencies:
        - other-feature-key
```

## Structure

### Features Array

The root element must be `spec` containing a `features` array with feature definitions.

### Feature Properties

Each feature is defined as an object with a single key (the feature identifier). The value contains:

- **name** (required): Display name shown in the visualization
- **description** (optional): Detailed description of the feature
- **status** (optional): One of `planned`, `in-progress`, `completed`, or `deprecated`. Defaults to `in-progress`
- **owner** (optional): Team or person responsible for the feature
- **components** (required): Array of component keys from `radium-components.yaml`
- **dependencies** (optional): Array of other feature keys this feature depends on

## Complete Example

```yaml
spec:
  features:
  - authentication:
      name: User Authentication
      description: Complete authentication system with login, registration, and password reset
      status: completed
      owner: Backend Team
      components:
        - backend
        - frontend
      dependencies: []

  - user-profile:
      name: User Profile Management
      description: Allow users to view and edit their profiles
      status: in-progress
      owner: Frontend Team
      components:
        - frontend
      dependencies:
        - authentication

  - social-login:
      name: Social Media Login
      description: OAuth integration with Google, Facebook, GitHub
      status: planned
      owner: Backend Team
      components:
        - backend
        - integrations
      dependencies:
        - authentication

  - admin-dashboard:
      name: Admin Dashboard
      description: Administrative interface for managing users and content
      status: in-progress
      owner: Full Stack Team
      components:
        - frontend
        - backend
      dependencies:
        - authentication
        - user-profile

  - analytics:
      name: Usage Analytics
      description: Track user behavior and generate reports
      status: planned
      owner: Data Team
      components:
        - backend
        - data-layer
      dependencies:
        - authentication
```

## Visualization

### Opening the Features Map

Run the command: `Radium: Features Map`

### Visual Elements

- **Feature Nodes**: Rectangular boxes representing features
  - **Blue**: In-progress features
  - **Green**: Completed features
  - **Gray**: Planned features
  - **Red**: Deprecated features

- **Component Nodes**: Cyan rectangular boxes representing technical components

- **Edges**:
  - **Solid blue lines**: Feature uses component
  - **Dashed orange lines**: Feature depends on another feature

### Interactions

- **Click a feature**: View details including status, owner, components, and dependencies
- **Drag nodes**: Rearrange the layout
- **Zoom**: Mouse wheel or pinch gesture
- **Pan**: Click and drag the background

## Use Cases

### Product Roadmap

Visualize your entire product roadmap with feature status:

```yaml
spec:
  features:
  - mvp-core:
      name: MVP Core Features
      status: completed
      components: [frontend, backend]
      
  - v2-enhancements:
      name: Version 2 Enhancements
      status: in-progress
      components: [frontend, backend]
      dependencies: [mvp-core]
      
  - v3-advanced:
      name: Version 3 Advanced Features
      status: planned
      components: [frontend, backend, ml-service]
      dependencies: [v2-enhancements]
```

### Feature-Component Mapping

Understand which components are involved in each feature:

```yaml
spec:
  features:
  - checkout-flow:
      name: Checkout Flow
      components:
        - frontend
        - backend
        - payment-service
        - notification-service
```

### Dependency Management

Track feature dependencies to plan development order:

```yaml
spec:
  features:
  - base-api:
      name: Base API
      status: completed
      dependencies: []
      
  - api-auth:
      name: API Authentication
      status: completed
      dependencies: [base-api]
      
  - api-rate-limiting:
      name: API Rate Limiting
      status: in-progress
      dependencies: [api-auth]
```

### Team Ownership

Assign features to teams and track progress:

```yaml
spec:
  features:
  - mobile-app:
      name: Mobile Application
      owner: Mobile Team
      status: in-progress
      
  - web-app:
      name: Web Application
      owner: Web Team
      status: completed
      
  - api-backend:
      name: API Backend
      owner: Backend Team
      status: completed
```

## Integration with Components

The `radium-features.yaml` works best when combined with `radium-components.yaml`:

**radium-components.yaml**:
```yaml
spec:
  components:
    - frontend:
        name: Frontend
        files:
          - src/ui/**
          - src/components/**
    
    - backend:
        name: Backend
        files:
          - src/api/**
          - src/services/**
```

**radium-features.yaml**:
```yaml
spec:
  features:
  - user-dashboard:
      name: User Dashboard
      components:
        - frontend  # References component from radium-components.yaml
        - backend
```

The Features Map will show both the high-level features and the technical components they depend on.

## Tips

### Start with High-Level Features

Begin with major features and refine over time:

```yaml
spec:
  features:
  - core-functionality:
      name: Core Functionality
      status: completed
      
  - advanced-features:
      name: Advanced Features
      status: in-progress
      
  - future-enhancements:
      name: Future Enhancements
      status: planned
```

### Use Status Effectively

Keep status up to date to track progress:

- `planned`: Not started, in the roadmap
- `in-progress`: Actively being developed
- `completed`: Done and deployed
- `deprecated`: No longer maintained or being removed

### Document Dependencies

Always document feature dependencies to avoid circular dependencies and plan development order.

### Assign Owners

Use the owner field to clarify responsibility and facilitate communication.

## Troubleshooting

### Features Map Shows Error

1. Check file is named exactly `radium-features.yaml` at workspace root
2. Verify YAML syntax is valid
3. Ensure `features` array exists
4. Check VS Code output for parsing errors

### Components Not Showing

If component nodes don't appear:

1. Verify component keys match those in `radium-components.yaml`
2. Check that components are referenced by at least one feature

### Dependencies Not Showing

If dependency edges don't appear:

1. Verify dependency keys match other feature keys exactly
2. Check for typos in feature keys

## Related

- [radium-components.yaml Format](./radium-yaml.md)
- [Architecture Documentation](./architecture.md)
- [Usage Guide](./usage-guide.md)
- [README](../README.md)

## Example Repository

See the Radium project's own `radium-features.yaml.example` for a working configuration.


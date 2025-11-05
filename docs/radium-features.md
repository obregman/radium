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
- **area** (optional): Category or area this feature belongs to (e.g., "Authentication", "User Management", "Reporting"). Defaults to `General`
- **components** (optional): Array of component keys from `radium-components.yaml`
- **dependencies** (optional): Array of other feature keys this feature depends on
- **flow** (optional): Array of flow items describing the feature's user flow or process steps

## Flow Items

Flow items describe the sequential steps in a feature's user flow or process. Each flow item has:

- **type** (required): One of `user`, `window`, `system`, `api`, or `database`
- **name** (required): Short name for the step
- **description** (optional): Detailed description of what happens in this step

Flow types are visualized with different colors:
- **user**: Purple - User actions (clicks, inputs, etc.)
- **window**: Orange - UI/screen changes
- **system**: Green - System processes
- **api**: Red - API calls
- **database**: Gray - Database operations

## Complete Example

```yaml
spec:
  features:
  - authentication:
      name: User Authentication
      description: Complete authentication system with login, registration, and password reset
      status: completed
      owner: Backend Team
      area: Security
      components:
        - backend
        - frontend
      dependencies: []

  - user-profile:
      name: User Profile Management
      description: Allow users to view and edit their profiles
      status: in-progress
      owner: Frontend Team
      area: User Management
      components:
        - frontend
      dependencies:
        - authentication

  - add-customer:
      name: Add New Customer
      description: Feature for adding a new customer to the system
      status: in-progress
      owner: Sales Team
      area: Customer Management
      components:
        - frontend
        - backend
      dependencies:
        - authentication
      flow:
        - type: user
          name: Click add new customer
          description: The user clicks on add new customer button
        - type: window
          name: Display new customer screen
          description: Shows the "new customer" screen to the user
        - type: user
          name: Fill customer details
          description: The user fills customer name, address, phone number and email
        - type: user
          name: Submit form
          description: User clicks the submit button
        - type: api
          name: Validate customer data
          description: Backend validates the customer information
        - type: database
          name: Save customer
          description: Store customer record in database
        - type: window
          name: Show success message
          description: Display confirmation to the user

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

The features map displays features organized by **areas** in a **collapsible card layout**:

- **Area Sections**: Features are grouped by their `area` property (e.g., "Authentication", "User Management")
- **Feature Cards**: Each feature is shown as a collapsible card with:
  - Feature name
  - Description (when collapsed)
  - Expand/collapse icon (▼)
  
- **Flow Visualization**: When a feature card is expanded, it shows:
  - Horizontal flow of steps from left to right
  - Arrows connecting sequential steps
  - Color-coded flow items by type:
    - **Purple**: User actions
    - **Orange**: UI/Window changes
    - **Green**: Logic/System processes
    - **Red**: Inbound API calls
    - **Pink**: Outbound API calls

### Interactions

- **Click a feature card**: Expand to view the flow diagram
- **Click again**: Collapse the feature card
- **Click a flow item**: If it has an `impl` property, opens the implementation file
- **Only one feature can be expanded at a time** for clarity

## Use Cases

### Organizing Features by Area

Group related features into areas for better organization:

```yaml
spec:
  features:
  - login:
      name: User Login
      area: Authentication
      status: completed
      
  - register:
      name: User Registration
      area: Authentication
      status: completed
      
  - password-reset:
      name: Password Reset
      area: Authentication
      status: in-progress
      
  - view-profile:
      name: View Profile
      area: User Management
      status: completed
      
  - edit-profile:
      name: Edit Profile
      area: User Management
      status: in-progress
      
  - sales-report:
      name: Sales Report
      area: Reporting
      status: planned
      
  - inventory-report:
      name: Inventory Report
      area: Reporting
      status: planned
```

In the visualization, features will be grouped under their respective area headers, making it easy to see all features in a specific domain at a glance.

### Feature Flows

Document user flows and process steps for features:

```yaml
spec:
  features:
  - checkout:
      name: Checkout Process
      components:
        - frontend
        - backend
        - payment-service
      flow:
        - type: user
          name: Review cart
          description: User reviews items in shopping cart
        - type: user
          name: Click checkout
          description: User initiates checkout process
        - type: window
          name: Show shipping form
          description: Display shipping address form
        - type: user
          name: Enter shipping info
          description: User fills in shipping details
        - type: window
          name: Show payment form
          description: Display payment information form
        - type: user
          name: Enter payment details
          description: User enters credit card information
        - type: api
          name: Process payment
          description: Send payment to payment gateway
        - type: database
          name: Create order
          description: Save order to database
        - type: window
          name: Show confirmation
          description: Display order confirmation page
```

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

See the Radium project's own `radium-features.yaml.example` for working configurations.


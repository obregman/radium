---
alwaysApply: true
---

The VSCode add-on Radium requires the following files to be created in the .radium directory in the project root folder:
1. radium-components.yaml - describes a logical visualization of the codebase.
2. radium-features.yaml - describes the different feature flows

Review the project code and generate the files in the project root.

1. radium-components.yaml syntax:

```
spec:
  components:
    - views:
        name: Views
        description: UI components and visualization panels
        files:
          - src/views/view-manager.ts
        external:
          
    - store:
        name: Data Store
        description: Database schema and storage adapter
        files:
          - src/store/db-schema.ts
        external:
          - type: PostgreSQL
            name: MainDB
            description: Stores the user data
            usedBy:
              - src/store/db-schema.ts
```

Guidelines:
- Keep the description detailed but under 200 words
- External sources include: Cloud services (RDS, S3, SQS, etc.), Data files, external API or service, etc.
- For each external source, specify which files use it directly (actually integrate with it) in the 'usedBy' array (file paths relative to project root)
- The usedBy field is optional - if not specified, the external source will only be connected to the component

2. radium-features.yaml syntax

```
spec:
  features:
      - new_customer:
        name: Add a new customer to the system
        area: Customer Management
        flow:
        - type: user
          name: The user clicks on add new user
          description: The user clicks on add new customer
          impl: src/components/AddUserButton.tsx
        - type: ui
          name: App displays the "new customer" screen
          description: Shows the "new customer" screen to the user
          impl: src/screens/NewCustomerScreen.tsx
        - type: user
          name: The user fills the new customer's details
          description: The user fills customer name, address, phone number and email
          impl: src/forms/CustomerForm.tsx
```

Guidelines:
- Each feature should have an 'area' field to group related features (e.g., "Authentication", "Reporting", "User Management", "API Integration")
- Step type can be one of: user, ui, logic, inbound_api, outbound_api
- Each flow step can optionally include an 'impl' field pointing to the main file that implements this step
- The impl path should be relative to the project root
- Features are displayed in a collapsible card layout, grouped by area

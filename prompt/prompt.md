---
alwaysApply: true
---

The VSCode add-on Radium requires the following files to be available in the project root folder:
1. radium-components.yaml - describes a logical visualization of the codebase.
2. radium-features.yaml - describes the different feature flows
3. radium-req.yaml - describes the feature requirements

Review the project code and generate the files in the project root.

1. radium-components.yaml syntax:

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

Guidelines:
- Keep the description detailed but under 200 words
- External sources include: Cloud services (RDS, S3, SQS, etc.), Data files, external API or service, etc.
- For each external source, specify which files use it directly (actually integrate with it) in the 'usedBy' array (file paths relative to project root)
- The usedBy field is optional - if not specified, the external source will only be connected to the component

2. radium-features.yaml syntax

spec:
  features:
      - new_customer:
        name: Add a new customer to the system
        flow:
        - type: user
          name: The user clicks on add new user
          description: The user clicks on add new customer
        - type: window
          name: App displays the "new customer" screen
          description: Shows the "new customer" screen to the user
        - type: user
          name: The user fills the new customer's details
          description: The user fills customer name, address, phone number and email


3. radium-req.yaml syntax:

spec:
  requirements:
    - feature-key:
        name: "Feature Display Name"
        description: "Brief description of what this feature does"
        requirements:
          - id: req-unique-id
            text: "Specific, measurable requirement description"
            status: not-started | in-progress | implemented | verified

Guidelines:
- Each feature block must have a name and description field
- The feature name should be clear and user-facing
- The description should briefly explain the feature's purpose
- Write clear, specific, and measurable requirements
- Use action-oriented language (e.g., "User can...", "System validates...")
- Keep each requirement atomic (one testable thing)
- Set status based on implementation progress:
  * not-started: No implementation yet (gray gauge)
  * in-progress: Partially implemented (orange gauge)
  * implemented: Fully implemented (green gauge)
  * verified: Implemented and tested (blue gauge)
- Features in radium-req.yaml are independent from radium-features.yaml
- Generate requirements based on the feature's purpose and user needs
          

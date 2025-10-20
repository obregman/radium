---
alwaysApply: true
---

The VSCode add-on Radium requires a radium-components.yaml file to define a logical visualization of the codebase.
Review the project code and generate and maintain a radium-components.yaml file at the project root with the following syntax (using `spec:` as the root key):

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

- Keep the description detailed but under 200 words
- External sources include: Cloud services (RDS, S3, SQS, etc.), Data files, external API or service, etc.


Also generate and maintain the radium-features.yaml file in the project root that specifies the different feature flows
The radium-features.yaml file should have the following syntax:

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
          

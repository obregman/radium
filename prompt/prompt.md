The VSCode add-on Radium requires a radium.yaml file to define a logical visualization of the codebase.
Review the project code and generate and maintain a radium.yaml file at the project root with the following syntax:

project-spec:
  components:
    - views:
        name: Views
        description: UI components and visualization panels
        files:
          - src/views/view-manager.ts
    - store:
        name: Data Store
        description: Database schema and storage adapter
        files:
          - src/store/db-schema.ts
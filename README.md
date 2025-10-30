# Radium

A VS Code extension that visualizes your codebase as an interactive graph and tracks changes made by LLMs.

## What It Does

Radium indexes your codebase and creates a visual map showing files, their relationships, and how they're organized into components. When working with LLMs, it tracks all changes made to your code, allowing you to review, apply, or rollback them.

## Features

- Interactive graph visualization of your codebase
- Component-based architecture view (defined in `.radium/radium-components.yaml`)
- Track and manage LLM-generated changes
- Automatic change detection every 1 minute when component view is open
- Impact analysis for code modifications
- Support for TypeScript, JavaScript, and Python
- Session history and rollback capability

## Usage

### Basic Setup

1. Install the extension
2. Open your project in VS Code
3. Run command: `Radium: Open Map`

The extension indexes your workspace and displays an interactive graph.


### Available Commands

- `Radium: Open Map` - Show the codebase graph
- `Radium: Features Map` - Visualize features and their relationships
- `Radium: Preview LLM Plan from Clipboard` - Preview changes
- `Radium: Apply LLM Plan` - Apply previewed changes
- `Radium: Undo Last LLM Session` - Rollback a session
- `Radium: Find Impact` - Analyze impact of selected code
- `Radium: Export Session Patch` - Export session as patch file

## Configuration

Available settings:

```json
{
  "radium.indexer.maxCPU": 2,
  "radium.privacy.upload": "none",
  "radium.graph.layout": "force",
  "radium.tests.autoRun": true
}
```

## Installation

### From GitHub Releases

Download the `.vsix` file from the [Releases page](https://github.com/obregman/radium/releases).

Install via VS Code:
1. Extensions view → `...` menu → "Install from VSIX..."
2. Select the downloaded file

Or via command line:
```bash
code --install-extension radium-0.1.0.vsix
```


**Requirements:** Node.js 20 or later

```bash
npm install
npm run compile
npm run package
```

This creates a `.vsix` file you can install.

## Prompt

Add this instruction to your project to trigger the generation of the necessary yaml files:

```markdown

The VSCode add-on Radium requires the following files to be available in the .radium directory:
1. .radium/radium-components.yaml - describes a logical visualization of the codebase.
2. .radium/radium-features.yaml - describes the different feature flows

Review the project code and generate the files in the .radium directory.

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
          impl: src/components/AddUserButton.tsx
        - type: window
          name: App displays the "new customer" screen
          description: Shows the "new customer" screen to the user
          impl: src/screens/NewCustomerScreen.tsx
        - type: user
          name: The user fills the new customer's details
          description: The user fills customer name, address, phone number and email
          impl: src/forms/CustomerForm.tsx

Guidelines:
- Each flow step can optionally include an 'impl' field pointing to the main file that implements this step
- The impl path should be relative to the project root
```

## License

MIT

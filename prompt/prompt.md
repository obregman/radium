The VSCode add-on Radium requires a radium.yaml file to define a logical visualization of the codebase.
Review the project code and generate and maintain a radium.yaml file at the project root with the following syntax:

project-spec:
    components:
    - componentA:
        name: ComponentA
        description: ...
        files:
        - file1
        - file2
        ...
    
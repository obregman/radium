this describes the new feature: file-enrichment
the end user (or a coding agent they will use) will be able to enrich their source files with annotations (as comments) that add another layer of knowledge to the code.
for example: description or additional insights, knowledge about external components the code
interacts with, such as databases, files or APIs. Also tagging them as part of a cross code feature.
annotation format example:

/// radium-yaml-start
/// description: User authentication service - handles login, logout, and session management
/// feature-tags: [auth]
/// external-sources:
///   - type: database
///     name: users_db
///     description: holds the users data and roles
/// radium-yaml-end

feature-tags: lists the features or components this file participates in
external-sources types: database, api, files, cache
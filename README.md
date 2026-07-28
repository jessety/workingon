# boilerplate-typescript-service

Boilerplate for a TypeScript Node service

[![ci](https://github.com/jessety/boilerplate-typescript-service/workflows/ci/badge.svg)](https://github.com/jessety/boilerplate-typescript-service/actions/workflows/ci.yml)

Requires Node 20.19 or later.

## Includes

- TypeScript configuration
- `ts-jest` setup for automated testing
- ESLint rules & `editorconfig` for linting
- Prettier and ESLint for deterministic code formatting
- CI - build, lint & test
- GitHub Releases generated with automatic changelogs populated via a configurable template
- Dependabot configuration for both npm and GitHub Actions
- VSCode settings
- Modern JS compilation target (native ES modules)
- PM2 ecosystem file

## Modules

The project compiles to native ES modules with TypeScript's `NodeNext` module resolution, which means **relative imports must include a file extension**, and that extension is `.js` even in TypeScript source:

```ts
import { add } from './math.js';
```

## Release

First, determine what kind of [semantic versioning](https://semver.org) bump this release will require. Updates should fall into one of three categories: `major` (new functionality with breaking changes) `minor` (new functionality without breaking changes) or `patch` (backwards compatible bug fixes).

To publish a new release, checkout the make sure your git repository is clean and run one of the following commands:

- `npm run release:major` (new functionality with breaking changes)
- `npm run release:minor` (new functionality without breaking changes)
- `npm run release:patch` (backwards compatible bug fixes)

Running any one of these will:

1. Increment the version number in `package.json` (and `package-lock.json` if available)
2. Create a git tag with the new version number
3. Push these changes to GitHub, which triggers the `release` workflow in GitHub Actions
4. The `release` workflow then creates a new GitHub release with changelog automatically populated with all PRs and commits since the last version

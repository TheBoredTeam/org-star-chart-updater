# Multi-Repository Star History Updater Design

## Goal

Replace the pinned `nicoloboschi/gh-stars` GitHub Action with a local, dependency-free Node.js updater that can generate star histories for an explicit list of `TheBoredTeam` repositories. The first configured repository remains `boring.notch`.

## Scope and constraints

- Repository names are configured as a newline-separated list in `.github/workflows/update-stars.yml`.
- The same list is passed to both `actions/create-github-app-token` and the Node.js updater.
- The workflow uses one GitHub App installation token scoped to the configured repositories.
- The updater targets `TheBoredTeam` by default through an explicit workflow environment variable.
- Each configured repository produces files under `projects/<repository>/`.
- Generated charts are static SVGs with separate light and dark variants.
- The updater has no third-party runtime dependencies and runs on the Node.js version available on GitHub-hosted runners.
- Existing generated data may be migrated to a new schema because this repository's generated JSON is consumed only by the updater and chart generator.
- The README credits `star-history.com` as chart inspiration and retains attribution for copied MIT-licensed Reasonix code.

## Recommended architecture

### Workflow configuration

The workflow will define a single source of truth for the repository names:

```yaml
env:
  STAR_HISTORY_OWNER: TheBoredTeam
  STAR_HISTORY_REPOSITORIES: |
    boring.notch
```

The app-token step will receive `owner: ${{ env.STAR_HISTORY_OWNER }}` and `repositories: ${{ env.STAR_HISTORY_REPOSITORIES }}`. The updater step will receive the same owner and repository-list values plus `STAR_HISTORY_GITHUB_TOKEN` from the app-token output.

Adding another repository will require adding one line to the list and ensuring the GitHub App is installed for that repository. No repository-specific config file or automatic organization discovery is required.

### Updater script

Create a single ESM script at `scripts/update-star-history.mjs` with small, testable functions for:

1. Parsing and validating the owner and newline/comma-separated repository list.
2. Fetching all stargazer pages from GitHub with the `application/vnd.github.star+json` response format.
3. Retrying transient HTTP responses and network failures with bounded exponential backoff.
4. Converting `starred_at` timestamps into sorted daily cumulative star points.
5. Writing one JSON file and two SVG variants for each repository.

Repositories will be processed sequentially so failures identify the repository that failed and API traffic remains predictable. A failure in any repository will fail the workflow before the commit step.

### Data format

Each generated `data.json` will use a versioned, self-contained format:

```json
{
  "schemaVersion": 2,
  "repository": "TheBoredTeam/boring.notch",
  "generatedAt": "2026-08-04T00:00:00.000Z",
  "points": [
    { "date": "2024-08-02", "stars": 7 },
    { "date": "2024-08-03", "stars": 16 }
  ]
}
```

The script will rebuild this file from the fetched stargazer history on each run. It will include a final point for the current UTC date when the latest star event is earlier than today, so a chart always communicates the latest observed total.

### SVG outputs and styling

For each repository, write:

- `projects/<repository>/chart-light.svg`
- `projects/<repository>/chart-dark.svg`

Both variants will share the same dimensions, geometry, labels, and accessible metadata. The visual system will be GitHub-inspired without copying external assets:

- Light background, border, grid, text, and muted text colors based on GitHub Primer neutrals.
- Dark background, border, grid, text, and muted text colors based on GitHub’s dark palette.
- A GitHub-style blue accent for the line, area fill, endpoint marker, and current-value badge.
- Rounded chart frame, restrained title/subtitle hierarchy, readable axis labels, and a compact legend.
- Escaped XML text and `<title>`/`<desc>` metadata for repository names and current totals.
- No `nicoloboschi/gh-stars` branding or external font payloads in generated output.

The charts will plot daily cumulative points, use a human-friendly rounded Y-axis maximum, and format date ticks according to the visible time span.

### Commit behavior

The workflow will stage `projects/` and commit only when generated files change. The commit message will identify the generated update. The workflow will retain the existing scheduled and manually dispatched triggers, concurrency group, checkout step, and push behavior.

## Documentation and attribution

The README will describe the repository as a scheduled multi-repository star-history generator, document the multiline repository list, and list the generated files. It will credit:

- [star-history.com](https://www.star-history.com/) and [star-history/star-history](https://github.com/star-history/star-history) as the inspiration for the charting experience.
- [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) for the MIT-licensed updater code that was adapted into this repository.

Add `THIRD-PARTY-NOTICES.md` with the Reasonix MIT copyright and permission notice. The repository’s own MIT license remains unchanged; the third-party notice documents the copied upstream portion without implying that this repository is a Reasonix fork.

## Error handling and safety

- Missing token, owner, or repository list produces a clear validation error before network calls.
- Invalid repository names and malformed GitHub timestamps fail with repository-specific messages.
- HTTP 429 and 5xx responses, plus network errors, are retried up to four attempts with bounded backoff.
- Unexpected response shapes and invalid pagination metadata fail closed instead of writing partial output.
- XML special characters in repository names and descriptions are escaped before rendering.
- Output directories are created only under the configured `projects/` root.
- The workflow requests contents write permission only for committing generated files, while the app token is explicitly scoped to the listed repositories.

## Verification

The implementation will include:

- Node’s built-in test runner tests for repository-list parsing, pagination-link parsing, daily-series construction, XML escaping, and light/dark SVG rendering.
- A fixture-based script run that verifies all three generated files for `boring.notch` and checks the schema version and repository identifier.
- YAML/static checks confirming that `nicoloboschi/gh-stars` is absent, the multiline list is shared by both workflow steps, and the generated file paths match the commit step.
- Final diff and Git status review before commit, push, and draft PR creation.

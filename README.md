# org-star-chart-updater

This repository hosts a scheduled GitHub Actions workflow that updates the star chart in `boring/notch` using [`nicoloboschi/gh-stars`](https://github.com/nicoloboschi/gh-stars).

## Required organization secrets

Create a GitHub App for cross-repo automation and add its installation token as an organization secret:

- `ORG_STAR_CHART_APP_TOKEN`: GitHub App installation token with access to `boring/notch` contents (read/write).

The workflow uses this token to:

1. Check out `boring/notch`.
2. Run `gh-stars`.
3. Commit and push updated `README.md` when changes are detected.

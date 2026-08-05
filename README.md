# org-star-chart-updater

This repository hosts a scheduled GitHub Actions workflow that updates the star chart in `boring/notch` using [`nicoloboschi/gh-stars`](https://github.com/nicoloboschi/gh-stars).

The workflow generates a GitHub App installation token from `RELEASE_APP_CLIENT_ID` (organization Actions variable) and `RELEASE_APP_PRIVATE_KEY` (organization Actions secret), then uses that token to:

1. Check out `boring/notch`.
2. Run `gh-stars`.
3. Commit and push updated `README.md` when changes are detected.

# Contributing to VaultPeer Desktop

The source is open to use as per the [LICENSE](./LICENSE).

Be aware that **any pull request or issue may be closed without explanation**.

## Issues

- Feature requests are welcome.
- For bug reports, please provide a failing test case or steps to reproduce.

## Pull Request

Newer contributors are encouraged to start small and simple. Tests — both failing and passing — are very helpful.

- Keep pull requests focused on a single feature or bug fix
- Provide a clear description of changes
- Ensure the frontend type-check passes: `npm run lint`
- Ensure tests pass: `npm test`
  - except, of course, any added failing tests
- Run Rust tests when touching the backend: `cd src-tauri && cargo test`

## License

By contributing, you agree that your contributions will be licensed under the project [LICENSE](./LICENSE).

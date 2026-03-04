# Documentation Policy

**NEVER commit documentation files to the repository.** All documentation, testing guides, implementation notes, security audits, and similar files MUST be stored in `.docs/` directory (git-ignored).

Examples of files that should NOT be committed:
- `TESTING_*.md`
- `SECURITY_AUDIT.md`
- `IMPLEMENTATION_NOTES.md`
- `TODO.md`
- Any other internal documentation files

The only documentation files allowed in the repository are:
- `README.md` (user-facing)
- `CLAUDE.md` (contributor guide)
- Cloud-specific `README.md` files in `sh/{cloud}/README.md`

If you need to create documentation during development, write it to `.docs/` and add `.docs/` to `.gitignore`.

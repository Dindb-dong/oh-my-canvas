# Repository Instructions

Follow the machine-wide defaults supplied by the host.

## Native desktop QA

Use a task-owned profile and launch `omc-desktop --profile <isolated-directory> --automation-background` for native UI tests, screenshots, and smoke runs. Keep the test window hidden and unfocused, seed only the isolated profile, and stop task-owned processes afterward. Do not use `open`, activate a test window, or use the installed user's default profile for QA. If a check needs foreground interaction, ask for explicit permission and continue with background checks.

## Internal documentation

Keep agent plans, task notes, internal reviews and their evidence under the primary checkout's Git-ignored `internal/docs/` directory, including when working in a worktree. Resolve the primary checkout from the first `worktree` entry in `git worktree list --porcelain`. Do not create worktree-local copies, force-add these files, or include them in outgoing commits. Public documentation must not link to local-only artifacts. Keep maintained product/developer documentation and the shareable design contract in tracked documentation.

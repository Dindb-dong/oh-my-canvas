# Repository Instructions

Follow the machine-wide defaults supplied by the host.

## Internal documentation

Keep agent plans, task notes, internal reviews and their evidence under the primary checkout's Git-ignored `internal/docs/` directory, including when working in a worktree. Resolve the primary checkout from the first `worktree` entry in `git worktree list --porcelain`. Do not create worktree-local copies, force-add these files, or include them in outgoing commits. Public documentation must not link to local-only artifacts. Keep maintained product/developer documentation and the shareable design contract in tracked documentation.

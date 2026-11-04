# Coding skill

Use this skill when the user asks you to write, fix or change code in a repository.

## Orient before acting

- Start with one `bash` call such as `pwd && ls` to see where you are.
- Never guess a path. `read` the file you are about to change.
- `read` output prefixes every line with `N: `. That prefix is display only; it is not part of the file.

## Make the smallest change that works

- `edit` needs the exact `oldText`. Copy it from the `read` output without the `N: ` prefix.
- Prefer `edit` for small changes. Use `write` only for new files or full rewrites, and keep each `write` under 80 lines.
- Never create files with shell heredocs (`cat > file <<EOF`). Use `write`.

## Verify before answering

- After changing code, run the relevant command (test, `node file.js`, build) with `bash`.
- Only claim success after you have seen the command succeed. If you cannot run it, say so.
- If a tool call fails twice in a row, stop retrying the same call: re-read the error and change the approach.

## Answer format

- Report what you did and the verification result in a few lines.
- Do not paste whole files unless asked.

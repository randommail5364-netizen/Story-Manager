# Story Manager to-do list

Planned features, not built yet.

## Check summaries
Compare each reply summary with the actual reply from the chat.

- Catch wrong events or people, missing details, invented details, and missing or incomplete facts lists.
- Fix wrong summaries and their facts lists automatically from the reply.
- When a fixed summary was already merged into the story & characters, run the same correction step used for redone replies, and mark its chapter for a check.
- Show a short report, e.g. "Checked 30 summaries: 26 fine, 3 fixed (replies 41, 57, 88), 1 facts list added".
- Choices: **Check the latest 30** (default, about 10 requests) or **Check all** (about 75 requests for 224 replies at Maximum detail).
- Remember which summaries were checked, so the next run only does new ones.

## Check chapters
Compare each chapter with the reply summaries it was written from.

- Give each chapter a score (e.g. 8/10), with what is wrong, what is missing, and what is padding (repeated phrases or metaphors).
- List the results in the panel, with a **Rewrite** button on each flagged chapter that rewrites it from its summaries with the problems pointed out.
- About 1 request per 3–5 chapters.
- Limit: it checks against the summaries, not the full messages, so run **Check summaries** first.

## Order
Check summaries first, then Check chapters.

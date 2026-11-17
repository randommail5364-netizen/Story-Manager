# Story Manager to-do list

## Planned
- **Redesign: facts as records, entries built by Story Manager.** See
  [docs/REDESIGN.md](docs/REDESIGN.md). Not started. The version before it is
  saved as v3.21.0 (Git tag `v3.21.0-stable`, and
  `releases/story-manager-v3.21.0.user.js`).

## Open questions
- **The story AI repeats the latest scene.** Possible cause: the pinned
  message's Current Scene and Recent events describe a moment X replies old
  (X = Hold back) as "now". To test: untick Auto-manage, unpin the memory
  message, regenerate. Possible fixes: leave the newest X summaries out of
  Recent events; label both as "as of X replies ago".
- **Pinned message size** (about 500,000 characters after a rebuild with a
  detailed keeper). "Slim down" helps; a size limit for the pinned message is
  an option if needed.

## Done
- Check summaries and Check chapters (v3.15.0).
- Recover lost facts, Consolidate now, misplaced-fact moves (v3.16–v3.18).
- Compare bots (v3.19.0).
- Slim down (v3.21.0).

## Ideas, not decided
- "Older chapters: full / short" for a smaller pinned memory message (the full
  chapters would always be kept).

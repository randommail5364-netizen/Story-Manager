# Story Manager — working rules from the user

- **No arbitrary size limits on the pinned memory message.** Never add a character/token cap that cuts or shrinks it, and never send a smaller version than the full memory. Reduce size only by removing what is genuinely redundant or out of date (duplicates, finished goals, old states), never by a fixed limit.
- Explain and ask before building anything; bug fixes for reported breakage are fine.
- Fixes must work for any story, never just one (no story names or story-specific rules in the code; `test/neutral.test.js` checks this).
- Do not run the browser test suite (`test/e2e.test.js`); release after the unit, genre and real-story tests.
- Keep exported test stories (`test/data/`) out of git.

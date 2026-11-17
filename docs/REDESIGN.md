# Redesign plan: facts as records, entries built by Story Manager

Status: **built (v3.23.0)**; not yet tried on a real story. The last version
before this work is saved as `v3.21.0` (`releases/story-manager-v3.21.0.user.js`,
commit `d8ce60e`).

How it is built: each summary in `chat.log` carries its `records`; `buildEntries`
turns all records (plus `chat.manualRecords`, minus `chat.hiddenRecords` and
`chat.ignored`) into `chat.entries` on every save, so everything that reads
entries works unchanged. The AI's story update (`foldScene`) writes only the
story sections. Switching keeps the classic characters in `chat.classicEntries`
(used as a fallback until every older summary has records, and to switch back).

## Why

Today the memory keeper (an AI bot) **rewrites prose entries** again and again:
each update it reads a character's entry plus the new events and edits the
text. Every rewrite can:

- put a fact under the wrong person (Karina / Yujin / Winter mix-ups),
- keep an old version next to the new one (Park Ji-won as COO / CFO / PR head;
  Mango "pending" and "delivered"),
- leave its own working-out in the text,
- make entries grow without limit (Jacek reached 82,000 characters).

v3.11–v3.21 patched each of these. They all come from the same place: an AI
editing a large block of text over and over.

## The new design

### 1. The keeper only extracts facts, per reply
Each reply's summary comes with fact records instead of free text:

```
Karina | relationship: Winter | close; Winter helped her climax | R3
Park Ji-won | role | COO of SM | R80
Mango plushie | status | delivered to the penthouse | R140
```

Each record: **subject** (who or what) · **kind** (basics, appearance,
personality, ability, like/dislike/boundary, relationship: X, possession,
promise, secret (+ who knows), role, status, nickname, key moment) ·
**value** · **source reply**.

### 2. Story Manager builds the entries itself (code, not AI)
- Groups facts by subject and kind.
- For things that can change (role, status, relationship "where things stand",
  appearance that changed), **the newest fact wins**; older ones become
  history ("was CFO until reply 80").
- A line that is not a valid record is ignored, so the keeper's working-out
  cannot get in.
- Facts are never moved between people by rewriting, so they cannot end up
  under the wrong person.
- What goes into the pinned message is chosen by code (all current facts,
  the last N key moments per person), so size is under control; everything
  stays stored.
- Every fact points to its reply, so it can be checked against the real text
  and the user can see where it came from.

### 3. The AI keeps only the jobs it does well
- Summarising each reply (plus the fact records).
- Writing chapters.
- An occasional short "personality as it is now" paragraph per main character.

### 4. Pinned message layout
1. **Now**: Current Scene (where everyone is), Open Threads, upcoming events.
2. **Characters**: built from current facts.
3. **Turning points**.
4. **Chapters**.

## Stages (each tested before the next)

Done in v3.22.0–v3.23.0: all stages. Compare bots now runs in the facts
format (stage 1); new stories use the facts format (setting "Memory format for
new stories"); the classic-only tools are retired (Consolidate now, Slim down,
Recover lost facts, Write in full detail, Check for missing facts, automatic
consolidation); main characters get a "Who they are now" portrait; the pinned
message has the new layout (Must remember → Now → Characters, places & things →
World & turning points → History → Recent events). Tested: unit tests and the
full browser suite, with scenarios 51–52 for the facts format.
Not done (not needed for now): a limit on Key Moments per character in the
pinned message.


1. **Prototype / report only**: run the new extraction on the first 20 replies
   of a story and produce a report (like Compare bots) with the fact records
   and the entries built from them. Nothing in the real memory changes.
2. **Fact store**: storage and sync of fact records next to today's memory.
3. **Entry builder**: build entries from facts; panel shows facts by person,
   editable (edit / delete / mark as wrong).
4. **Switch the pipeline**: new replies produce facts; the pinned message is
   built from them.
5. **Migration**: "Rebuild from whole chat" into the new format.
6. **Clean up**: retire Consolidate now / MOVE / most cleaning rules that the
   new design no longer needs.

## Notes from testing (keeper bots)

- Best keepers in the comparisons (MiniApps): **smutty-fanfiction-writer** and
  **smut-writer-40**: no working-out, many facts. smut-fic-writer writes rich
  entries but rambles; er-8 is the weakest.
- Bots without their own model need MiniApps' default model
  (`/ai-models/defaults/by-tool/{id}`), or MiniApps answers "Validation failed".
- Terms of address ("unnie", "oppa", "maknae") are not names: never use them
  to identify a person.

# 📖 MiniApps Story Manager

Story Manager is an add-on for **[miniapps.ai](https://miniapps.ai)**. It runs in your phone's web browser and keeps a **story memory** for every chat automatically. The AI that writes your story keeps the important facts, such as names, relationships, items, injuries, plot threads and the current scene, even after the chat gets too long for it to read back.

You don't need to do anything once it's set up.

## What it does

1. **Watches your chats.** It reads the conversation the same way the miniapps.ai website does, using your normal login.
2. **Keeps the memory in three layers**, written by a "memory keeper" AI in three kinds of small jobs:
   - **Reply summaries** (every few AI replies, 3 by default). Each AI reply gets a detailed summary of what happened, plus a **Facts** line listing anything lasting it revealed or changed: names, nicknames, relationships, promises, secrets and who knows them, injuries, possessions. How long the summaries are depends on **Summary detail** in Settings: *Standard* 300–1,500 characters per reply, *Detailed* (the default) 700–3,000, *Maximum* 1,200–5,000. Every summary is kept.
   - **The story now and the entries** (every 9 replies by default). The summaries and their facts are folded into:
     - **the story now**: the current scene, open threads, and the world & timeline
     - **entries**: one for **each character**, including yours, with appearance, personality, how they talk, background, feelings, their relationship with every other character, condition, secrets, nicknames and more. Important **places, items, groups and lore** get entries too. Only entries that changed are rewritten.
   - **Chapters** (every 15 replies by default). A run of summaries becomes a short chapter of the story's history, so the big picture stays readable however long the story gets, while every detailed summary is still kept.
3. **Gives the AI what it needs.** Each time you send a message, the relevant parts are added in front of it, inside `[[STORY-MEMORY]] … [[/STORY-MEMORY]]` markers:
   - **always:** your pinned facts, the chapters (the newest in full, older ones by title once they no longer fit), and the story now
   - entries for everyone and everything **in the current scene** or the last few messages
   - entries **your message mentions**, by name or any nickname
   - the **reply summaries since the last chapter**, newest first, filling the space left (24,000 characters by default)

   A character who isn't involved right now doesn't take up space, but comes back the moment they're mentioned. The storyteller AI is told to use the notes silently.

### Tracking and control

Each chat has its own memory. A 📖 button floats over the site. Tap it to:

- see where each layer stands: how many replies are summarised, how many are waiting to go into the story & characters, and how many chapters there are
- watch the current job ("Summarising replies 41–45, step 3 of about 12") and **Stop** it; finished jobs are saved straight away, so **Update now** carries on where it stopped
- check the **Activity** list: every job, when it ran, how long it took, and any error
- see and edit the story now, every entry and every chapter (tick **Always send** to attach an entry with every message), or add your own entries
- add **📌 pinned facts** that are never changed automatically (e.g. "My character can't swim")
- pause the add-on for one chat
- **Update now**, **Undo last change**, **Redo story & characters from summaries** (rewrites the story, entries and chapters from the saved summaries without reading the chat again; much cheaper than a rebuild), or **Rebuild from whole chat**

In the reply log, ⏳ marks a summary that isn't in the story & characters yet, and 📚 shows which chapter it belongs to.

The first time you open an old chat, the add-on starts from the latest messages. Tap Update now or Rebuild to read the rest.

## Install on your phone

This is a *userscript*: a small add-on that a userscript manager runs on one website.

### Android

1. Install **Firefox** from the Play Store. Chrome on Android doesn't support add-ons.
2. In Firefox, open **⋮ → Add-ons**, find **Tampermonkey** or **Violentmonkey**, and add it.
3. Open the script file:
   `https://raw.githubusercontent.com/randommail5364-netizen/Story-Manager/claude/brave-mayer-u1eutx/story-manager.user.js`
   The manager offers to install it. Tap **Install**. Tampermonkey then checks this link for new versions by itself, so you never have to reinstall by hand.
4. Go to miniapps.ai in Firefox and log in. The 📖 button appears at the bottom right.

### iPhone / iPad

1. Install the free **Userscripts** app (by Justin Wasack) from the App Store.
2. Open **Settings → Safari → Extensions → Userscripts**, turn it on, and allow it on **miniapps.ai**.
3. In the Userscripts app, pick a folder to save scripts in. Then open the raw link above in Safari, tap the **Userscripts** (puzzle-piece) button, and install it. You can also save `story-manager.user.js` into that folder yourself.
4. Open miniapps.ai in Safari.

## Choose the memory keeper (📖 → Settings)

| Option | Cost | Notes |
| --- | --- | --- |
| **MiniApps bot** (default) | Uses your MiniApps credits | No key needed. Sends the summary job to a MiniApps chatbot (`claude-37` by default; change the slug to any bot you like). All updates go to **one helper chat** in your MiniApps history (it is replaced automatically if you delete it; a fresh one is started every 30 requests by default, adjustable in Settings, because a very long helper chat can make the bot stop answering). |
| **Google Gemini** | Free tier available | Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Default model `gemini-2.5-flash`. |
| **Anthropic Claude** | Paid API | Key from [console.anthropic.com](https://console.anthropic.com). Default model `claude-haiku-5-5`. |
| **OpenAI-compatible** | Varies | OpenAI, OpenRouter (has free models), Groq, DeepSeek… Set the base URL and model. |

Tap **Test connection** after choosing.

Some providers may refuse to summarize very mature stories. If you get "unusable answer" errors, try another provider or model.

Other settings:

- **Summarise new AI replies every … replies** (3), **Update the story & characters every … replies** (9) and **Chapter length** (15). Lower means fresher, at the cost of more requests.
- **Summary requests that may run at the same time** (1). 2 or 3 makes catching up faster, each in its own helper chat. Set it back to 1 if the bot starts failing.
- **Attach the memory every … messages.** `1` attaches it to every message, which is the most reliable. `0` turns attaching off.
- **Summary detail.** Standard, Detailed or Maximum: how long reply summaries and character entries are. More detail means more memory-keeper requests, because each one covers fewer replies. Existing summaries keep their length until you tap Rebuild.
- **Most characters attached to one message.** 24,000 by default.
- **Detailed reply summaries attached to each message.** Everything since the last chapter, and at least 15, as far as the space allows.
- **Backup.** Export and import all your chats' memories, e.g. to move to another device. Your API key is never included.

## Making sure nothing gets lost

- **Messages are read whole.** Long messages aren't trimmed before the memory keeper reads them.
- **Missing summaries are re-requested.** If the memory keeper skips a reply's summary, or its answer gets cut off, that reply is sent again (up to 3 times) until it has one.
- **History is never rewritten.** Past events live in the reply summaries and chapters, which are written once. The story & character updates only change the current situation and the entries, and only the parts that changed.
- **Facts are carried separately.** Each summary's Facts line is handed to the story & character update, so lasting facts reach the right entry.
- **Facts aren't dropped.** The memory keeper is told never to remove a fact unless the story changed it. If an update would make the memory much shorter, it's retried, and if it's still too short the previous memory is kept (the reply log is still updated).
- **Looping answers are cleaned up.** If the memory keeper gets stuck repeating the same text, the repeats are removed before anything is saved (and older saved memories are cleaned once). If the entries get very long, or the bot says a request is too long, only the entries the new messages involve are sent.
- **Each request is kept small.** A summary request covers at most 8 AI replies (5 on Detailed, 3 on Maximum), and the story & character update reads summaries instead of the whole chat, so no request has to carry everything.

## Good to know

- **The screen stays on while the memory is updated.** Updates with the MiniApps bot can take many minutes, and they stop if the phone locks or you switch away from the tab. Story Manager asks the browser to keep the screen on until the update is done (Diagnostics shows whether that worked). Keep the miniapps.ai tab open in front until it finishes.
- **You'll see the memory block in your own messages.** It's added to the text you send, so the chat shows it above what you typed. The add-on ignores these blocks when it updates the memory.
- **Your data stays on your phone.** Memories and settings are saved in your browser's userscript storage. The only places they're sent are miniapps.ai and the memory-keeper AI you choose.
- **MiniApps has no official API.** The add-on watches the same requests the website makes (`POST /chat`, `GET /conversations/{id}`, `GET /tools/s/{slug}`). These endpoints come from the reverse-engineered [MiniappsAI-API](https://github.com/cyber-wojtek/MiniappsAI-API) project. If MiniApps changes its website, the add-on may need an update. If the 📖 button shows a red dot, open it to see the error.

## Development

`test/e2e.test.js` loads the script into a simulated miniapps.ai page with a fake API and a fake memory-keeper AI. It checks the whole flow: building the memory automatically, attaching it to messages, pinned facts, the panel, the MiniApps-bot mode, and both the XHR and `fetch` request paths.

```sh
npm i -D playwright   # if not installed globally
node test/e2e.test.js
node test/recap.test.js
node test/entries.test.js
```

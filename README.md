# 📖 MiniApps Story Manager

Story Manager is an add-on for **[miniapps.ai](https://miniapps.ai)**. It runs in your phone's web browser and keeps a **story memory** for every chat automatically. The AI that writes your story keeps the important facts, such as names, relationships, items, injuries, plot threads and the current scene, even after the chat gets too long for it to read back.

You don't need to do anything once it's set up.

## What it does

1. **Watches your chats.** It reads the conversation the same way the miniapps.ai website does, using your normal login.
2. **Writes the memory.** Every few AI replies (3 by default), a "memory keeper" AI reads the new messages and updates three things:
   - **The story:** the big picture. It covers what has happened so far, the current scene (where, when, who's there), open plot threads, and world rules and timeline.
   - **Entries:** one for **each character**, including yours. Each covers appearance, personality, how they talk, background, feelings, their relationship with every other character, current condition, secrets, nicknames and more. Important **places, items, groups and lore** get entries too. The memory keeper only rewrites entries that changed, so the rest can't be damaged by an update.
   - **The reply log:** a summary of *every* AI reply, covering what happened, key dialogue, decisions, feelings and changes. How long they are depends on **Summary detail** in Settings: *Standard* 300–1,500 characters per reply, *Detailed* (the default) 700–3,000, *Maximum* 1,200–5,000, with longer replies getting longer summaries. Every entry is kept.
3. **Gives the AI what it needs.** Each time you send a message, the relevant parts are added in front of it, inside `[[STORY-MEMORY]] … [[/STORY-MEMORY]]` markers:
   - **always:** your pinned facts and the story
   - entries for everyone and everything **in the current scene** or the last few messages
   - entries **your message mentions**, by name or any nickname
   - the **newest reply summaries**, filling the space left (24,000 characters by default)

   A character who isn't involved right now doesn't take up space, but comes back the moment they're mentioned. The storyteller AI is told to use the notes silently.

Each chat has its own memory. A 📖 button floats over the site. Tap it to:

- see and edit the story and every entry (tick **Always send** to attach an entry with every message), or add your own entries
- add **📌 pinned facts** that are never changed automatically (e.g. "My character can't swim")
- pause the add-on for one chat
- **Update now**, **Rebuild from whole chat**, or **Undo last change**

The first time you open an old chat, the add-on reads its whole history once to build the memory.

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
| **MiniApps bot** (default) | Uses your MiniApps credits | No key needed. Sends the summary job to a MiniApps chatbot (`claude-37` by default; change the slug to any bot you like). All updates go to **one helper chat** in your MiniApps history (it is replaced automatically if you delete it; Settings can start a fresh one every N requests). |
| **Google Gemini** | Free tier available | Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Default model `gemini-2.5-flash`. |
| **Anthropic Claude** | Paid API | Key from [console.anthropic.com](https://console.anthropic.com). Default model `claude-haiku-5-5`. |
| **OpenAI-compatible** | Varies | OpenAI, OpenRouter (has free models), Groq, DeepSeek… Set the base URL and model. |

Tap **Test connection** after choosing.

Some providers may refuse to summarize very mature stories. If you get "unusable answer" errors, try another provider or model.

Other settings:

- **Update every … AI replies.** Lower means fresher memory but more summary calls.
- **Attach the memory every … messages.** `1` attaches it to every message, which is the most reliable. `0` turns attaching off.
- **Summary detail.** Standard, Detailed or Maximum: how long reply summaries and character entries are. More detail means more memory-keeper requests, because each one covers fewer replies. Existing summaries keep their length until you tap Rebuild.
- **Story entry size.** About 12,000 characters by default.
- **Most characters attached to one message.** 24,000 by default.
- **Detailed reply summaries attached to each message.** 15 by default, as far as the space allows. More helps the AI remember detail, but makes every message longer.
- **Backup.** Export and import all your chats' memories, e.g. to move to another device. Your API key is never included.

## Making sure nothing gets lost

- **Messages are read whole.** Long messages aren't trimmed before the memory keeper reads them.
- **Missing summaries are re-requested.** If the memory keeper skips a reply's summary, or its answer gets cut off, that reply is sent again (up to 3 times) until it has one.
- **Facts aren't dropped.** The memory keeper is told never to remove a fact unless the story changed it. If an update would make the memory much shorter, it's retried, and if it's still too short the previous memory is kept (the reply log is still updated).
- **Each request is kept small.** It covers at most 6 AI replies (4 on Detailed, 3 on Maximum), so the memory keeper's answer doesn't run out of room.

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

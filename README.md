# 📖 MiniApps Story Manager

Story Manager is an add-on for **[miniapps.ai](https://miniapps.ai)**. It runs in your phone's web browser and keeps a **story memory** for every chat automatically. The AI that writes your story keeps the important facts, such as names, relationships, items, injuries, plot threads and the current scene, even after the chat gets too long for it to read back.

You don't need to do anything once it's set up.

## What it does

1. **Watches your chats.** It reads the conversation the same way the miniapps.ai website does, using your normal login.
2. **Writes the memory.** Every few AI replies (3 by default), a "memory keeper" AI reads the new messages and updates a short summary of the story. The summary is split into sections: Characters, Relationships, World & Places, Items & Status, Story So Far, Current Scene and Open Threads.
3. **Gives the memory back to the AI.** Each time you send a message, the memory is added in front of it inside `[[STORY-MEMORY]] … [[/STORY-MEMORY]]` markers. The storyteller AI always gets the facts, and is told to use them silently.

Each chat has its own memory. A 📖 button floats over the site. Tap it to:

- see and edit the memory
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
   (after this branch is merged, use `main` instead of `claude/brave-mayer-u1eutx`). The manager offers to install it. Tap **Install**.
   - If the repository is private, the link won't work. Instead, open the manager's dashboard, choose **Create a new script**, and paste in the contents of `story-manager.user.js`.
4. Go to miniapps.ai in Firefox and log in. The 📖 button appears at the bottom right.

### iPhone / iPad

1. Install the free **Userscripts** app (by Justin Wasack) from the App Store.
2. Open **Settings → Safari → Extensions → Userscripts**, turn it on, and allow it on **miniapps.ai**.
3. In the Userscripts app, pick a folder to save scripts in. Then open the raw link above in Safari, tap the **Userscripts** (puzzle-piece) button, and install it. You can also save `story-manager.user.js` into that folder yourself.
4. Open miniapps.ai in Safari.

## Choose the memory keeper (📖 → Settings)

| Option | Cost | Notes |
| --- | --- | --- |
| **MiniApps bot** (default) | Uses your MiniApps credits | No key needed. Sends the summary job to a MiniApps chatbot (`claude-37` by default; change the slug to any bot you like). Each update creates a small extra chat in your MiniApps history. |
| **Google Gemini** | Free tier available | Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Default model `gemini-2.5-flash`. |
| **Anthropic Claude** | Paid API | Key from [console.anthropic.com](https://console.anthropic.com). Default model `claude-haiku-5-5`. |
| **OpenAI-compatible** | Varies | OpenAI, OpenRouter (has free models), Groq, DeepSeek… Set the base URL and model. |

Tap **Test connection** after choosing.

Some providers may refuse to summarize very mature stories. If you get "unusable answer" errors, try another provider or model.

Other settings:

- **Update every … AI replies.** Lower means fresher memory but more summary calls.
- **Attach the memory every … messages.** `1` attaches it to every message, which is the most reliable. `0` turns attaching off.
- **Maximum memory size.** About 3000 characters by default (~750 tokens).
- **Backup.** Export and import all your chats' memories, e.g. to move to another device. Your API key is never included.

## Good to know

- **You'll see the memory block in your own messages.** It's added to the text you send, so the chat shows it above what you typed. The add-on ignores these blocks when it updates the memory.
- **Your data stays on your phone.** Memories and settings are saved in your browser's userscript storage. The only places they're sent are miniapps.ai and the memory-keeper AI you choose.
- **MiniApps has no official API.** The add-on watches the same requests the website makes (`POST /chat`, `GET /conversations/{id}`, `GET /tools/s/{slug}`). These endpoints come from the reverse-engineered [MiniappsAI-API](https://github.com/cyber-wojtek/MiniappsAI-API) project. If MiniApps changes its website, the add-on may need an update. If the 📖 button shows a red dot, open it to see the error.

## Development

`test/e2e.test.js` loads the script into a simulated miniapps.ai page with a fake API and a fake memory-keeper AI. It checks the whole flow: building the memory automatically, attaching it to messages, pinned facts, the panel, the MiniApps-bot mode, and both the XHR and `fetch` request paths.

```sh
npm i -D playwright   # if not installed globally
node test/e2e.test.js
```

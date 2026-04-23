# 🔤 Word Grid Bot

A Discord bot that runs word search puzzles in your server. Find hidden words in a 9×9 grid, earn points, and climb the leaderboard!

---

## Features

- `/new` — Start a **Normal mode** puzzle (words hidden right, down, diagonal ↘)
- `/newhard` — Start a **Hard mode** puzzle (words in all 8 directions)
- **Answer detection** — Just type a word in the channel to submit it
- **Auto hints** — Given automatically after 10 minutes of no answers
- `/hint` — Request a hint manually
- `/leaderboard` — View server or global leaderboard
- `/score` — Check current game progress and scoreboard
- `/endgame` — End the current game early
- 📊 **Persistent leaderboard** saved to local JSON files

---

## Scoring

| Word Length | Points |
|-------------|--------|
| 3 letters   | 2 pts  |
| 4 letters   | 3 pts  |
| 5+ letters  | 5 pts  |

---

## Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- A Discord account and server

### 2. Create the Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → give it a name → **Create**
3. Go to **Bot** tab → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - ✅ **Message Content Intent**
   - ✅ **Server Members Intent** (optional but recommended)
5. Copy the **Bot Token** (you'll need this in a moment)
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Add Reactions`, `Read Message History`
7. Copy the generated URL and open it to invite the bot to your server

### 3. Install & Configure

```bash
# Install dependencies
npm install

# Copy the example env file
cp .env.example .env
```

Edit `.env` and fill in:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_client_id_here

# Optional: For faster command registration during development
# GUILD_ID=your_test_server_id_here
```

To find your **CLIENT_ID**: Discord Developer Portal → Your App → **General Information** → Application ID.

### 4. Register Slash Commands

```bash
npm run deploy
```

> If you set `GUILD_ID`, commands appear instantly.
> Without it, global commands can take up to 1 hour to appear in Discord.

### 5. Start the Bot

```bash
npm start
```

You should see:
```
✅ Logged in as WordGrid#1234
```

---

## File Structure

```
wordgrid-bot/
├── src/
│   ├── index.js           # Main bot entry point
│   ├── gameManager.js     # Game session logic
│   ├── gridGenerator.js   # Grid creation & rendering
│   ├── leaderboard.js     # Score tracking
│   ├── words.js           # Word lists (3/4/5 letter)
│   └── deploy-commands.js # Slash command registration
├── data/                  # Auto-created, stores leaderboards
│   ├── local_leaderboard.json
│   └── global_leaderboard.json
├── .env.example
├── package.json
└── README.md
```

---

## How to Play

1. Use `/new` or `/newhard` in any channel
2. A 9×9 grid appears — look for hidden words!
3. **Just type a word** in the channel — no prefix needed
4. Bot reacts with ✅ if correct, ignores wrong guesses silently
5. Found words get highlighted in periodic grid updates
6. Game ends when all words are found or after 30 minutes
7. If nobody answers for 10 minutes, a hint is automatically posted

---

## Tips

- Hard mode hides words backwards and diagonally in all 8 directions
- Use `/hint` if you're stuck — it shows the first letter and length
- Use `/score` to see what's been found and who's leading
- Leaderboard tracks both server-local and global totals

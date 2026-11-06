# Jeopardy Board

A browser-based Jeopardy game with a **host** side and a **contestant** side. It is a static site (no build step, no server), so it runs on **GitHub Pages**.

## Put it on GitHub

1. Create a new repository and upload `index.html`, `style.css`, `app.js` and `README.md`.
2. Go to **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, then save.
3. After a minute your game is live at `https://<your-username>.github.io/<repo-name>/`.

## How to play

**Host**
1. Open the site and click **Host a game**. Only one person should host.
2. Click **Copy page link for friends** and send it to them. There is no room code: everyone who opens the same link joins the same game.
3. Tick **Edit board** to rename categories, add/remove rows and categories, and click any tile to edit its value, question, answer and add images to the question and/or answer.
4. Click a tile to pick a clue. You see the question and the answer; contestants see nothing until you press:
   - **Show question** – reveals the question (and image) to contestants
   - **Open buzzers** – contestants can buzz in
   - **Reveal answer** – reveals the answer (and image) to contestants
5. The **Buzz order** panel shows who buzzed and in what order (the first un-judged buzzer is highlighted). ✓ adds points, ✗ subtracts them (amount is the "Points for ± buttons" box, which defaults to the clue's value).
6. **Reopen for others** keeps the judged players locked out and opens the buzzers again for everyone else.
7. **Done (mark used)** closes the clue and greys the tile out.
8. Add contestants yourself with the "Add contestant" box, or let them join. Scores can be changed with −/+ or typed directly.

**Contestant**
1. Open the link, enter your name, then click **Join game**.
2. Watch the board. When the buzzers open, press the big **BUZZ** button or the **Space bar**.

## Notes

- Live sync uses [PeerJS](https://peerjs.com/) (WebRTC) through its free public broker, so everyone needs an internet connection. The host must keep their tab open during the game.
- The game is saved automatically in the host's browser (board, images, scores). Use **Export / Import** to back up a board as a JSON file or move it to another computer.
- Images are automatically shrunk (max 700 px) so they sync quickly and fit in browser storage.
- Buzz order is decided by the order the host receives each buzz, so a contestant with a faster connection has a small advantage.

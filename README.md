# GitHub Copilot app flashcards

A zero-build static site: `index.html`, `styles.css`, `app.js`, `cards.json`. No frameworks or bundlers.

Six tabs (Starting a project, Planning, Modes, Pull requests, Automations, Customization). Click or press Enter/Space on a question to flip it; the answer and a docs link appear. The card resets to the question after 60 seconds.

## Run locally

`app.js` uses `fetch`, so serve the folder over HTTP (opening the file directly won't work):

```
python -m http.server 8000
```

Then open http://localhost:8000.

## Deploy to GitHub Pages

Repository **Settings > Pages**, choose **Deploy from a branch**, select `main` and `/ (root)`. The site is served from the repository's Pages URL.

## Editing cards

Edit `cards.json`: each topic has `id`, `title` and `cards` (`q`, `a`, `url`). Please verify each `url` against the current docs; the Copilot app pages in particular may have moved.

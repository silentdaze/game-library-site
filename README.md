# Game Library

A searchable catalogue of my game collection across every platform — 4,361 games,
one page, no backend.

**Live site:** https://silentdaze.github.io/game-library-site/

## What it does

- Search titles, alternate titles, developers, publishers, genres and series
- Search *inside* compilations — looking for "Golden Axe" finds the SEGA collections
  that contain it, and says so
- Filter by platform, store, store category and genre
- A completions view, sorted by when things were finished
- Every tag on a game page is a link that filters the library by it

## How it's built

Plain HTML, CSS and JavaScript. No framework, no build step, no backend, no tracking.
The page loads one JSON file and does all searching and filtering in the browser, which
is what makes it free to host. Rows render 60 at a time as you scroll.

| File | |
|---|---|
| `index.html` | the page |
| `styles.css` | one light theme |
| `app.js` | search, filtering, routing, rendering |
| `data/library.json` | the catalogue |

## Note

`data/library.json` is generated from a spreadsheet kept in a separate private
repository, which is the source of truth. Edits belong there, not here — anything
changed in this repo is overwritten on the next publish.

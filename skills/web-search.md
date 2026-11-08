---
name: Web access
description: Use when the task needs current web information, a specific page, a PDF, an image, a video, or a claim checked against sources.
---

# Web access

Four tools read the open web: `web_search`, `fetch_content`,
`get_search_content`, and `source_check`. Prefer them over guessing from memory
whenever the answer depends on something that may have changed.

## Choose the tool

- **`web_search`** — you do not know which page holds the answer.
  Send 2-4 queries that vary the angle, not 2-4 rewordings of one query; they run
  concurrently. Add `includeContent` only when you need the full text of the top
  results now; it waits for every page, so keep those searches small.
- **`fetch_content`** — you already have the URL (the user gave one, or a search
  returned one).
- **`get_search_content`** — you have a `responseId` from an earlier call.
- **`source_check`** — the task is verifying a claim and you want cited passages
  to review, rather than an answer.

## `fetch_content`

`url` for one page, `urls` for several. The result is stored and its
`responseId` comes back; use `get_search_content` with that id to page through
long content instead of fetching the page again.

Modes:

- `readable` (default) — markdown of the page.
- `raw` — the exact body over direct HTTP. Cannot be combined with `prompt`,
  `timestamp`, `frames`, `model`, `answerModel`, or `forceClone`.
- `answer` — answer `prompt` from the page and return the answer instead of the
  page. Costs a model call. `answerModel` picks the model; it defaults to the
  session model. Do not pass `model` with this mode.
- `extract` — pull `fields` out of each page. `fields` maps a name to a type:
  `text`, `number`, `date`, `time`, `datetime`, or `duration`. Use it when you
  need the same few facts from many pages. The page text goes to Cloudflare for
  this, so it stays off until it is ticked in the panel's allowed modes; a call
  that asks for it while it is off fails with
  `Fetch mode "extract" is disabled by fetch.allowedModes`.

Other parameters:

- `auth` — send browser cookies from a configured profile (`true` for the
  default). Refused with `answer` and `extract`, because authenticated page text
  must not reach a hosted model.
- `redirects: "same-origin"` — refuse a redirect that leaves the origin.
- `timestamp` / `frames` / `model` — video analysis. Only useful when a video
  model is configured; if it is not, fall back to the page text.
- `proxy` — per-call proxy. Omit to use the configured default; `""` forces a
  direct connection.

A direct image URL returns the image with its pixel size. An unsupported
container (SVG, BMP, ICO) fails with the content type instead.

## Reading a stored result

`get_search_content` needs the `responseId`, not the URL. Page with `offset` and
`limit`, or pass `findText` to jump to passages. Results outlive the call that
created them, so a `responseId` from earlier in the conversation still works.

## Reporting

Give the URL for every claim you take from a page, and say when a page could not
be fetched instead of filling the gap from memory.

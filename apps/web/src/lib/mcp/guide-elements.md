# Sleid elements: a short guide

Most slides need no raw elements. Use these first:
- `add_slide` with `components` builds a whole slide from components.
- `insert_component` adds one component to a slide.
- `insert_icon` adds a Lucide icon by name.

Use raw elements through `apply_ops` (`addElement`, `updateElement`) only for what components cannot do.

The canvas is 1920 × 1080 px. x and y are the top-left corner. Colours are hex strings (`#2d62c9`), and `rgba(…)` is allowed for shadows. Use the theme's colours (`get_deck_style`): an element whose colour equals a theme token follows the theme when it changes, and when the slide switches to `variant: "dark"`.

## Defaults you can leave out
`addElement` fills these in, so send only what differs:
- `id`: generated, returned in the op results
- `rotation`: 0
- `z`: on top
- `locked`: false
- `opacity`: 1
- text `style.align`: "left", and `style.valign`: "top"
- shape `stroke`: "transparent", and `strokeWidth`: 0
- image `fit`: "contain"
- chart `options`: `{ "legend": true }`

Text style keys you can also leave out:
- `fontFamily`: the theme body font, or the heading font when `role` is "title"
- `fontSize`: the theme body size
- `color`: the theme text colour
- `lineHeight`: normal
- `fontWeight`: 400

Set `style.autoFit` to fit text to its box:
- "shrink" lowers the font size until the text fits.
- "grow-box" makes the box as tall as the text.
- "none" leaves it.

## 1. Text with bold runs
Text content is a rich-text document. Paragraphs hold text runs, and a run can carry marks.

```json
{ "op": "addElement", "slideId": "S1", "element": {
  "type": "text", "x": 106, "y": 303, "w": 820, "h": 120, "role": "body",
  "style": { "fontSize": 34, "lineHeight": 1.35, "autoFit": "grow-box" },
  "content": { "type": "doc", "content": [
    { "type": "paragraph", "content": [
      { "type": "text", "text": "One login, " },
      { "type": "text", "text": "one permission model", "marks": [{ "type": "bold" }] },
      { "type": "text", "text": "." } ] },
    { "type": "bulletList", "content": [
      { "type": "listItem", "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Self-hosted" } ] } ] } ] } ] } } }
```

Other marks:
- `italic`, `underline` and `strike`
- `link`, with `attrs.href`
- `textStyle`, with `attrs` `color`, `fontSize` ("28px"), `fontWeight` (650) and `letterSpacing` ("0.14em")

For a label above a heading: `style` `{ "fontSize": 22, "fontWeight": 650, "letterSpacing": 0.14, "textTransform": "uppercase", "color": "#2d62c9" }`.

`update_text` accepts plain text instead: `- ` for bullets, `**bold**` and `*italic*`.

## 2. Card: roundRect with a shadow
```json
{ "op": "addElement", "slideId": "S1", "element": {
  "type": "shape", "shape": "roundRect", "x": 106, "y": 303, "w": 540, "h": 390,
  "fill": "#fdfdfc", "stroke": "#e6e4df", "strokeWidth": 1.2, "radius": 22,
  "shadow": { "x": 0, "y": 10, "blur": 29, "color": "rgba(40,38,30,0.05)" } } }
```

Shape options:
- `shape`: rect, roundRect, ellipse, triangle, arrow, line or star
- `radius`: px (rect and roundRect)
- `strokeDash`: solid, dashed or dotted
- `gradient` `{ "type": "linear", "angle": 135, "stops": [{ "color": "#2a4170", "at": 0 }, { "color": "#16223b", "at": 1 }] }` replaces `fill`
- `text`: rich text drawn inside the shape

Put the card first, then its contents. Lint treats elements inside a card as part of it.

## 3. Vector icon
Prefer `insert_icon` with a Lucide name, such as lock, link, eye-off, copy, key, check or x. The raw form:

```json
{ "op": "addElement", "slideId": "S1", "element": {
  "type": "vector", "x": 143, "y": 338, "w": 34, "h": 34,
  "viewBox": { "x": 0, "y": 0, "w": 24, "h": 24 }, "preserveAspectRatio": true,
  "paths": [ { "d": "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
    "fill": "transparent", "stroke": "#93661d", "strokeWidth": 2, "lineCap": "round", "lineJoin": "round" } ] } }
```

Rules for `d`:
- Path commands and numbers only (`MmLlHhVvCcSsQqTtAaZz`).
- Up to 200 paths.

For an icon tile, place a 62 px roundRect (radius 17) under the icon, filled with a light tint of the icon colour.

## 4. Image
Upload the file first:
1. `upload_asset` (base64, up to 5 MB). It returns `assetId`, with `width` and `height`.
2. Then either:
   - `insert_image` with `assetId`, which places the image in free space; or
   - `insert_component` `browser_frame` with `assetId`, which frames a screenshot; or
   - the raw element below.

```json
{ "op": "addElement", "slideId": "S1", "element": {
  "type": "image", "x": 960, "y": 303, "w": 854, "h": 534, "src": "/api/assets/<assetId>",
  "fit": "cover", "radius": 14, "alt": "The board view with three columns",
  "shadow": { "x": 0, "y": 18, "blur": 48, "color": "rgba(20,24,40,0.14)" } } }
```

- `alt` is required for lint to pass.
- `crop` `{ x, y, w, h }` takes fractions from 0 to 1.
- An `src` must be one of these deck's assets. `insert_image` copies an asset from your library, or from another deck you can read, into this deck, so exports include it.

## Slides
- `updateSlide` `{ "variant": "dark" }` gives a slide the theme's dark background and recolours its text, muted and accent colours. "light" switches it back.
- `background` `{ "type": "color" | "gradient" | "image", "value": "…" }` sets a background by hand.

## Check your work
- `lint_deck` reports overflow, overlap, off-slide elements, low contrast and missing alt text, each with its slideId and elementId.
- `render_deck` returns one contact sheet of every slide.

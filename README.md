# RESSLab — Virtual experiments

Static website (HTML / CSS / vanilla JavaScript, no build step) presenting the
virtual 360° visits of the Resilient Steel Structures Laboratory (RESSLab, EPFL).

Visual identity inspired by <https://www.epfl.ch/labs/resslab/>.

## Structure

```
index.html                 catalogue of experiences (grid of cards)
js/experiences.js          LIST OF EXPERIENCES — edit this to add one
js/site.js                 shared header / breadcrumb / footer + catalogue rendering
js/tour.js, css/tour.css   360° viewer (shared by all experiences)
css/style.css              site styles
assets/                    logos, card preview images (assets/images/)
experiences/panel-zone/    one folder per experience (index.html; photos are hosted on the EPFL CDN)
```

## Add an experience

1. Copy `experiences/panel-zone/` to `experiences/<new-name>/` and edit the block between
   `TOUR-START` / `TOUR-END` in its `index.html`.
   Photos (equirectangular 2:1, WebP or JPEG, ~8192×4096 px) are fetched from `SETTINGS.photosBase`
   — currently the EPFL CDN `https://enacit4r-cdn.epfl.ch/resslab/virtual_tour/photos/`
   (CORS must allow GET from any origin). Use `photosBase: "photos/"` to serve them from a folder instead.
   Tip: set `editing: "hash"` and open the page with `#edit` at the end of the address to place the
   points visually, then paste the generated block back.
2. Add one object in `js/experiences.js` (title, category, description, image, url).
   Use `url: null` for a "Coming soon" card. Put the card image in `assets/images/`.

## Publish with GitHub Pages

Repository → Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.
The site is then served at `https://<organisation>.github.io/<repository>/`.

Local test (the site must be served over http, not opened by double-click):

```
python -m http.server 8000      # then open http://localhost:8000
```

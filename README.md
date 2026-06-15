# Better Rhythia Downloader

Chrome Manifest V3 extension that adds direct download buttons to Rhythia map cards on `https://www.rhythia.com/maps`.

The extension reads Rhythia's public map listing API for the current maps page, matches returned map IDs to visible cards, and adds a download button under the existing preview button. Clicking the button opens the same `.sspm` file URL used by Rhythia's map detail pages.

See [PRIVACY.md](./PRIVACY.md) for the privacy policy.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Visit a Rhythia maps listing page and dismiss any site modal if it is covering the page.

The button is added below the existing preview button on each map card. Clicking it opens the same `.sspm` file URL exposed by Rhythia's map listing API, matching the behavior of Rhythia's map detail pages.

## Development

The extension itself has no build step. After editing files, reload the unpacked extension in `chrome://extensions`, or run:

```sh
npm run reload:extension
```

That helper requires Chrome to already be running with `--remote-debugging-port=9222`.

To run a live smoke check against Rhythia, run:

```sh
npm run check:downloads
```

That helper launches Chrome, injects the local content script, compares the first injected card download URL with the native download URL on that map's detail page, and does not save downloaded files.

To regenerate the Chrome Web Store listing images, run:

```sh
npm run capture:store-screenshots
npm run render:store-assets
```

The capture command uses local headless Chrome to take before/after screenshots from Rhythia. The render command turns those captures into the final listing images in `store-assets/`.

To build the Chrome Web Store upload package, run:

```sh
npm run build:zip
```

This writes `dist/better-rhythia-downloader-1.0.0.zip` with only the runtime extension files.

## Files

- `manifest.json`: Chrome extension manifest.
- `icons/`: Extension icon source and generated PNG assets.
- `src/content.js`: Map API loading and card button injection.
- `src/content.css`: Download button styling that mirrors Rhythia's card controls.
- `scripts/build-extension-zip.js`: Chrome Web Store ZIP builder.
- `scripts/capture-rhythia-screenshots.js`: Live Rhythia screenshot capture for store images.
- `scripts/check-download-parity.js`: Optional live smoke check for card/detail download URL parity.
- `scripts/render-store-assets.js`: Local Chrome renderer for Web Store listing images.
- `scripts/reload-extension.js`: Chrome DevTools Protocol helper for reloading the unpacked extension.
- `store-assets/`: Editable listing pages and generated Chrome Web Store images.

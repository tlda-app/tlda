# Claude-TLDraw PDF Annotator - Status

## What Works

### On iPad (http://10.0.0.18:5173/)
- Blank canvas mode: `http://10.0.0.18:5173/`
- SVG document mode: `http://10.0.0.18:5173/?doc=bregman`
- Load PDF button (top right) for arbitrary PDFs
- **Share button** - sends annotations to Claude

### On Claude's side
- Receive snapshots via `server.mjs` (port 5174)
- View annotations with `node view-snapshot.mjs`
- Screenshot saved to `/tmp/annotated-view.png`

## Current Architecture

```
iPad Browser
     |
     | (draw annotations)
     v
TLDraw Canvas ──[Share]──> POST /snapshot ──> /tmp/tldraw-snapshot.json
                                                      |
                                                      v
                                            node view-snapshot.mjs
                                                      |
                                                      v
                                            /tmp/annotated-view.png
```

## Running the Services

1. **Dev server** (serves the app):
   ```bash
   cd ~/work/tlda && npm run dev
   ```

2. **Snapshot server** (receives shares):
   ```bash
   cd ~/work/tlda && node server.mjs
   ```

3. **View a snapshot**:
   ```bash
   cd ~/work/tlda && node view-snapshot.mjs
   ```

## SVG Documents

The bregman paper is pre-compiled to SVG in `/public/docs/`. To add more:

1. Compile TeX to DVI: `latex paper.tex`
2. Convert to SVG: `dvisvgm --page=1-N --font-format=woff2 --exact-bbox --output=svg/page-%p.svg paper.dvi`
3. Copy to `public/docs/`
4. Add entry in `src/App.tsx` DOCUMENTS config

## Known Issues

- Sync disabled (TLDraw demo server had SSL issues)
- Font rendering has minor artifacts from dvisvgm
- No real-time collaboration (share is manual)

## TODO

- [ ] Fix font rendering (try `--font-format=svg` or `--no-fonts`)
- [ ] Add page navigation/thumbnails
- [ ] Auto-refresh viewer when new snapshot arrives
- [ ] Better annotation detection (text, arrows, etc.)

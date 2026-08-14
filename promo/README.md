# Codeep promo pack

Publish-ready, silent H.264 exports built from the final audited product surfaces.

- `exports/codeep-promo-web-1920x1080.mp4` — website hero/showcase.
- `exports/codeep-promo-social-1080x1350.mp4` — LinkedIn, X, Instagram feed.
- `exports/codeep-promo-reel-1080x1920.mp4` — Reels, Stories, Shorts and TikTok.
- Matching PNG posters are provided for every video.
- `manifest.json` records exact copy, dimensions, checksums and source provenance.
- `sources/` contains the publish-safe product captures used by the generator.

All formats are 9.10 seconds at 24 fps, H.264, silent, and use only real audited Codeep screenshots. Rebuild deterministically with:

```sh
swift promo/prepare-sources.swift
swift promo/generate-promo.swift
```

`prepare-sources.swift` only crops the outer black capture margin — it does **not**
redact anything. The macOS capture keeps its full window, sidebar included, so the
PROJECTS list and its filesystem paths end up in the public image. Before exporting,
check the capture yourself and make sure the sidebar holds nothing you would not
publish (client project names, directory paths, unreleased work).

# Atlas hero — 3D titan

A self-contained WebGL hero: the Atlas titan holding a carved celestial globe,
orbitable, with a camera that descends from the full figure onto the globe
surface. Built as a published Artifact; `atlas-hero.html` is the whole page.

```bash
./build.sh          # → atlas-hero.html
```

## Files

| Path | What |
|---|---|
| `src/template.html` | The page — markup, tokens, scene, camera, lighting lab. **Edit this.** |
| `src/atlas-geo.glb` | Geometry only, 281 KB. Textures deliberately stripped out (see below). |
| `src/tex_*.webp` | The four surface maps. Globe 2k, titan 1k. |
| `src/entry.js` + `src/package.json` | Bundle entry; pins `three`. |
| `inline.ts` | Substitutes bundle + assets into the template. |
| `atlas-hero.html` | Build output — gitignored. Run `build.sh`; do not hand-edit. |

## The source model is NOT in this repo, on purpose

The mesh is **"Atlas statue" by SpatialNeglect**, bought on Fab (Epic) under the
**Standard Licence, Personal tier** — that tier is a threshold (under $100k
revenue or funding in the trailing 12 months), not a non-commercial restriction,
so shipping it in a product page is within licence.

| | |
|---|---|
| Buy / re-download | <https://www.fab.com/listings/2198e435-9526-485a-a521-4b7e619c5b51> |
| Original listing | <https://sketchfab.com/3d-models/atlas-738f84702bc14d8cbb165632bb704582> |
| Licence | Fab Standard Licence, Personal tier. Flagged NoAI — render it, don't feed it to a generative 3D tool. |

Purchases stay in the Fab Library indefinitely, so the original is
re-downloadable; the account and order details are deliberately not recorded
here, since this repo is public. Sketchfab's store is retired and now only links
out to Fab.

You need the original **only** to redo the optimisation — a different texture
resolution, re-extracting maps, or the Marble&Gold / Oxidized Bronze variants,
which ship in `atlasblend.zip` and were never pulled. Rebuilding the page needs
nothing beyond what is committed here.

Redistributing the *source asset* is not. This repo is **public and AGPL-3.0**,
and AGPL would purport to grant everyone downstream rights we do not hold for
that model. So the original 76 MB `.glb` stays out (`.gitignore` covers it), and
what is committed here is a derived, optimised form embedded in a rendered page
— ordinary end-product use.

If the Personal threshold is ever crossed, the licence needs upgrading on Fab.

## Three things that will bite you

**1. The purchased `metallicRoughness` map is corrupt.** Fab's FBX→glTF
conversion emitted a diagonal halftone dither in green/orange/magenta instead of
an ORM map. glTF reads G as roughness and B as metalness, so it made both values
strobe across every surface and put heavy banding over the whole statue. It is
stripped; metalness/roughness are uniform values set in the page. Do not try to
re-import it.

**2. Nothing may fetch at runtime.** The Artifact CSP blocks external scripts and
assets, so `three` is inlined and the mesh and textures are embedded as base64.

**3. Textures are loaded by hand, and must stay that way.** three's `GLTFLoader`
unpacks GLB-embedded images by minting `blob:` URLs, and its WebP support probe
loads a `data:` URI through an `<img>`. Both go through the CSP and **fail
silently** — the mesh arrives, every map is missing, the material falls back to
white, and at metalness 1 it renders as a blank mirror ball that reads as a
lighting bug. That is why textures live outside the GLB and are decoded with
`createImageBitmap` straight from a `Blob`, with no URL of any kind. The page
reports how many maps failed rather than rendering silently wrong.

## Colour

Tokens mirror the repo's `brand.css` per
[ADR-0023](../../docs/adr/0023-brand-color-system.md): forest is the brand, teal
is a spark and never a primary. The ground is `--code-bg` — Atlas sanctions
exactly one always-dark surface, so a dark hero belongs on that one.

Forest `#1F5C45` is too dark to read inside a recess, so the patina uses
`#389C6A` — the forest-lightened-for-dark-surfaces of ADR-0023 §4. Patina is not
a flat tint: it is masked by the albedo's own luminance, which stands in for
cavity, so green settles where it would on a real bronze and the proud surfaces
stay metal.

## Known limits

- **The globe is 510 vertices.** All its relief is normal map. It reads well at
  distance but goes visibly faceted at the silhouette up close, so the camera
  dolly stops at 2.15× sphere radius. Going nearer needs a subdivided sphere.
- **Verified on Chromium only.** No WebKit build is available in the container
  this was developed in; Safari has not been checked directly.

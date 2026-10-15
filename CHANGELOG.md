# Changelog

## Unreleased

- Editor: **New scene** in the File menu, as `Shift+N` and at the top of the gallery: an empty stage or a photo studio (podium, softboxes, key/rim/fill light); undoable
- **Physically based materials**: `metalness`, `roughness`, Fresnel (split-sum environment BRDF fit), reflections of a `sky` or `studio` environment with softboxes; rough reflections are softened analytically and refined progressively
- **Textures**: `material.texture` takes a PNG from the project or a `data:` URL, projected along the thinnest axis; built-in PNG decoder for Node, browser decoding in the editor
- **Studio lighting**: main light `intensity` and `softness` (soft shadows), up to 4 extra lights (fill, rim)
- Emissive colors are reproduced exactly on screen (inverse tone curve) and emitters no longer pick up diffuse light
- Sharper highlights: the specular approximation no longer has a long tail (fixes a haze on glossy surfaces) and is cheaper
- `roundedRect` / `roundedBox` get `smooth: true` for squircle corners
- Smartphone scene rebuilt: real proportions, polished metal frames, glass, a painted home-screen texture, antenna bands, USB-C, speaker holes, stepped camera lenses
- Gallery reworked with the new materials and light: studio-lit showcase (gold, chrome, lacquer), castle in late afternoon sun, chess in a studio with rim light, glowing station lights, a golden-hour city with glass towers and warning lights, a bioluminescent alien garden, and the lighthouse at sunset over a reflective sea
- Studio environment gets a light grey floor reflection, so metals stay readable
- Shadow bias scales with softness and surface slope (no acne on soft shadows)
- Editor sliders for metalness and roughness
- New gallery scene **Smartphone**: a product shot with two phones, a glowing home screen and a triple camera module
- New recipe `roundedBox` (box with rounded edges and corners) and 2D shape `roundedRect`
- New material property `emissive` for self-illuminated surfaces (screens, lamps, windows); the lighthouse lantern now glows
- **High quality renderer** (now the default): deferred per-pixel lighting in linear color space, ACES filmic tone mapping, directional shadow map with soft PCF edges (cached per scene), screen-space ambient occlusion at half resolution with a depth-aware blur, and progressive anti-aliasing by averaging jittered frames. `quality: 'fast'` keeps the per-vertex path, which also gets tone mapping.
- Editor: quality selector, image refines to 16 samples while the view is still; shadows follow objects while dragging
- `render_view` and `cpu3d render` return 8 / 16-sample high-quality images (`--quality`, `--samples`)
- Editor: move the selected object by dragging it with the mouse (ground plane, Alt for height, Shift to snap to 0.25 m, Esc cancels); committed as one undoable `update_object`

## 0.1.0 (2026-10-15)

First public release.

- Software rasterizer: half-space edge functions, top-left rule, analytic spans, homogeneous clipping with guard band, 1/w depth, flat / Gouraud / normal shading, wireframe
- Geometry builder: rims, lathe, sweep with parallel-transport frames, extrude with ear clipping, tube, terrain, parametric, OBJ import/export
- JSON shape recipes with validation and an agent-facing reference
- Tool API (15 tools) shared by agents and the editor, including `render_view` (PNG) and `probe_height`
- MCP server over Streamable HTTP and stdio, REST API with OpenAI function schemas
- Editor: live sync, activity feed, follow-agent camera, outliner, inspector, gallery, size readouts, undo/redo, local mode
- Seven gallery scenes built through the tool API

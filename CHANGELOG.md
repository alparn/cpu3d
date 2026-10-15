# Changelog

## Unreleased

- **Effects toggle**: objects can be marked `"effect": true` (airflow, rain, fireworks); the editor's **Effects** button (or `E`) shows or hides all of them, remembered per browser; `render_view` and GIF export take `effects: false`. The turbofan airflow, the neon rain and the fairground fireworks are marked
- Turbofan airflow redone as a wind-tunnel style flow field: an even field of faint streamlines in staggered rings with long, softly tapered glows flowing along every line at one speed (two per line, overlapping without gaps, so the threads brighten in waves instead of showing dashes), swirling behind the fan and leaving the core as a hot jet; replaces the short streaks that looked like rain
- New gallery scene **Neon district**: a rainy cyberpunk street at night with towers wearing procedurally painted window textures, flickering neon signs with glyphs and their reflections smeared on the wet asphalt, rain as a raw mesh of streaks, flying cars in traffic lanes, an elevated train, swinging lanterns, cables and a rotating hologram in the haze; the build script paints all its textures
- New gallery scene **Plush dancer**: a fluffy character (round fluffy bottom and a little tail included) with headphones dancing on a light-up floor, with a disco ball, pumping speakers and a neon backdrop; a small skeleton baked into keyframes for every part
- Recipes: **`noise`** on any shape displaces the surface along its normals by fractal noise (fur, plush, rocks, bark), deterministic and seamless (normals of coincident vertices are welded)
- New gallery scene **Fairground at dusk** (339 objects, 98k triangles, everything animated): a Ferris wheel with upright gondolas (orbit plus counter-spin), a carousel with galloping horses, a wave swinger, a roller coaster train on spline keyframes timed by energy conservation, keyframed fireworks, drifting balloons, chasing light bulbs and a camera flight
- Shadows in motion: the soft-shadow jitter moved every shadow edge in the image at once each frame; it is now random per pixel (fine noise that temporal AA averages away). Shadow map origins snap to whole texels (no swimming when the framing moves) and the map size changes only when it has to (no popping along camera paths)
- Detail shadow cascade around the view center for scenes with fairly hard light; soft light keeps one map (its penumbra hides the extra resolution)
- Temporal AA trusts the history a bit more during slow motion: about 20% less flicker on the watch's camera move
- Fix: temporal AA wrote its result into the buffer it reads the 3x3 neighbourhood from, so neighbours were already blended (ghost trails behind moving objects, row stripes with several threads); the result now goes to a separate buffer
- Temporal AA: disocclusion detection with stable mesh ids (uncovered background starts over instead of keeping a ghost), variance clipping in YCoCg towards the mean (no coloured fringes on textures such as the phone's app icons), bicubic overshoot clamped, fast path for still pixels, neighbourhood statistics as sliding sums
- Fix: animation playback advanced unevenly (time was lost while a frame was still rendering), which looked like jitter; time now follows the wall clock between rendered frames
- Temporal AA: per-object motion vectors (moving parts keep their history), a per-pixel running average for pixels that stay put (static parts of an animated scene flicker 30-75% less), wider clipping for still pixels
- Editor: timeline above the stats line on medium-width windows
- **Multi-threaded shading**: a worker pool (`ShadePool`, Web Workers in the browser, worker_threads in Node) shades the frame in row chunks over shared memory; pixel-identical to one thread. `Renderer#setPool` and `renderAsync`; the editor, `render_view`, `render_animation`, `export_gif` and `cpu3d gif` use it. Turbofan in the editor: ~110 ms → 24 ms per moving frame
- **Temporal anti-aliasing** for camera moves and animation (`render(..., { temporal: true })`): jittered frames, reprojection with motion vectors, Catmull-Rom history sampling, variance clipping, speed-dependent blending; still images continue the progressive refinement from the temporal history
- **Adaptive resolution** in the editor: motion renders at a reduced resolution when a full frame would miss ~30 fps
- **Shadow cache** split into static and moving casters, shared between renderers; playback no longer redraws the whole shadow map every frame
- Cross-origin isolation headers from the cpu3d server, and `coi-sw.js` for static hosts like GitHub Pages
- New behaviour **`flow`**: moves along an axis and starts over, growing in and shrinking out at the ends (wind, particles, exhaust, conveyor belts)
- Turbofan gallery scene: airflow streaks pulled into the intake, a swirling bypass stream and a hot exhaust jet
- **Keyframes**: `animation.keys` with `position`, `rotation`, `scale` and `emissive` channels and `ease` smooth / linear / spline (Catmull-Rom through all keys) / step; behaviours apply on top
- **Camera paths**: `animation.camera` with yaw / pitch / distance / target keys; the editor follows the path while playing, `render_view(time)` and exports use it
- **GIF export**: dependency-free encoder (median-cut palette shared by the clip, ordered dithering, delta frames cropped to the changed area, LZW); frames are rendered with motion blur. In the editor (File → Export animated GIF), as `cpu3d gif` and as the `export_gif` tool
- New tools `set_keyframe` (add, merge or delete single keys of objects or the camera) and `render_animation` (contact sheet of several frames for agents); `set_animation` takes `camera`
- Editor: `◆` / `K` records keys, transform edits and mouse moves of keyed objects set keys at the current time, key diamonds on the timeline, camera path toggle, timeline usable on phones
- Gallery: camera moves for the watch, turbofan, station and city; a blimp flies a keyframed spline loop around the city
- Behaviours with a phase are now also applied at t = 0 (no jump when the timeline loops)
- **Animation**: declarative behaviours per object (`spin` with optional ticking `step`, `swing`, `bob`, `orbit`, `pulse` for glow, each with an optional `pivot`), evaluated per frame without rebuilding geometry; scene `animation.duration` sets the looping timeline
- New tool `set_animation`; `render_view` and `cpu3d render` take `time`
- Editor: timeline with play/pause and scrubbing (`Space`), animated scenes play automatically, animation presets and JSON in the inspector
- All gallery scenes are animated: ticking watch with swinging balance wheel, spinning turbofan, rotating station, turntable phones, blinking beacons, swaying tentacles, a pulsing lighthouse lantern and a rocking boat
- New recipe `radial`: repeats any shape around an axis (blade rings, spokes, colonnades); hundreds of copies stay one small object
- `lathe` takes `phiStart` / `phiLength` for cutaway models; closed profiles get capped cut faces
- New gallery scene **Turbofan cutaway**: 22 twisted fan blades, booster and HP compressor stages, a glowing combustor and heat-tinted turbines from NACA-profiled radial arrays; 47 KB of JSON, 112k triangles
- `extrude` takes `holes` (rings, frames, gears with spokes, letters); holes are bridged into the outline so ear clipping handles them, and side walls face into the holes
- New gallery scene **Skeleton watch**: 170 parts with spoked brass gears, a hairspring, ruby jewels in polished chatons, blued screws, luminous hands at 10:10 and a stitched leather strap
- Studio environment: an extra high back softbox, so flat metal parts seen from above have something bright to reflect
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

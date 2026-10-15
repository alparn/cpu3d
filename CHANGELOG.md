# Changelog

## Unreleased

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

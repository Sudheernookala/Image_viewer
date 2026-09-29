# CAD 3D Viewer

A fast, browser-based viewer for CAD and 3D files: **STEP, IGES, STL, OBJ, glTF/GLB, FBX, 3MF** and more.
Built with **React + TypeScript + Three.js**, with **OpenCascade (WebAssembly)** for real CAD formats and a small **Node + SQLite** server as the model database.

A sample car (46 named, coloured parts: body, hood, cabin, glass, seats, steering wheel, engine, wheels…) is included in `samples/` and is loaded into the database on first start.

## Quick start

Requires Node.js 22.13 or newer.

```bash
npm install        # installs root + client
npm run dev        # API on :3001, app on http://localhost:5173
```

Open http://localhost:5173 → **Library** tab → click `sample_car.step`.

Production (one process, serves the app and the API on :3001):

```bash
npm run build && npm start
```

## Features

| Area | What you get |
|---|---|
| Open files | Drag & drop files **or whole folders**, file picker, `?url=https://…/part.step`, server database, recent files (browser IndexedDB) |
| Multiple files | Drop several files at once (e.g. many car parts) — they load into one scene. **Add** (or Shift+drop) adds to the scene. OBJ+MTL+textures and glTF+bin are matched automatically |
| Navigation | Rotate, pan, zoom **towards the cursor** (lets you go inside), double-click to set the rotation centre, standard views (front/back/left/right/top/bottom/iso), fit, perspective/orthographic, Z-up / Y-up |
| Inside view | Zoom-to-cursor, **fly mode** (W/A/S/D, Q/E, Shift), **section planes** on X/Y/Z with flip (cut faces tinted orange), **x-ray** mode, hide/isolate parts |
| Display | Shaded, shaded + edges, wireframe, x-ray, grid, axis gizmo |
| Parts | Model tree with search, show/hide, isolate, zoom-to; click a part in 3D to select it and see name, size, triangles, colour |
| Explode | Slider pushes parts away from the centre |
| Measure | Point-to-point distance with corner snapping, ΔX/ΔY/ΔZ, in mm for CAD files |
| Sketch | 2D markup over the view: pen, line, arrow, rectangle, ellipse, text, colours, undo |
| Export | Screenshot PNG (includes markup) |
| Database | Server stores files on disk + metadata in SQLite; list, search, open, upload (“Save to DB”), delete |

Press **?** in the app for all shortcuts.

## Supported formats

| Format | Engine | Notes |
|---|---|---|
| STEP (.step/.stp), IGES (.iges/.igs), BREP | OpenCascade WASM in a Web Worker | Assembly tree, part names and colours (STEP). Mesh quality selectable: draft / normal / fine |
| STL, PLY | Three.js loader in a Web Worker | Binary and ASCII |
| OBJ (+MTL), glTF/GLB (Draco, Meshopt), FBX, 3MF, AMF, COLLADA, 3DS, VRML, VTK, PCD, XYZ, LWO, USDZ, OFF | Three.js loaders | |

**Not supported:** native files of commercial CAD tools (CATIA `.CATPart`, SolidWorks `.SLDPRT`, NX/Creo `.prt`, Inventor `.ipt`). Their formats are closed; reading them needs a paid SDK (e.g. HOOPS Exchange, CAD Exchanger). Export to STEP from those tools instead.

## How it stays fast

- CAD parsing runs in a **Web Worker**; the UI never freezes. The WASM kernel is pre-loaded at startup.
- Mesh data is sent from workers as **transferable typed arrays** (no copying).
- **Render on demand**: the GPU is idle when nothing moves.
- **BVH picking** (three-mesh-bvh): clicking a 2M-triangle model takes ~3 ms.
- Shared materials per colour, edges computed only when needed, in small time slices.
- Lower pixel ratio while orbiting very large models; full quality when you stop.
- Loaders for rare formats are **lazy-loaded** (only downloaded when used).

Measured in a headless test (CPU side): 100 MB / 2M-triangle STL parsed in 0.6 s; the sample STEP car tessellated in ~3.5 s.

## Project layout

```
client/            React + Vite app
  src/viewer/      Viewer.ts: Three.js scene, camera, tools (section, explode, measure, fly)
  src/loaders/     format detection, loaders, workers
  src/components/  toolbar panels, model tree, library, sketch overlay
  public/occt/     OpenCascade worker (WASM copied from node_modules at build)
server/index.mjs   REST API + SQLite (node:sqlite) + static hosting
samples/           generated STEP / IGES / STL car and car parts
scripts/generate_car.py   builds the sample car with OpenCascade (pip install cadquery-ocp)
```

## API

| Method | Path | |
|---|---|---|
| GET | `/api/models?q=` | list / search |
| GET | `/api/models/:id/file` | download |
| POST | `/api/models?name=&category=&description=` | upload (raw body) |
| DELETE | `/api/models/:id` | delete |

Env vars: `PORT` (3001), `DATA_DIR` (server/data), `MAX_UPLOAD_MB` (1024).

# Integration guide

The viewer is built to live **inside other tools**: PLM, ERP/MES, document management, service portals, your own Angular/React apps.
There are four ways to integrate it. Pick the one that fits the host tool.

| Method | Use it when | Host needs |
|---|---|---|
| **1. Link / URL** | You only need an "Open in 3D" button | Nothing: just a URL |
| **2. iframe + postMessage** | The host is a closed product (PLM portal, SharePoint, Confluence) or you want full isolation | Can show a web page; optional small JS for two-way control |
| **3. `<cad-viewer>` web component** | You own the host web app (Angular, React, Vue, plain HTML) | One `<script>` tag |
| **4. JavaScript API (`mountViewer`)** | You want no built-in UI and full control from your own code | One ES module import |

On the data side, **connectors** let the viewer read files from your PLM or DMS, so no one has to copy files around.

Live examples: run the server and open `http://localhost:3001/examples/`.

---

## 1. Link / URL

```
https://viewer.example.com/?source=plm&id=PRT-1001              full app
https://viewer.example.com/embed.html?source=plm&id=PRT-1001    embeddable, compact UI
https://viewer.example.com/embed.html?url=https://files.example.com/x.step&ui=minimal
```

| Param | Meaning |
|---|---|
| `source` + `id` | Open item `id` through connector `source` (see Connectors) |
| `url` (or `src`), `name` | Open a file from a URL. `name` gives the file name when the URL has none |
| `ui` | `full`, `compact` (default in embed), `minimal`, `none` |
| `title` | Title shown in the toolbar |
| `auth=host` | Wait for the host to send auth headers over postMessage before loading |

Never put tokens in URLs: they end up in logs and browser history. Use `auth=host` plus `setHeaders` (below), or a connector.

## 2. iframe + postMessage

```html
<iframe id="v" src="https://viewer.example.com/embed.html?ui=compact" style="width:100%;height:600px;border:0"></iframe>
<script src="https://viewer.example.com/sdk/cad-viewer-host.js"></script>
<script>
  const viewer = new CadViewerFrame(document.getElementById('v'))
  await viewer.ready
  await viewer.openFromSource('plm', 'CAR-0001')
  viewer.on('select', ({ part }) => showPlmDetails(part && part.name))
  await viewer.colorize({ 'Engine_*': '#e3a008' })
  const png = await viewer.screenshot()          // e.g. attach to a change request
</script>
```

`cad-viewer-host.js` is a plain script (no build, no framework). Every API method below is available and returns a Promise.
Without the helper, the protocol is:

```js
iframe.contentWindow.postMessage({ channel: 'cad-viewer', id: 1, method: 'select', args: ['Engine_Block'] }, viewerOrigin)
// reply:  { channel: 'cad-viewer', id: 1, result }   or   { channel: 'cad-viewer', id: 1, error }
// events: { channel: 'cad-viewer', event: 'select', data: { part } }
```

Send `method: 'hello'` first. After that, the viewer sends events only to your page's origin.

## 3. Web component

```html
<script type="module" src="https://viewer.example.com/sdk/cad-viewer.js"></script>

<cad-viewer source="plm" model-id="PRT-1001" ui="compact" style="height:600px"></cad-viewer>
```

| Attribute | |
|---|---|
| `src`, `name` | Open a URL |
| `source`, `model-id` | Open through a connector (changing them reloads) |
| `ui` | `full`, `compact`, `minimal`, `none` |
| `quality` | `draft`, `normal`, `fine` (STEP/IGES mesh quality) |
| `server-url` | Viewer server (default: where the script came from) |
| `with-credentials` | Send cookies with URL downloads (SSO sessions) |

Properties: `element.viewer` is the full API (after `cad-ready`), and `element.headers` is an object or function for auth headers.
DOM events: `cad-ready`, `cad-loadstart`, `cad-progress`, `cad-load`, `cad-error`, `cad-select`, `cad-visibility`, `cad-measure`, `cad-clear`.

The component renders in a **shadow DOM**: host CSS cannot break it, and its CSS cannot leak out. Keyboard shortcuts only work while the viewer has focus, so it never steals the host app's keys.

**Angular:** add `CUSTOM_ELEMENTS_SCHEMA` to the module or component. **React 19:** use the tag directly. **React 18:** attach events with `addEventListener` via a ref. See `examples/index.html` for snippets.

## 4. JavaScript API

```js
import { mountViewer } from 'https://viewer.example.com/sdk/cad-viewer.js'

const viewer = await mountViewer(document.getElementById('box'), {
  ui: 'none',                                   // or 'full' | 'compact' | 'minimal' | { toolbar: true, tree: false, ... }
  headers: async () => ({ Authorization: 'Bearer ' + await getToken() }),
})
await viewer.load({ url: '/dms/files/4711', name: 'housing.step', meta: { itemId: '4711' } })
```

### API reference

| Method | Description |
|---|---|
| `load(input, { replace })` | Open a `File`, `Blob`, `ArrayBuffer`, URL string, or `{ url \| data, name, headers, meta }`. Arrays load several files into one scene. `replace: false` adds to the scene |
| `openFromSource(source, id)` | Open through a server connector |
| `listSources()`, `listModels(source, q)` | Browse connectors |
| `clear()`, `cancel()` | Clear the scene, cancel a running load |
| `fit()`, `setView('front'…'iso')`, `setProjection()`, `setUpAxis('Y'\|'Z')` | Camera |
| `setDisplayMode('shaded'\|'edges'\|'wireframe'\|'xray')`, `setGrid()` | Display |
| `setSection('x'\|'y'\|'z', { enabled, t: 0..1, flip })`, `setExplode(0..1)`, `setFlyMode()` | Inside views |
| `getTree()`, `getParts()`, `find(query)` | Structure. `query` = id, exact name, glob (`"Wheel_*"`), or an array of these |
| `select(query)`, `getSelection()`, `zoomTo(query)` | Selection |
| `show(query)`, `hide(query)`, `isolate(query)`, `showAll()` | Visibility |
| `colorize({ query: '#hex' }, opacity?)`, `resetColors()` | Colour overrides (lifecycle state, test results, supplier…) |
| `setTool('select'\|'measure')`, `getMeasurements()`, `clearMeasurements()` | Measuring |
| `getStats()`, `screenshot()` | Info, PNG data URL |
| `on(event, fn)` returns an unsubscribe function | Events: `ready`, `loadstart`, `progress`, `load`, `error`, `select`, `visibility`, `measure`, `clear` |

**Linking CAD parts to PLM items:** the viewer identifies parts by the **product names in the CAD file** (in STEP these are usually the part numbers or names from the CAD tool). The host keeps the mapping (for example, BOM line → CAD name) and calls `select` / `isolate` / `colorize` with those names. `examples/plm-portal.html` shows this in both directions.

---

## Connectors (reading from PLM / DMS)

The browser never talks to the PLM directly. The viewer server fetches files through a connector and streams them to the browser. So:
- PLM credentials stay on the server.
- No CORS setup is needed on the PLM.
- The browser sees one simple API: `/api/sources/:source/models/:id/file`.

Connectors are configured in `server/sources.json` (see `server/sources.example.json`). `${ENV_VAR}` values are read from the environment, so secrets stay out of the file.

### Config-only REST connector

```json
{
  "id": "plm",
  "name": "Our PLM",
  "type": "rest",
  "baseUrl": "https://plm.example.com/api",
  "list":  { "url": "{baseUrl}/parts?search={q}", "itemsPath": "items" },
  "item":  { "url": "{baseUrl}/parts/{id}" },
  "file":  { "url": "{baseUrl}/parts/{id}/content" },
  "fields": { "id": "number", "name": "cadFile.name", "size": "cadFile.size", "category": "state", "description": "title" },
  "extra":  { "partNumber": "number", "revision": "revision", "state": "state" },
  "headers": { "Authorization": "Bearer ${PLM_TOKEN}" },
  "forwardAuth": false
}
```

- `fields` / `extra` / `itemsPath` are dot-paths into the PLM's JSON.
- `forwardAuth: true` passes the user's own `Authorization` header and cookies through, so the PLM applies **that user's permissions** instead of a service account's. Prefer this in production.
- The file name comes from the PLM's `Content-Disposition` header, else from `fields.name`. If neither has an extension, the format is detected from the file content (STEP, IGES, STL, glTF, OBJ…).

Starting points for common systems. Check them against your version and customisation, because these differ between installations:
- **Aras Innovator:** OData at `/{server}/odata/Part?$filter=contains(item_number,'{q}')`, `itemsPath: "value"`. The CAD file is usually a related `CAD` item's `native_file`.
- **PTC Windchill (WRS):** OData at `/Windchill/servlet/odata/ProdMgmt/Parts`. The CAD file comes from the related EPMDocument's primary content (DocMgmt / CADDocumentMgmt domains).
- **Siemens Teamcenter:** usually needs a **custom connector** (below). Finding the dataset for an item revision takes several calls.

### Custom code connector

For multi-step logins, SOAP/SOA services, or "find the right dataset" logic, write a small module. Copy `server/connectors/template.mjs`:

```json
{ "id": "tc", "name": "Teamcenter", "type": "module", "module": "./connectors/my-teamcenter.mjs", "url": "https://tc.example.com" }
```

It needs three functions: `list({ q, req })`, `get(id, { req })` and `open(id, { req })`. `open` returns `{ name, size, stream }`.

---

## Security settings

| Env var | Default | Set it in production to |
|---|---|---|
| `EMBED_ORIGINS` | `*` | Host sites allowed to put `embed.html` in an iframe **and** send it postMessage commands, e.g. `https://plm.example.com`. Enforced by `Content-Security-Policy: frame-ancestors` and by an origin check on every message |
| `ALLOWED_ORIGINS` | `*` | Sites allowed to call the API and load the SDK (CORS) |
| `SOURCES_FILE` | `server/sources.json` | Your connector config |
| `MOCK_PLM` | on | `0`, which turns off the demo PLM |
| `PLM_TOKEN` | `demo-token` | A real secret, or better: `forwardAuth` |

Other things to know:
- **The API has no login of its own.** Deploy it behind your SSO / reverse proxy, or turn on `forwardAuth` so the PLM decides access. Anyone who can reach the server can read what its service account can read.
- The embedded viewer does **not** cache files in the browser (`rememberRecent` is off). Controlled data should not linger on client machines. The standalone app caches recent files; turn that off if your data policy requires it.
- The glTF Draco decoder loads from Google's CDN by default. On closed networks, host it yourself and set `dracoDecoderUrl`.

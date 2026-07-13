<!-- Draft issue for github.com/Shopify/react-native-skia -->

# Web: sksg replay path leaks CanvasKit WASM objects every frame → `Aborted()` crash

## Description

On web, any continuously animated `<Canvas>` leaks CanvasKit WASM memory on
every frame until the WASM heap hits its ceiling and CanvasKit throws
`RuntimeError: Aborted()` (typically while allocating during the next frame,
e.g. constructing a `PictureRecorder`). After the abort, the runtime is dead
and every subsequent frame fails — in our app as an infinite
`Cannot pass deleted object as Image const*` loop.

The root cause is that the web replay path (`sksg/Recorder`) creates WASM
objects per frame and never disposes them. Although canvaskit-wasm's embind
bindings register wrappers in a `FinalizationRegistry`, that only frees
native objects when the **JS** garbage collector happens to run — and the JS
GC cannot see WASM memory pressure. A typical animated scene produces almost
no JS garbage per frame, so the GC idles while the WASM heap fills at MB/s,
unreclaimed (measured: linear growth for minutes with zero reclamation).
Only explicit `dispose()`/`delete()` frees the memory deterministically, and
the replay path never calls it.

Verified on `2.6.2`; the same code is present on `main` as of 2026-07-12
(`packages/skia/src/sksg/Recorder/Player.ts`, `DrawingContext.ts`).
Native is unaffected (separate C++ recorder pipeline).

## Leak sites (all per frame, web)

1. **`sksg/Recorder/Player.ts`** — every draw command:
   ```ts
   const paint = ctx.paint.copy();   // new WASM SkPaint
   ...
   ctx.paints.pop();                 // JS ref dropped, WASM object never disposed
   ```
   One leaked paint **per draw command per frame**. Also the standalone
   `SavePaint` branch creates a throwaway `ctx.Skia.Paint()` that is never
   disposed.

2. **`skia/web/JsiSkPaint.ts`** — `assign()` and `reset()` replace the ref
   without deleting the old one, so the paint pool's "reuse" still leaks one
   WASM paint per `SavePaint` per frame:
   ```ts
   assign(paint: SkPaint) {
     this.ref = paint.ref.copy();   // previous this.ref is orphaned
   }
   ```

3. **`sksg/Recorder/DrawingContext.ts`** — runs once per frame:
   ```ts
   paintPool[0] = Skia.Paint();     // previous pool[0] orphaned every frame
   ```
   and every declaration created during replay — gradient/noise shaders,
   `MaskFilter.MakeBlur` (via `setBlurMaskFilter`), color filters, image
   filters, path effects, and the `MakeCompose` intermediates built in
   `materializePaint` — is dropped without disposal after being set on a
   paint.

4. **`sksg/Recorder/commands/Drawing.ts`** — `drawVertices` rebuilds the full
   WASM `SkVertices` buffer (the entire position/color data) every frame and
   never disposes it.

5. **`sksg/Container.web.tsx`** — each React commit calls `redraw()`, which
   records with a fresh `paintPool`, orphaning every paint in the superseded
   pool. The view side (`SkiaViewApi.setJsiProperty(id, "picture", ...)` /
   `SkiaPictureView.web.tsx setPicture`) also overwrites the previous frame's
   `SkPicture` without disposing it.

## Measured impact

Real app (a puzzle game with a rich animated scene, ~200 draw commands/frame,
Reanimated-driven): **~48 KB of WASM heap leaked per frame (~1.1 MB/s at 60
fps)**. 3-minute soak, identical inputs:

| Metric (3 min, ~4,000 frames) | 2.6.2 stock | with disposal fix |
|---|---|---|
| Reserved WASM heap (`HEAPU8.length`) | 128 MB → **221 MB, climbing** | **128 MB, flat** |
| Malloc high-water probe | 5.6 → 199 MB, linear, no plateau | 4.8 → 14.5 MB, plateaus after ~150 s |
| Outcome | `Aborted()` after ~30 min of play | stable |

Minimal repro (196 small animated circles with `RadialGradient` + `BlurMask`,
idle — no user interaction): leaks **~5 MB/s** and crashes with
`RuntimeError: Aborted()` in **~25 seconds** (see repro notes below).

| t (s) | 0 | 5 | 10 | 15 | 20 | 25 |
|---|---|---|---|---|---|---|
| high-water (MB) | 5.8 | 30.3 | 54.9 | 79.1 | 102.4 | **Aborted()** |

## Minimal repro

Repo: https://github.com/hangy233/skia-web-leak-repro (Expo 56 web,
skia 2.6.2, reanimated 4.3.1, canvaskit-wasm 0.41.0). The demo renders 196
circles animated by one shared value and shows a live on-screen readout of
`CanvasKit.HEAPU8.length` plus a malloc high-water probe, and a crash banner
reporting time-to-abort.

```tsx
const Dot = ({ index, clock }) => {
  const r = useDerivedValue(() => 5 + 4 * Math.sin(2 * Math.PI * (clock.value + index / 196)));
  return (
    <Circle cx={cx} cy={cy} r={r}>
      <RadialGradient c={vec(cx, cy)} r={12} colors={['#00FFCC', '#00334400']} />
      <BlurMask blur={3} style="normal" />
    </Circle>
  );
};
```

Steps:
1. `npm install && npm run web`
2. Open the page, wait for CanvasKit to load, leave it running.
3. The malloc high-water climbs ~5 MB/s; after ~25 s the page crashes with
   `RuntimeError: Aborted()` and shows a red crash banner.

Note on time compression: so the issue is demonstrable in seconds instead of
30+ minutes, the demo caps the WASM heap at its initial 128 MB by making
`WebAssembly.Memory.grow()` throw (`App.tsx`, clearly marked). Emscripten
treats that exactly like the browser refusing to enlarge memory at the real
2–4 GB ceiling, so the failure path is identical to production. Set
`CAP_WASM_HEAP_AT_INITIAL = false` to watch the heap grow unbounded instead.

The repo's **`fix` branch** is the same demo with a patch-package patch that
adds the missing disposals — same scene, same cap, runs indefinitely with the
high-water plateauing.

## How to observe the leak (since JS heap snapshots won't show it)

The leaked objects live in the WASM heap; their JS wrappers are collected
normally, so DevTools JS heap snapshots look clean. Instead:

```js
// Reserved WASM memory (steps up when exhausted; should never grow):
CanvasKit.HEAPU8.length / 1048576 + ' MB'

// Fine-grained: top-of-used-heap probe (climbs linearly with the leak):
const probe = (size = 4096) => {
  const m = CanvasKit.Malloc(Uint8Array, size);
  const address = m.byteOffset;
  CanvasKit.Free(m);
  return address;
};
setInterval(() => console.log((probe() / 1048576).toFixed(1) + ' MB'), 5000);
```

## Fix that worked for us

We're running this in production (happy to turn it into a PR against
`packages/skia/src` if you're open to it). Full patch on the repro repo's
`fix` branch: https://github.com/hangy233/skia-web-leak-repro/tree/fix

- `DrawingContext`: track every transient created during a frame replay
  (shaders, filters, compose intermediates — the declaration arrays intercept
  `push`, so no command-file changes needed) in a `Set`, expose
  `disposeTransients()`; reuse `paintPool[0]` instead of reallocating.
- `Player`: dispose the per-draw `paint.copy()` after the draw and the
  standalone throwaway paint after `assign`.
- `JsiSkPaint.assign/reset`: `delete()` the replaced ref.
- `setBlurMaskFilter`: dispose the mask filter after `setMaskFilter` (the
  paint holds its own native ref). User-provided `filter` prop objects bypass
  tracking so they are never disposed out from under the caller.
- `drawVertices`: dispose the per-frame `SkVertices` after the draw.
- `Container.web` `drawOnscreen`: call `ctx.disposeTransients()` right after
  `finishRecordingAsPicture()` — safe because the picture holds native refs
  to everything it recorded. `redraw()` disposes the superseded recording's
  paint pool; superseded recordings are flagged so the **one mapper
  invocation that can still fire after `stopMapper`** bails out instead of
  touching freed pool paints (without the flag this throws
  `BindingError: Paint instance already deleted`).

Possibly related (same terminal symptom, different path): #2079, #2319.

## Environment

- `@shopify/react-native-skia`: 2.6.2
- `canvaskit-wasm`: 0.41.0
- `react-native-reanimated`: 4.3.1
- Expo 56 / react-native 0.85.3 / react-native-web 0.21.x
- Browser: Chromium (Chrome/Edge), reproduced headless and headed, Windows 11

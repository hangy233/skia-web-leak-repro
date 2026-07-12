<!-- Draft issue for github.com/Shopify/react-native-skia -->

# Web: sksg replay path leaks CanvasKit WASM objects every frame → `Aborted()` after minutes of animation

## Description

On web, any continuously animated `<Canvas>` leaks CanvasKit WASM memory on
every frame until the WASM heap hits its ceiling and CanvasKit throws
`Aborted()` (typically while constructing the next `PictureRecorder`). After
the abort, the runtime is dead and every subsequent frame fails — in our app
as an infinite `Cannot pass deleted object as Image const*` loop.

The root cause is that the web replay path (`sksg/Recorder`) creates WASM
objects per frame and never disposes them. On web there is no
`FinalizationRegistry` hookup for CanvasKit objects, so JS garbage collection
never frees WASM memory — only explicit `dispose()`/`delete()` does, and the
replay path never calls it.

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

4. **`sksg/Container.web.tsx`** — each React commit calls `redraw()`, which
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
| Outcome extrapolated | `Aborted()` at ~30 min of play | stable |

Minimal repro (16 animated circles with `RadialGradient` + `BlurMask`, idle —
no user interaction): malloc high-water climbs **2.6 MB → 54.0 MB in 120 s**,
perfectly linear at ~430 KB/s (~7 KB per frame). At that rate the initial
128 MB reservation is exhausted in ~5 minutes and the heap ceiling in under
90 minutes.

| t (s) | 0 | 30 | 60 | 90 | 120 |
|---|---|---|---|---|---|
| high-water (MB) | 2.6 | 15.5 | 28.5 | 41.2 | 54.0 |

## Minimal repro

Repo: <!-- link after publishing --> (Expo 56 web, skia 2.6.2, reanimated
4.3.1, canvaskit-wasm 0.41.0). The demo renders 16 circles animated by one
shared value and shows a live on-screen readout of `CanvasKit.HEAPU8.length`
plus a malloc high-water probe.

```tsx
const Dot = ({ index, clock }) => {
  const r = useDerivedValue(() => 10 + 8 * Math.sin(2 * Math.PI * (clock.value + index / 16)));
  return (
    <Circle cx={cx} cy={cy} r={r}>
      <RadialGradient c={vec(cx, cy)} r={20} colors={['#00FFCC', '#00334400']} />
      <BlurMask blur={6} style="normal" />
    </Circle>
  );
};
```

Steps:
1. `npm install && npx expo start --web`
2. Open the page, wait for CanvasKit to load, leave it running.
3. Watch the on-screen counter: the malloc high-water climbs continuously and
   the reserved heap steps up each time the current reservation is exhausted.

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

We're running a patch in production (happy to turn it into a PR against
`packages/skia/src` if you're open to it):

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
- `Container.web` `drawOnscreen`: call `ctx.disposeTransients()` right after
  `finishRecordingAsPicture()` — safe because the picture holds native refs
  to everything it recorded. `redraw()` disposes the superseded recording's
  paint pool; superseded recordings are flagged so the **one mapper
  invocation that can still fire after `stopMapper`** bails out instead of
  touching freed pool paints (without the flag this throws
  `BindingError: Paint instance already deleted`).

Full patch (against the 2.6.2 `lib/module` output) with before/after
measurements: https://github.com/hangy233/amoeba/pull/10

Possibly related (same terminal symptom, different path): #2079, #2319.

## Environment

- `@shopify/react-native-skia`: 2.6.2
- `canvaskit-wasm`: 0.41.0
- `react-native-reanimated`: 4.3.1
- Expo 56 / react-native 0.85.3 / react-native-web 0.21.x
- Browser: Chromium (Chrome/Edge), reproduced headless and headed, Windows 11

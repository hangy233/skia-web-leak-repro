# react-native-skia web WASM memory-leak repro

Minimal reproduction for a memory leak in `@shopify/react-native-skia`'s **web**
renderer: the per-frame replay path (`sksg/Recorder`) creates CanvasKit WASM
objects (paints, shaders, mask filters, color/image filters) on every animation
frame and never disposes them. On web nothing garbage-collects CanvasKit
objects, so any continuously animated `<Canvas>` grows the WASM heap until
CanvasKit throws `Aborted()` (heap-growth failure), after which every
subsequent frame fails — typically as a repeating
`Cannot pass deleted object as ...` error loop.

The scene here is deliberately tiny: 16 animated circles, each with a
`RadialGradient` and a `BlurMask`, driven by one Reanimated shared value.
Any animated scene leaks — a single plain `<Circle>` leaks one WASM paint per
frame via `ctx.paint.copy()` in `sksg/Recorder/Player.ts`; gradients and blur
masks just make it faster.

## Repro steps

1. `npm install`
2. `npm run web` (Expo starts Metro; open http://localhost:8081 if it doesn't auto-open)
3. Wait for CanvasKit to load; the animation starts immediately.
4. Watch the on-screen counter. The **malloc high-water** line climbs
   continuously (never plateaus), and the **reserved heap** steps up each time
   the current WASM reservation is exhausted. A history line is appended every
   15 s so the trend is visible at a glance.
5. Left long enough (heap ceiling / 2 GB), CanvasKit aborts and the page dies
   with `Aborted()` followed by an error loop.

## Measuring the leak yourself (memory-profile guide)

Chrome DevTools' JS heap snapshots will **not** show this leak — the leaked
objects live inside the CanvasKit WASM heap, and their JS wrappers are
garbage-collected normally. Use one of these instead:

**A. WASM heap reservation (coarse).** In the DevTools console:

```js
CanvasKit.HEAPU8.length / 1048576 + ' MB'
```

This is the reserved WASM memory. It only moves when the current reservation
is exhausted (CanvasKit starts at 128 MB), so it steps rather than creeps —
but it should never grow at all for a scene with constant content.

**B. Malloc high-water probe (fine-grained).** Allocate a small block, record
its address, free it:

```js
const probe = (size = 4096) => {
  const m = CanvasKit.Malloc(Uint8Array, size);
  const address = m.byteOffset;
  CanvasKit.Free(m);
  return address;
};
setInterval(() => console.log((probe() / 1048576).toFixed(1) + ' MB'), 5000);
```

dlmalloc places fresh small allocations just past the used region, so this
address tracks the top of live WASM data. With balanced alloc/free it
plateaus after cache warmup; with the leak it climbs linearly — measured
~430 KB/s (2.6 MB → 54 MB in 2 minutes) in this demo, ~7 KB per frame from
just 16 circles. (Sanity check: leak 2000×300 B deliberately with
`CanvasKit.Malloc` and watch the probe jump ~0.7 MB; free them and it returns
exactly to baseline.)

**C. Browser task manager (external).** Shift+Esc in Chrome/Edge → the tab's
memory footprint grows in lockstep with (A).

## Where the leak is (version 2.6.2, still present on `main`)

All in `lib/module/sksg/` (web replay path; native uses a separate C++ recorder):

- `Recorder/Player.js` — every draw command does `const paint = ctx.paint.copy()`
  and pops it without `dispose()`; standalone `SavePaint` creates a throwaway
  `Skia.Paint()` that is never disposed.
- `Recorder/DrawingContext.js` — `paintPool[0] = Skia.Paint()` on every frame,
  orphaning the previous one; every shader / color-filter / image-filter /
  path-effect declaration and every `MakeCompose` intermediate is created per
  frame and never disposed.
- `skia/web/JsiSkPaint.js` — `assign()` and `reset()` replace `this.ref` with a
  new WASM object without `delete()`ing the old one, so even the pool's
  "reused" paints leak one WASM paint per `SavePaint` per frame.
- `Recorder/commands/ImageFilters.js` — `setBlurMaskFilter` creates a
  `MaskFilter` per frame, sets it on the paint, and drops the handle.
- `sksg/Container.web.js` — each React commit records with a fresh
  `paintPool`, orphaning every paint in the previous pool. The view bridge
  also overwrites the previous frame's `SkPicture` without disposing it.

A working fix (dispose per-frame transients after `finishRecordingAsPicture`,
delete replaced refs in `assign`/`reset`, reuse `paintPool[0]`, dispose
superseded pools with a guard for the post-`stopMapper` stale mapper run) is
deployed as a patch-package patch here:
https://github.com/hangy233/amoeba/pull/10

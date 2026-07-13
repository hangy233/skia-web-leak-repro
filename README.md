# react-native-skia web WASM memory-leak repro

Minimal reproduction for a memory leak in `@shopify/react-native-skia`'s **web**
renderer: the per-frame replay path (`sksg/Recorder`) creates CanvasKit WASM
objects (paints, shaders, mask filters, color/image filters, vertex buffers)
on every animation frame and never disposes them. The WASM heap grows until
CanvasKit throws `Aborted()` (memory-growth failure), after which every
subsequent frame fails — typically as a repeating
`Cannot pass deleted object as ...` error loop.

The scene here is 196 small animated circles, each with a `RadialGradient`
and a `BlurMask`, driven by one Reanimated shared value — it leaks
**~5 MB/s**. Any animated scene leaks: a single plain `<Circle>` leaks one
WASM paint per frame via `ctx.paint.copy()` in `sksg/Recorder/Player.ts`.

**This demo crashes in ~25 seconds.** To avoid waiting 30+ minutes for the
heap to reach the browser's real 2–4 GB WebAssembly ceiling, `App.tsx` caps
the heap at its initial 128 MB by making `WebAssembly.Memory.grow()` throw —
emscripten treats that exactly like the browser refusing to enlarge memory,
so the failure path (`Aborted()` while allocating during the next frame) is
identical to production, just sooner. Set `CAP_WASM_HEAP_AT_INITIAL = false`
in `App.tsx` to watch the heap grow unbounded toward the real ceiling instead.

## Repro steps

1. `npm install`
2. `npm run web` (Expo starts Metro; open http://localhost:8081 if it doesn't auto-open)
3. Wait for CanvasKit to load; the animation starts immediately.
4. Watch the on-screen counter: the **malloc high-water** climbs ~5 MB/s
   (a history line is appended every 5 s).
5. After ~25 s the reserve is exhausted and a red **CRASHED** banner appears
   with `RuntimeError: Aborted()` — the DevTools console shows the same error
   repeating every frame afterward.

## The fix (branch `fix`)

The `fix` branch is the same demo plus a
[patch-package](https://www.npmjs.com/package/patch-package) patch
(`patches/@shopify+react-native-skia+2.6.2.patch`) that disposes the
per-frame transients:

```
git checkout fix
npm install   # postinstall applies the patch
npm run web
```

Same scene, same heap cap — but memory plateaus after warmup and the demo
runs indefinitely. The patch:

- disposes every transient created while replaying a frame (per-draw paint
  copies, shaders, mask/color/image filters, compose intermediates, vertex
  buffers) right after the frame's picture is finalized — safe because the
  picture holds its own native refs;
- fixes `JsiSkPaint.assign()/reset()` to `delete()` the WASM ref they replace;
- reuses `paintPool[0]` instead of reallocating it every frame;
- disposes the superseded recording's paint pool on each React commit, with a
  guard for the one mapper invocation that can still fire after `stopMapper`
  (without it: `BindingError: Paint instance already deleted`).

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
plateaus after cache warmup; with the leak it climbs linearly (~5 MB/s in
this demo). Sanity check: leak 2000×300 B deliberately with
`CanvasKit.Malloc` and watch the probe jump ~0.7 MB; free them and it
returns exactly to baseline.

**C. Browser task manager (external).** Shift+Esc in Chrome/Edge → the tab's
memory footprint grows in lockstep with (A).

## Why the GC doesn't save you

canvaskit-wasm's embind bindings do register wrappers in a
`FinalizationRegistry`, so a garbage-collected wrapper *eventually* frees its
native object. But the JS garbage collector only runs under **JS** memory
pressure — it cannot see the WASM heap filling up. A typical animated canvas
(like this demo, or a real app) produces almost no JS garbage per frame, so
the GC idles while the WASM heap grows unreclaimed at MB/s until CanvasKit
aborts. (Ironically, scenes that marshal huge JS arrays every frame generate
enough JS garbage to keep the GC running and partially self-heal.) Explicit
`dispose()` in the renderer is the only deterministic fix.

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
- `Recorder/commands/Drawing.js` — `drawVertices` rebuilds the full WASM
  `SkVertices` buffer every frame and never disposes it.
- `sksg/Container.web.js` — each React commit records with a fresh
  `paintPool`, orphaning every paint in the previous pool. The view bridge
  also overwrites the previous frame's `SkPicture` without disposing it.

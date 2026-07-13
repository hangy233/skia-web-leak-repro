import React from 'react';
import { Text, View } from 'react-native';
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';

/**
 * Time compression for the demo — NOT part of the bug.
 *
 * The leak needs to fill the WASM heap before CanvasKit aborts. Stock
 * CanvasKit starts at 128 MB and grows to the browser's 2-4 GB WebAssembly
 * ceiling, so a real app takes ~30+ minutes of play to crash. Capping the
 * heap at its initial 128 MB makes the very first growth request fail,
 * which exercises the exact same failure path (emscripten treats a throwing
 * `memory.grow()` like the browser refusing to enlarge memory → `Aborted()`)
 * within ~30 seconds instead.
 *
 * Set to false to watch the heap grow unbounded toward the real ceiling.
 */
const CAP_WASM_HEAP_AT_INITIAL = true;
if (CAP_WASM_HEAP_AT_INITIAL) {
  WebAssembly.Memory.prototype.grow = function () {
    throw new RangeError(
      'WebAssembly.Memory.grow refused by demo cap (simulates the 2-4 GB browser ceiling)',
    );
  };
}

export default function App() {
  return (
    <View style={{ flex: 1, backgroundColor: '#111111' }}>
      <WithSkiaWeb
        getComponent={() => import('./src/Demo')}
        fallback={<Text style={{ color: 'white' }}>Loading Skia...</Text>}
        opts={{
          locateFile: (file: string) =>
            `https://cdn.jsdelivr.net/npm/canvaskit-wasm@0.41.0/bin/full/${file}`,
        }}
      />
    </View>
  );
}

import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import {
  BlurMask,
  Canvas,
  Circle,
  RadialGradient,
  vec,
} from '@shopify/react-native-skia';
import {
  Easing,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

// LoadSkiaWeb puts the CanvasKit instance on globalThis.
declare const CanvasKit: {
  HEAPU8: { length: number };
  Malloc: (typedArray: unknown, length: number) => { byteOffset: number };
  Free: (m: unknown) => void;
};

const SIZE = 320;
const GRID = 14; // 196 dots

/**
 * One continuously animated dot. react-native-skia's web replay path leaks
 * a handful of CanvasKit WASM objects for it on EVERY frame — a paint copy
 * per draw command, a pool-paint assign, the gradient shader, and the blur
 * mask filter — none of which are ever disposed. ~196 dots leak roughly
 * 4 MB/s at 60 fps.
 *
 * The per-frame JS garbage is tiny (like a typical animated canvas), so the
 * JS GC — the only thing that could reclaim the WASM objects via embind's
 * FinalizationRegistry — barely runs, and the WASM heap grows unreclaimed.
 */
const Dot: React.FC<{ index: number; clock: { value: number } }> = ({ index, clock }) => {
  const col = index % GRID;
  const row = Math.floor(index / GRID);
  const cx = (col + 0.5) * (SIZE / GRID);
  const cy = (row + 0.5) * (SIZE / GRID);
  const r = useDerivedValue(
    () => 5 + 4 * Math.sin(Math.PI * 2 * (clock.value + index / (GRID * GRID))),
  );
  return (
    <Circle cx={cx} cy={cy} r={r}>
      <RadialGradient c={vec(cx, cy)} r={12} colors={['#00FFCC', '#00334400']} />
      <BlurMask blur={3} style="normal" />
    </Circle>
  );
};

/** Allocate & free a block; its address tracks the top of the used heap. */
const probe = (size: number) => {
  const m = CanvasKit.Malloc(Uint8Array, size);
  const address = m.byteOffset;
  CanvasKit.Free(m);
  return address;
};

export default function Demo() {
  const clock = useSharedValue(0);
  useEffect(() => {
    clock.value = withRepeat(withTiming(1, { duration: 2000, easing: Easing.linear }), -1, false);
  }, [clock]);

  const [stats, setStats] = useState('measuring...');
  const [log, setLog] = useState<string[]>([]);
  const [crash, setCrash] = useState<string | null>(null);
  useEffect(() => {
    const t0 = Date.now();
    const onError = (e: ErrorEvent) => {
      setCrash(prev => prev ?? `CRASHED after ${Math.round((Date.now() - t0) / 1000)}s: ${String(e.message).slice(0, 140)}`);
    };
    window.addEventListener('error', onError);
    const id = setInterval(() => {
      const t = Math.round((Date.now() - t0) / 1000);
      const reservedMb = CanvasKit.HEAPU8.length / 1048576;
      let highWater: string;
      try {
        highWater = (probe(4096) / 1048576).toFixed(1) + ' MB';
      } catch {
        highWater = 'malloc failed (heap exhausted)';
      }
      const line = `t=${String(t).padStart(3)}s   reserved heap: ${reservedMb.toFixed(0)} MB   malloc high-water: ${highWater}`;
      setStats(line);
      if (t % 5 === 0) setLog(prev => [...prev.slice(-19), line]);
    }, 1000);
    return () => { clearInterval(id); window.removeEventListener('error', onError); };
  }, []);

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ color: '#00FF66', fontFamily: 'monospace', fontSize: 16 }}>{stats}</Text>
      {crash && (
        <Text style={{ color: '#FF3344', fontFamily: 'monospace', fontSize: 16, marginTop: 4 }}>{crash}</Text>
      )}
      <Text style={{ color: '#888888', fontFamily: 'monospace', fontSize: 12, marginVertical: 8 }}>
        196 animated dots leak ~4 MB of CanvasKit WASM memory per second on
        @shopify/react-native-skia 2.6.2 (web). The demo caps the WASM heap at
        its initial 128 MB (see App.tsx) so the resulting Aborted() crash —
        which stock CanvasKit only reaches at the 2-4 GB browser ceiling after
        ~30+ minutes — lands in about half a minute. Watch the high-water climb,
        then the crash banner.
      </Text>
      <Canvas style={{ width: SIZE, height: SIZE, backgroundColor: '#000000' }}>
        {Array.from({ length: GRID * GRID }, (_, i) => (
          <Dot key={i} index={i} clock={clock} />
        ))}
      </Canvas>
      {log.map((line, i) => (
        <Text key={i} style={{ color: '#557755', fontFamily: 'monospace', fontSize: 12 }}>{line}</Text>
      ))}
    </View>
  );
}

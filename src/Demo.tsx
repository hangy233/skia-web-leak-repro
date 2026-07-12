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
const DOTS = 16;

/**
 * One continuously animated dot. Each dot contributes a handful of WASM
 * allocations per frame inside react-native-skia's web replay path
 * (paint copy per draw command, pool-paint assign, gradient shader,
 * blur mask filter) — none of which are ever disposed.
 */
const Dot: React.FC<{ index: number; clock: { value: number } }> = ({ index, clock }) => {
  const angle = (index / DOTS) * Math.PI * 2;
  const cx = SIZE / 2 + Math.cos(angle) * SIZE * 0.32;
  const cy = SIZE / 2 + Math.sin(angle) * SIZE * 0.32;
  const r = useDerivedValue(() => 10 + 8 * Math.sin(Math.PI * 2 * (clock.value + index / DOTS)));
  return (
    <Circle cx={cx} cy={cy} r={r}>
      <RadialGradient c={vec(cx, cy)} r={20} colors={['#00FFCC', '#00334400']} />
      <BlurMask blur={6} style="normal" />
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
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => {
      const t = Math.round((Date.now() - t0) / 1000);
      const reservedMb = CanvasKit.HEAPU8.length / 1048576;
      const highWaterMb = probe(4096) / 1048576;
      const line = `t=${String(t).padStart(4)}s   reserved heap: ${reservedMb.toFixed(0)} MB   malloc high-water: ${highWaterMb.toFixed(1)} MB`;
      setStats(line);
      if (t % 15 === 0) setLog(prev => [...prev.slice(-19), line]);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ color: '#00FF66', fontFamily: 'monospace', fontSize: 16 }}>{stats}</Text>
      <Text style={{ color: '#888888', fontFamily: 'monospace', fontSize: 12, marginVertical: 8 }}>
        Leave this page open. On @shopify/react-native-skia 2.6.2 (web) the malloc
        high-water climbs continuously and the reserved WASM heap steps up until
        CanvasKit throws Aborted(). Every 15 s a line is appended below.
      </Text>
      <Canvas style={{ width: SIZE, height: SIZE, backgroundColor: '#000000' }}>
        {Array.from({ length: DOTS }, (_, i) => (
          <Dot key={i} index={i} clock={clock} />
        ))}
      </Canvas>
      {log.map((line, i) => (
        <Text key={i} style={{ color: '#557755', fontFamily: 'monospace', fontSize: 12 }}>{line}</Text>
      ))}
    </View>
  );
}

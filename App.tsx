import React from 'react';
import { Text, View } from 'react-native';
import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';

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

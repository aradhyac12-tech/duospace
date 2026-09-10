import { registerPlugin } from '@capacitor/core';
import type { DuospaceBackgroundGeolocationPlugin } from './definitions';

const DuospaceBackgroundGeolocation = registerPlugin<DuospaceBackgroundGeolocationPlugin>(
  'DuospaceBackgroundGeolocation',
  {
    // No web implementation: this plugin is native-only by design (the web
    // fallback is the existing navigator.geolocation.watchPosition path
    // already in useLiveLocation.ts, which the web platform is fully
    // capable of running continuously without a service-worker-style
    // background layer). Calling any method on web without a native
    // platform rejects clearly instead of silently no-oping, so a caller
    // that forgets to branch on Capacitor.isNativePlatform() finds out
    // immediately rather than shipping a silent gap.
  },
);

export * from './definitions';
export { DuospaceBackgroundGeolocation };

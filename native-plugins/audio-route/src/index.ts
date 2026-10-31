import { registerPlugin } from '@capacitor/core';
import type { DuospaceAudioRoutePlugin } from './definitions';

const DuospaceAudioRoute = registerPlugin<DuospaceAudioRoutePlugin>('DuospaceAudioRoute');

export * from './definitions';
export { DuospaceAudioRoute };

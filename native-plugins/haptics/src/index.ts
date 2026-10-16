import { registerPlugin } from '@capacitor/core';
import type { DuospaceHapticsPlugin } from './definitions';

const DuospaceHaptics = registerPlugin<DuospaceHapticsPlugin>('DuospaceHaptics');

export * from './definitions';
export { DuospaceHaptics };

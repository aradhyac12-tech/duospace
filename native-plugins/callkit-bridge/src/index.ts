import { registerPlugin } from '@capacitor/core';
import type { DuospaceCallKitBridgePlugin } from './definitions';

const DuospaceCallKitBridge = registerPlugin<DuospaceCallKitBridgePlugin>('DuospaceCallKitBridge');

export * from './definitions';
export { DuospaceCallKitBridge };

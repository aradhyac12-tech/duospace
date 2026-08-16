import { registerPlugin } from '@capacitor/core';
import type { DuospaceDeviceStatusPlugin } from './definitions';

const DuospaceDeviceStatus = registerPlugin<DuospaceDeviceStatusPlugin>('DuospaceDeviceStatus');

export * from './definitions';
export { DuospaceDeviceStatus };

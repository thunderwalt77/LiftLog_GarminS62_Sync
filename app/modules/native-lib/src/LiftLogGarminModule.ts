import { NativeModule, requireOptionalNativeModule } from 'expo';

type GarminEvents = {
  onMessage: (event: { deviceId: string; json: string }) => void;
};

declare class LiftLogGarminModule extends NativeModule<GarminEvents> {
  initialize(): Promise<string>;
  getDevices(): Promise<{ id: string; name: string; status: string }[]>;
  send(deviceId: string, json: string): Promise<string>;
}

/** Undefined where the module is not built in (iOS, tests): watch sync is Android-only. */
export function getGarminModule() {
  return requireOptionalNativeModule<LiftLogGarminModule>('LiftLogGarmin') ?? undefined;
}

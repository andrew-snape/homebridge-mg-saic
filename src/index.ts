import type { API } from 'homebridge';
import { MgSaicPlatform } from './platform.js';

const PLATFORM_NAME = 'MgSaic';

/** @param api homebridge API passed from the Homebridge runtime */
export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, MgSaicPlatform);
};

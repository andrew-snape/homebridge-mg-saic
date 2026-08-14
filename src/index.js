import { MgSaicPlatform } from './platform.js';

const PLATFORM_NAME = 'MgSaic';

/** @param {import('homebridge').API} api */
export default (api) => {
  api.registerPlatform(PLATFORM_NAME, MgSaicPlatform);
};

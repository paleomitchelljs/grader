/**
 * OpenCV.js async loader.
 *
 * @techstark/opencv-js ships a WASM build that initializes asynchronously.
 * Consumers must await cvReady() before calling any cv.* function.
 *
 * We expose a lazily-awaited Promise so that the library only starts
 * initializing the first time it's actually needed — the upload panel
 * doesn't need it, only processing does.
 */

import cv from '@techstark/opencv-js';

let readyPromise: Promise<typeof cv> | null = null;

export function cvReady(): Promise<typeof cv> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve) => {
    // @techstark/opencv-js triggers onRuntimeInitialized once WASM is loaded.
    // If the runtime has already initialized (e.g. hot-reloaded), the hook
    // won't fire — detect that by probing for a known symbol.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyCv = cv as any;
    if (anyCv.Mat && typeof anyCv.Mat === 'function') {
      resolve(cv);
      return;
    }
    anyCv.onRuntimeInitialized = () => resolve(cv);
  });
  return readyPromise;
}

export { cv };

/**
 * OpenCV.js async loader.
 *
 * @techstark/opencv-js ships a WASM build that initializes asynchronously.
 * Consumers must await cvReady() before calling any cv.* function.
 */

import cv from '@techstark/opencv-js';

let readyPromise: Promise<typeof cv> | null = null;

export function cvReady(): Promise<typeof cv> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve) => {
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

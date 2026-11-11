import type { View } from "./state";

/**
 * Functions of app.ts that lower modules call back into. applyView and showMessage reach into nearly every module,
 * and those modules navigate or link to messages, so importing them would make import cycles; app.ts binds the real
 * functions at load, before anything can call them.
 */
export const hooks = {
  applyView: (_view: View): void => {},
  showMessage: (_seq: number): Promise<void> => Promise.resolve(),
};

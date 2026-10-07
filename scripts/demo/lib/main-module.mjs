import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isMainModule(importMetaUrl, argv1) {
  if (argv1 === undefined) return false;
  return importMetaUrl === pathToFileURL(resolve(argv1)).href;
}

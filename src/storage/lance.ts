import { createRequire } from 'node:module';

// Build-only vendor copy: unmodified LanceDB JS, without its optional embedding
// SDK dependency graph. Native binaries remain normal platform-filtered packages.
const require = createRequire(import.meta.url);
const lance = require('../vendor/lancedb/dist/index.js') as typeof import('@lancedb/lancedb');
export default lance;

/**
 * The embedding space, for results to load when they first show it. The package's UI exports
 * `EmbeddingSpace.tsx` as well, and a bundler leaves a module in its importer's chunk when it is
 * imported both ways, so results import it through this module instead.
 *
 * @module
 */

export { EmbeddingSpaceView } from './EmbeddingSpace.tsx';

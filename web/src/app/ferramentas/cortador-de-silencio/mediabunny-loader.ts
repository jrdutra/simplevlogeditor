/**
 * The silence cutter's view of the shared media toolkit loader.
 *
 * The implementation moved to `services/mediabunny` once a second tool needed
 * it: both must resolve the *same* dynamic import, or the browser would parse
 * and hold two copies of a very large library. This file stays so the tool's
 * own imports keep reading as local.
 */
export { loadMediabunny, type MediabunnyLib } from '../../services/mediabunny/mediabunny-loader';

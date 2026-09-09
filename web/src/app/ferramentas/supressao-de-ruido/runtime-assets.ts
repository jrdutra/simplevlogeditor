/**
 * Fetching the two files this tool cannot work without, and saying what went
 * wrong when one of them does not arrive.
 *
 * Both are ordinary static files served by this site: the ONNX Runtime binary
 * and the model's weights. Neither is fetched from anywhere else, and no server
 * does any of the work — but "the file is not published" and "the file is
 * corrupt" and "the network is down" all reach the runtime as the same
 * exception, and the words it uses for it are its own.
 *
 * The worst case is the quiet one. A single-page site answers a request for a
 * file it does not have with its own `index.html` and a 200, because that is how
 * client-side routing works. The runtime then tries to compile an HTML page as
 * WebAssembly and reports a bad magic word, which is true and useless. Checking
 * here means the reader is told the file is missing, which is the actual fault
 * and the thing they can fix.
 */

/** `\0asm`, the first four bytes of every WebAssembly binary. */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

/** `\x08`, the first byte of the ONNX protobuf these models are stored as. */
const ONNX_MAGIC = [0x08];

export interface AssetProblem {
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  bytes: number;
  /** The first bytes, as hex and as text, so the reader can see what came. */
  head: string;
  /** What it looks like, in one sentence a person can act on. */
  diagnosis: string;
}

export class AssetError extends Error {
  constructor(message: string, readonly problem: AssetProblem) {
    super(message);
    this.name = 'AssetError';
  }
}

function describe(bytes: Uint8Array): string {
  const hex = [...bytes.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  const text = [...bytes.subarray(0, 24)]
    .map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '·'))
    .join('');
  return `${hex} (${text})`;
}

/**
 * Reads a static file and checks it is the kind of file it should be.
 *
 * The check is the first few bytes, not the content type: a server that is
 * serving the wrong thing is usually mislabelling it as well.
 */
export async function fetchAsset(
  url: string,
  what: string,
  magic: readonly number[],
  options: { whole?: boolean } = {}
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'force-cache' });
  } catch (error) {
    throw new AssetError(
      `${what} could not be downloaded from this site.`,
      {
        url,
        status: 0,
        statusText: error instanceof Error ? error.message : String(error),
        contentType: '',
        bytes: 0,
        head: '',
        diagnosis: 'The request never completed. The connection dropped, or something is blocking it.'
      }
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  const declared = Number(response.headers.get('content-length')) || 0;

  if (!response.ok) {
    throw new AssetError(`${what} is missing from this site.`, {
      url,
      status: response.status,
      statusText: response.statusText,
      contentType,
      bytes: 0,
      head: '',
      diagnosis:
        response.status === 404
          ? 'The file is not there. It is copied out of node_modules by the assets section of angular.json — check that the build ran after that entry was added, and that the deployed folder is the one it produced.'
          : 'The server refused the request.'
    });
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // A file can arrive with the right first bytes and still be half a file.
  if (declared && bytes.length !== declared) {
    throw new AssetError(`${what} arrived incomplete.`, {
      url,
      status: response.status,
      statusText: response.statusText,
      contentType,
      bytes: bytes.length,
      head: describe(bytes),
      diagnosis: `The server said the file is ${declared.toLocaleString('en')} bytes and ` +
        `${bytes.length.toLocaleString('en')} arrived. The connection dropped part way, or something between here and ` +
        'the server truncated it.'
    });
  }

  const matches = magic.every((byte, index) => bytes[index] === byte);
  if (!matches) {
    const looksLikeHtml = bytes[0] === 0x3c; // '<'
    throw new AssetError(`${what} is not the file this site returned.`, {
      url,
      status: response.status,
      statusText: response.statusText,
      contentType,
      bytes: bytes.length,
      head: describe(bytes),
      diagnosis: looksLikeHtml
        ? 'An HTML page came back instead of the file — which is what a single-page site returns for a path it does not have, with a 200 rather than a 404. The file was not published: check the assets section of angular.json, that the build ran after it changed, and that what is deployed is that build.'
        : 'The first bytes are not the ones this kind of file starts with. It arrived truncated or corrupted, or something rewrote it in transit.'
    });
  }

  // The strongest check there is for the runtime, and the only one that catches
  // a binary that is genuinely a WebAssembly module but not a whole one. This
  // is not hypothetical: an interrupted `npm install` leaves exactly that in
  // node_modules, the build copies it out without complaint, and the runtime
  // then fails at the far end with "Unknown Exception", which says nothing.
  if (options.whole && typeof WebAssembly !== 'undefined' && !WebAssembly.validate(bytes)) {
    throw new AssetError(`${what} is not a complete WebAssembly module.`, {
      url,
      status: response.status,
      statusText: response.statusText,
      contentType,
      bytes: bytes.length,
      head: describe(bytes),
      diagnosis:
        'The file starts like a WebAssembly binary but does not parse as one, so it is truncated or corrupt. ' +
        'It is copied out of node_modules at build time — reinstall onnxruntime-web (an interrupted install leaves ' +
        'a half-written binary behind, and the build copies it without noticing), then build and deploy again.'
    });
  }

  return bytes;
}

/**
 * The version the runtime binary was built as, if it says.
 *
 * The runtime is two halves of one build: a WebAssembly binary served as a
 * static file, and the JavaScript that drives it, bundled into the app from
 * `node_modules`. They speak a private calling convention that changes between
 * releases, so a binary from a different version links without complaint — the
 * exports line up — and then fails at the far end with "Unknown Exception",
 * which is the runtime's way of saying a C++ exception reached it with nothing
 * attached. Comparing the versions first turns that into a sentence.
 *
 * ONNX Runtime writes its version into the module's data exactly once, and
 * nothing else in the binary is shaped like a version number, so the first
 * `digits.digits.digits` in it is the version.
 */
export function binaryVersion(bytes: Uint8Array): string | undefined {
  const digit = (at: number) => bytes[at] !== undefined && bytes[at]! >= 0x30 && bytes[at]! <= 0x39;
  const dot = (at: number) => bytes[at] === 0x2e;
  const run = (at: number) => {
    let end = at;
    while (digit(end)) end++;
    return end;
  };

  for (let at = 0; at < bytes.length; at++) {
    // Start of a number, not the middle of a longer one.
    if (!digit(at) || digit(at - 1) || dot(at - 1)) continue;

    const first = run(at);
    if (!dot(first)) continue;
    const second = run(first + 1);
    if (second === first + 1 || !dot(second)) continue;
    const third = run(second + 1);
    if (third === second + 1) continue;

    return String.fromCharCode(...bytes.subarray(at, third));
  }

  return undefined;
}

/** One line carrying everything worth knowing, for the message on screen. */
export function explain(problem: AssetProblem): string {
  const parts = [
    problem.diagnosis,
    `URL: ${problem.url}`,
    `HTTP ${problem.status}${problem.statusText ? ` ${problem.statusText}` : ''}`
  ];
  if (problem.contentType) parts.push(`Content-Type: ${problem.contentType}`);
  if (problem.bytes) parts.push(`${problem.bytes.toLocaleString('en')} bytes received`);
  if (problem.head) parts.push(`First bytes: ${problem.head}`);
  return parts.join(' · ');
}

export const RUNTIME_MAGIC = WASM_MAGIC;
export const MODEL_MAGIC = ONNX_MAGIC;

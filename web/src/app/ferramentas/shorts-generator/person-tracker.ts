import { loadMediabunny } from '../../services/mediabunny/mediabunny-loader';
import type { HumanFace, HumanObject } from '../../vendor/human/human.esm.js';
import { PersonDetector, TrackingStage } from './person-detector';

/** One point of a tracked framing: `t` in seconds of the source video, `x` the framing (0 left, 1 right). */
export interface CropKey { t: number; x: number; }

/** Frames looked at per second. Five follow a person walking and keep a minute of video to a few hundred detections. */
const SAMPLES_PER_SECOND = 5;
/** Width the frames are analysed at. */
const ANALYSIS_WIDTH = 640;
/** Samples on either side that decide who is speaking (about a second in all). */
const SPEECH_WINDOW = 3;
/** Mouth movement below this is somebody listening, not speaking (share of the face's height per sample). */
const SPEAKING_FLOOR = 0.012;
/** How much more a new face must be speaking before the framing leaves the current one. */
const SWITCH_MARGIN = 1.5;
/** Largest distance, as a share of the width, a face may move between two samples and still be the same face. */
const SAME_FACE_DISTANCE = 0.12;
/** Framing changes smaller than this are not kept as points of their own. */
const SIMPLIFY_TOLERANCE = 0.006;
/**
 * How long nobody may be seen before the tracking counts as lost and the frame
 * goes back to the cut's own framing. Just over one sample, so a single frame
 * where the detector misses the person does not send the frame away and back.
 */
const LOST_AFTER_SECONDS = 1.5 / SAMPLES_PER_SECOND;

/** A decoder/read failure must not leave the dialog waiting forever either. */
function readVideo<T>(task: Promise<T>, cancelled: () => boolean, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Reading the video timed out. Try a shorter cut or another video.')), 30000);
    const poll = setInterval(() => { if (cancelled()) finish(new Error('Tracking cancelled.')); }, 100);
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(poll);
      if (error) reject(error); else resolve(value!);
    };
    task.then(value => settled ? discard?.(value) : finish(undefined, value), error => finish(error));
  });
}

export interface FaceSeen { cx: number; size: number; open: number; track: number; }
export interface Sample { t: number; faces: FaceSeen[]; people: { cx: number; size: number }[]; }

/** What the tracker saw in one stretch: enough to draw a new path without looking at the video again. */
export interface PersonAnalysis { visible: number; samples: Sample[]; }

/** How the frame moves: optional waits before it changes person, and how gently it travels. */
export interface FollowOptions {
  /** Off: the frame changes person the moment the choice changes. On: the two waits below apply. */
  delays: boolean;
  /** How long a new person must be the choice before the frame goes to them, in milliseconds. */
  startDelayMs: number;
  /** How long the frame stays with a person after the choice has left them, in milliseconds. */
  holdDelayMs: number;
  smoothness: FollowSmoothness;
}
export type FollowSmoothness = 'abrupt' | 'slight' | 'smooth' | 'very';
export const DEFAULT_FOLLOW: FollowOptions = { delays: false, startDelayMs: 100, holdDelayMs: 100, smoothness: 'smooth' };
/** Seconds the frame takes to settle on a new position, by level. */
const SMOOTHING_SECONDS: Record<FollowSmoothness, number> = { abrupt: 0, slight: .15, smooth: .4, very: .9 };
/** The path is worked out at this rate, so waits of a tenth of a second are honoured. */
const PATH_RATE = 20;

/**
 * Follows a person through one stretch of a video and returns how the vertical
 * frame should move to keep them in it.
 *
 * In order: a face; when there are several, the face that is speaking (its
 * mouth is the one moving); when no face can be seen — a person with their back
 * to the camera — their body. The frame never runs past the edge of the
 * picture, so the short never shows anything that is not video.
 */
export async function trackPerson(
  file: File, start: number, end: number,
  onProgress: (share: number) => void = () => undefined,
  cancelled: () => boolean = () => false,
  options: FollowOptions = DEFAULT_FOLLOW
): Promise<CropKey[]> {
  const analysis = await analysePeople(file, start, end, onProgress, cancelled);
  return cancelled() ? [] : followPath(analysis, options);
}

/** Looks at the stretch: faces, their mouths, and bodies, a few times a second. The slow part. */
export async function analysePeople(
  file: File, start: number, end: number,
  onProgress: (share: number) => void = () => undefined,
  cancelled: () => boolean = () => false,
  onStage: (stage: TrackingStage) => void = () => undefined
): Promise<PersonAnalysis> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < .1) throw new Error('Invalid tracking interval.');
  onStage('loading');
  const library = await readVideo(loadMediabunny(), cancelled);
  const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });
  const detector = new PersonDetector(cancelled, onStage);
  try {
    const track = await readVideo(input.getPrimaryVideoTrack(), cancelled);
    if (!track || !await readVideo(track.canDecode(), cancelled)) throw new Error('This video cannot be decoded here.');
    const width = await track.getDisplayWidth(), height = await track.getDisplayHeight();
    // The share of the picture's width a 9:16 frame of its full height shows.
    const visible = Math.min(1, (height * 9 / 16) / width);
    if (visible >= .999) return { visible, samples: [{ t: start, faces: [], people: [] }] };
    if (cancelled()) return { visible, samples: [] };

    const times: number[] = [];
    const lastTime = end - .001;
    // Floating-point steps can land just before `end`; appending end-.001
    // after that would make time go backwards and produce an invalid path.
    for (let t = start; t < lastTime; t += 1 / SAMPLES_PER_SECOND) times.push(t);
    times.push(lastTime);
    const canvas = document.createElement('canvas');
    canvas.width = ANALYSIS_WIDTH; canvas.height = Math.max(2, Math.round(ANALYSIS_WIDTH * height / width));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('The analysis canvas could not be prepared.');

    const samples: Sample[] = [];
    const tracks: { id: number; cx: number; t: number }[] = [];
    let index = 0, decoded = 0;
    const sink = new library.VideoSampleSink(track);
    const frames = sink.samplesAtTimestamps(times);
    while (true) {
      const item = await readVideo(frames.next(), cancelled, item => { if (!item.done) item.value?.close(); });
      if (item.done) break;
      const frame = item.value;
      const t = times[index++];
      if (cancelled()) { frame?.close(); return { visible, samples: [] }; }
      if (!frame) { samples.push({ t, faces: [], people: [] }); onProgress(index / times.length); continue; }
      decoded++;
      try { frame.draw(context, 0, 0, canvas.width, canvas.height); } finally { frame.close(); }
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = await detector.detect(pixels);
      const faces = (result.face || []).filter(face => (face.faceScore ?? face.boxScore ?? face.score) >= .5).map(face => measureFace(face, canvas.width));
      let people: { cx: number; size: number }[] = [];
      if (!faces.length) {
        // No face: a person seen from behind or from afar is found by their body instead.
        const bodies = await detector.detect(pixels, true);
        people = (bodies.object || []).filter((item: HumanObject) => item.label === 'person' && item.score >= .35)
          .map((item: HumanObject) => ({ cx: (item.box[0] + item.box[2] / 2) / canvas.width, size: item.box[2] * item.box[3] / (canvas.width * canvas.height) }));
      }
      // The same face from one sample to the next is the nearest one that has not moved too far.
      const assigned = new Set<number>();
      for (const face of faces) {
        let best: { id: number; cx: number; t: number } | undefined;
        for (const known of tracks) {
          if (assigned.has(known.id) || t - known.t > 1.2 || Math.abs(known.cx - face.cx) > SAME_FACE_DISTANCE) continue;
          if (!best || Math.abs(known.cx - face.cx) < Math.abs(best.cx - face.cx)) best = known;
        }
        if (!best) { best = { id: tracks.length, cx: face.cx, t }; tracks.push(best); }
        best.cx = face.cx; best.t = t; face.track = best.id; assigned.add(best.id);
      }
      samples.push({ t, faces, people });
      onProgress(index / times.length);
      // Lets the page breathe between detections.
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (!decoded) throw new Error('No video frames could be read in this cut.');
    return { visible, samples };
  } finally { detector.dispose(); input.dispose(); }
}

/**
 * The frame's path from an analysis, under the chosen waits and smoothness.
 * Cheap: changing a setting redraws the path without looking at the video again.
 *
 * `rest` is the cut's own framing (0 left, 1 right), the one chosen by hand.
 * While nobody can be seen — before the person first appears, and whenever the
 * tracking loses them — the frame goes back there, as gently as the chosen
 * smoothness, and it comes back to the person when they are found again. With
 * the waits on, the hold wait also applies before the frame leaves a person it
 * lost, and the start wait before it goes to one found again. Without `rest`
 * the frame stays where the person was last seen.
 */
export function followPath(analysis: PersonAnalysis, options: FollowOptions = DEFAULT_FOLLOW, rest = NaN): CropKey[] {
  const { samples, visible } = analysis;
  if (!samples.length) return [];
  if (visible >= .999) return [{ t: samples[0].t, x: .5 }];
  const choices = chooseSubjects(samples);
  // Each sample stands for the moments up to the next one; the path is worked out finely enough for the waits.
  const first = samples[0].t, last = samples[samples.length - 1].t;
  const steps = Math.max(1, Math.round((last - first) * PATH_RATE));
  const startWait = options.delays ? Math.max(0, options.startDelayMs) / 1000 : 0;
  const holdWait = options.delays ? Math.max(0, options.holdDelayMs) / 1000 : 0;
  const resting = Number.isFinite(rest), restX = Math.max(0, Math.min(1, rest));
  const lostAfter = Math.max(LOST_AFTER_SECONDS, holdWait);
  let index = 0, followed: string | null = null, followedCx = NaN, everFollowed = false, lastSeen = -Infinity;
  let candidate: string | null = null, candidateSince = first, lastChosenFollowed = first;
  const raw: CropKey[] = [], lost: boolean[] = [];
  for (let step = 0; step <= steps; step++) {
    const t = first + (step / steps) * (last - first);
    while (index + 1 < samples.length && samples[index + 1].t <= t + 1e-6) index++;
    const choice = choices[index];
    // Nobody seen for long enough: the person is let go of and the frame goes back to the cut's own framing.
    if (choice.subject !== null) lastSeen = t;
    else if (resting && followed !== null && t - lastSeen >= lostAfter - 1e-6) { followed = null; candidate = null; }
    if (choice.subject === followed) { lastChosenFollowed = t; candidate = null; }
    else if (choice.subject !== candidate) { candidate = choice.subject; candidateSince = t; }
    // A new person is taken once they have been the choice for the start wait,
    // and only after the current one has been let go of for the hold wait.
    // The first person of the cut is taken at once.
    const ready = followed === null
      ? !everFollowed || t - candidateSince >= startWait - 1e-6
      : t - candidateSince >= startWait - 1e-6 && t - lastChosenFollowed >= holdWait - 1e-6;
    if (candidate !== null && followed !== candidate && ready) {
      followed = candidate; candidate = null; lastChosenFollowed = t; everFollowed = true;
    }
    let seen = choice.subject === followed && Number.isFinite(choice.cx) ? choice.cx
      : followed ? positionOf(samples[index], followed) : NaN;
    // Between two samples of the same person the frame glides; it only jumps when it changes person.
    const next = choices[index + 1];
    if (Number.isFinite(seen) && next && next.subject === followed && Number.isFinite(next.cx)) {
      const share = (t - samples[index].t) / Math.max(1e-6, samples[index + 1].t - samples[index].t);
      seen += (next.cx - seen) * Math.max(0, Math.min(1, share));
    }
    if (Number.isFinite(seen)) followedCx = seen;
    raw.push({ t, x: followedCx });
    lost.push(resting && followed === null);
  }
  const known = raw.find(key => Number.isFinite(key.x))?.x ?? .5;
  const framed = raw.map(key => ({ t: key.t, x: frameFor(Number.isFinite(key.x) ? key.x : known, visible) }));
  const seconds = SMOOTHING_SECONDS[options.smoothness] ?? SMOOTHING_SECONDS.smooth;
  const followedPath = smooth(framed, seconds);
  if (!lost.some(Boolean)) return simplify(followedPath.map(round));
  // Going back to the cut's framing starts the moment the person is lost, and
  // coming back to them the moment they are found: the blend between the two
  // only looks back, so the frame never leaves a person before they are gone.
  // Two gentle steps of half the level's time each: the frame sets off softly and settles in about the same time.
  const alpha = seconds > 0 ? 1 - Math.exp(-(1 / PATH_RATE) / (seconds / 2)) : 1;
  let eased = lost[0] ? 1 : 0, weight = eased;
  return simplify(followedPath.map((key, i) => {
    if (i > 0) { eased += alpha * ((lost[i] ? 1 : 0) - eased); weight += alpha * (eased - weight); }
    return round({ t: key.t, x: key.x + (restX - key.x) * weight });
  }));
}

function measureFace(face: HumanFace, canvasWidth: number): FaceSeen {
  const [x, , w, h] = face.box;
  const upper = face.mesh?.[13], lower = face.mesh?.[14];
  const open = upper && lower && h > 0 ? Math.abs(lower[1] - upper[1]) / h : NaN;
  return { cx: (x + w / 2) / canvasWidth, size: w / canvasWidth, open, track: -1 };
}

/** How much a face's mouth is moving around sample `index`: the speaker's does, a listener's does not. */
function speaking(samples: Sample[], index: number, trackId: number): number {
  let total = 0, count = 0, previous = NaN;
  for (let i = Math.max(0, index - SPEECH_WINDOW); i <= Math.min(samples.length - 1, index + SPEECH_WINDOW); i++) {
    const open = samples[i].faces.find(face => face.track === trackId)?.open ?? NaN;
    if (Number.isFinite(open) && Number.isFinite(previous)) { total += Math.abs(open - previous); count++; }
    previous = open;
  }
  return count ? total / count : 0;
}

/** Who to follow, sample by sample: a face (`face:N`), a body (`body`), or nobody; and where they are. */
function chooseSubjects(samples: Sample[]): { subject: string | null; cx: number }[] {
  const choices: { subject: string | null; cx: number }[] = [];
  let current = -1, target = NaN;
  samples.forEach((sample, index) => {
    if (sample.faces.length) {
      const scored = sample.faces.map(face => ({ face, score: speaking(samples, index, face.track) }));
      const held = scored.find(item => item.face.track === current);
      const loudest = scored.reduce((best, item) => item.score > best.score ? item : best, scored[0]);
      let chosen = held;
      if (!held || (loudest !== held && loudest.score >= SPEAKING_FLOOR && loudest.score > SWITCH_MARGIN * held.score)) {
        chosen = loudest.score >= SPEAKING_FLOOR ? loudest
          : Number.isFinite(target)
            ? scored.reduce((best, item) => Math.abs(item.face.cx - target) < Math.abs(best.face.cx - target) ? item : best, scored[0])
            : scored.reduce((best, item) => item.face.size > best.face.size ? item : best, scored[0]);
      }
      current = chosen!.face.track; target = chosen!.face.cx;
      choices.push({ subject: `face:${current}`, cx: target });
    } else if (sample.people.length) {
      // The body closest to where the face was, so a person who turns away keeps the frame.
      const person = Number.isFinite(target)
        ? sample.people.reduce((best, item) => Math.abs(item.cx - target) < Math.abs(best.cx - target) ? item : best, sample.people[0])
        : sample.people.reduce((best, item) => item.size > best.size ? item : best, sample.people[0]);
      target = person.cx;
      choices.push({ subject: 'body', cx: target });
    } else choices.push({ subject: null, cx: NaN });
  });
  return choices;
}

/** Where a subject is in one sample, if it can be seen there. */
function positionOf(sample: Sample, subject: string): number {
  if (subject.startsWith('face:')) return sample.faces.find(face => `face:${face.track}` === subject)?.cx ?? NaN;
  return NaN;
}

/** The framing that puts `centre` in the middle, stopped at the edges of the picture. */
function frameFor(centre: number, visible: number): number {
  const left = Math.max(0, Math.min(1 - visible, centre - visible / 2));
  return left / (1 - visible);
}

/** Steady, without lag: smoothing run forwards and backwards, as gentle as the chosen level. None for "abrupt". */
function smooth(keys: CropKey[], seconds: number): CropKey[] {
  if (seconds <= 0 || keys.length < 3) return keys;
  const alpha = 1 - Math.exp(-(1 / PATH_RATE) / seconds);
  const forward = [...keys];
  for (let i = 1; i < forward.length; i++) forward[i] = { t: forward[i].t, x: forward[i - 1].x + alpha * (forward[i].x - forward[i - 1].x) };
  const both = [...forward];
  for (let i = both.length - 2; i >= 0; i--) both[i] = { t: both[i].t, x: both[i + 1].x + alpha * (both[i].x - both[i + 1].x) };
  return both;
}

/** A point as it is kept: milliseconds and a ten-thousandth of the travel, inside the picture. */
function round(key: CropKey): CropKey {
  return { t: Math.round(key.t * 1000) / 1000, x: Math.round(Math.max(0, Math.min(1, key.x)) * 10000) / 10000 };
}

/** Only the points that change the path: straight stretches become their two ends. */
function simplify(keys: CropKey[]): CropKey[] {
  if (keys.length < 3) return keys;
  const keep = new Uint8Array(keys.length);
  keep[0] = keep[keys.length - 1] = 1;
  const stack: [number, number][] = [[0, keys.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    let worst = -1, distance = 0;
    for (let i = from + 1; i < to; i++) {
      const share = (keys[i].t - keys[from].t) / Math.max(1e-6, keys[to].t - keys[from].t);
      const gap = Math.abs(keys[i].x - (keys[from].x + share * (keys[to].x - keys[from].x)));
      if (gap > distance) { distance = gap; worst = i; }
    }
    if (worst > 0 && distance > SIMPLIFY_TOLERANCE) { keep[worst] = 1; stack.push([from, worst], [worst, to]); }
  }
  return keys.filter((_, i) => keep[i]);
}

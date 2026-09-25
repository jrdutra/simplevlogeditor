/**
 * The lettering a generated cover copies.
 *
 * Each entry is a real sheet of tags drawn in that style, shipped with the
 * editor. The picture is what the image generator is actually handed; the
 * description is a fallback for a generator that only reads words, and a label
 * for the picker. The words on the sheets are examples, never content: a cover
 * copies the letterforms, not the sentences.
 */
export interface TagStyleOption {
  id: string;
  name: string;
  /** One line under the name in the picker. */
  summary: string;
  /** Enough for a generator that cannot look at the sheet. */
  description: string;
  url: string;
}

const asset = (slug: string) => `/assets/tag-styles/tag-style-${slug}.png`;

/** The style used whenever nobody has chosen another one. */
export const DEFAULT_TAG_STYLE_ID = 'classic';

export const TAG_STYLES: readonly TagStyleOption[] = [
  {
    id: 'classic',
    name: 'Classic',
    summary: 'Red, black and yellow torn blocks',
    description:
      'Bold condensed uppercase sans-serif in white with a heavy dark outline, sitting on torn brush-stroke '
      + 'blocks of red, black and yellow, stacked over two or three short lines, with an optional smaller '
      + 'highlighted word underneath on a yellow block. High contrast, slight rotation, no thin type.',
    url: asset('classic')
  },
  {
    id: 'travel',
    name: 'Travel',
    summary: 'Teal and orange brush blocks with travel icons',
    description:
      'Rounded heavy uppercase sans-serif, white on a teal brush block over a second line in dark navy on an '
      + 'orange block, with a thick navy outline and a small travel illustration (plane, suitcase, map pin, '
      + 'globe) tucked against the right edge and little orange spark marks around it.',
    url: asset('travel')
  },
  {
    id: 'neon-blue',
    name: 'Neon Blue',
    summary: 'Chrome over glowing cyan',
    description:
      'Compact uppercase sans-serif, the first line in brushed silver-white and the second in bright cyan, '
      + 'both with a black outline and a strong blue neon glow spreading behind the whole block. No panel, '
      + 'just the glow on a transparent background.',
    url: asset('neon-blue')
  },
  {
    id: 'neon-pink',
    name: 'Neon Pink',
    summary: 'Chrome over glowing magenta',
    description:
      'The same compact uppercase treatment as Neon Blue with the second line in hot pink and a magenta neon '
      + 'glow behind the block: silver-white top line, black outline, no panel.',
    url: asset('neon-pink')
  },
  {
    id: 'promo-gold',
    name: 'Promo Gold',
    summary: 'Silver and gold on a red edge',
    description:
      'Heavy uppercase sans-serif, the first line in brushed silver and the second in gold, both outlined in '
      + 'black and sitting on a thick red rim that traces the whole block. Loud retail-promo energy.',
    url: asset('promo-gold')
  },
  {
    id: 'pastel',
    name: 'Pastel Vlog',
    summary: 'Soft painted strokes and cute doodles',
    description:
      'Friendly rounded sans-serif, white or near-black, on soft painted pastel strokes — coral, sky blue, '
      + 'mint, butter yellow, lilac — with a white sticker outline and small hand-drawn doodles (hearts, '
      + 'leaves, a coffee cup, a sun). Calm and warm, never shouty.',
    url: asset('pastel')
  },
  {
    id: 'home-classic',
    name: 'Home Classic',
    summary: 'Red, black and yellow with emoji',
    description:
      'The Classic torn-block treatment applied to household and routine words, with a colour emoji sitting '
      + 'beside the text and small yellow spark marks. White condensed uppercase, red and black brush blocks, '
      + 'a yellow block for the secondary line.',
    url: asset('home-classic')
  },
  {
    id: 'action-red',
    name: 'Action Red',
    summary: 'Italic chrome over a fiery streak',
    description:
      'Italic heavy uppercase, the first line in brushed chrome and the second in orange-to-red gradient, both '
      + 'outlined in black, riding on a streak of red and orange motion light. Fast and aggressive.',
    url: asset('action-red')
  },
  {
    id: 'action-gold',
    name: 'Action Gold',
    summary: 'Italic chrome over a green-gold streak',
    description:
      'The Action treatment with the second line in a yellow-to-gold gradient over a green and gold motion '
      + 'streak. Chrome top line, black outline, strong forward slant.',
    url: asset('action-gold')
  },
  {
    id: 'action-blue',
    name: 'Action Blue',
    summary: 'Italic chrome over a blue streak',
    description:
      'The Action treatment with the second line in a cyan-to-blue gradient over a blue motion streak. Chrome '
      + 'top line, black outline, strong forward slant.',
    url: asset('action-blue')
  },
  {
    id: 'home-teal',
    name: 'Home Teal',
    summary: 'Teal and coral brush blocks with emoji',
    description:
      'Heavy uppercase on torn brush blocks of teal, deep navy and coral, white or navy lettering with a thick '
      + 'navy outline, a colour emoji beside the text and coral spark marks. The calmer cousin of Home Classic.',
    url: asset('home-teal')
  },
  {
    id: 'cartoon-gold',
    name: 'Cartoon Gold',
    summary: 'White and gold 3D cartoon letters',
    description:
      'Chunky rounded heavy uppercase, the first line in glossy white-to-grey and the second in a '
      + 'yellow-to-orange gradient, both extruded into a thick black 3D block with a soft shadow and a slight '
      + 'tilt, usually ending in an exclamation or question mark. Playful and loud, no panel behind the '
      + 'words.',
    url: asset('cartoon-gold')
  },
  {
    id: 'marker-yellow',
    name: 'Marker Yellow',
    summary: 'White over a yellow highlighter stroke',
    description:
      'Tall condensed bold uppercase: the first line in off-white on a dark smudged brush patch, the second '
      + 'line in black on a rough yellow highlighter stroke, with a gritty, printed texture and a question '
      + 'mark in yellow when it asks something. Punchy and editorial.',
    url: asset('marker-yellow')
  },
  {
    id: 'purple-chrome',
    name: 'Purple Chrome',
    summary: 'Chrome and violet with a caption bar',
    description:
      'Tall compressed uppercase, the first line in brushed chrome-white and a larger second line in a '
      + 'violet-to-purple gradient, both with a soft purple glow, over a thin dark-purple bar holding a '
      + 'small, widely letter-spaced caption in white. Premium, \'make money online\' energy.',
    url: asset('purple-chrome')
  },
  {
    id: 'sports',
    name: 'Sports',
    summary: 'Italic white and yellow on navy, with icons',
    description:
      'Italic heavy condensed uppercase mixing white and bright yellow words, wrapped in a thick deep-navy '
      + 'sticker outline, with a small flat sports icon beside the text (a football, trophy, microphone, '
      + 'whistle, calendar or play button). Broadcast and football-channel feel.',
    url: asset('sports')
  },
  {
    id: 'red-speed',
    name: 'Red Speed',
    summary: 'Italic red over chrome with a red streak',
    description:
      'Italic heavy uppercase, the first line in glossy red and the second in brushed chrome-white, both '
      + 'outlined in black and slanted forward, over a glowing red neon slash and motion streak. Vlog and '
      + 'reality-show energy.',
    url: asset('red-speed')
  },
  {
    id: 'news-blocks',
    name: 'News Blocks',
    summary: 'Three stacked blocks: white, red, black',
    description:
      'Condensed bold uppercase stacked on three straight rectangular blocks, slightly offset: black text '
      + 'on a white block, white text on a bright red block, white text on a black block, with a faint red '
      + 'glow around them. Clean, headline-like, very readable.',
    url: asset('news-blocks')
  },
  {
    id: 'torn-stack',
    name: 'Torn Stack',
    summary: 'Three torn brush blocks: white, red, black',
    description:
      'The News Blocks stack drawn with torn brush-stroke edges instead of straight ones: black on a rough '
      + 'white stroke, white on a red stroke, white on a black stroke, with a slight tilt and a dark outline '
      + 'around the whole sticker. Raw, handmade storytelling feel.',
    url: asset('torn-stack')
  },
  {
    id: 'lime-pop',
    name: 'Lime Pop',
    summary: 'White and lime over a red pill',
    description:
      'Rounded heavy uppercase tilted upwards: the first line in white, the second in bright lime-yellow, '
      + 'and a third short line in white on a red pill, all with a thick dark outline and a lime glow, '
      + 'finished with a curved lime underline swoosh. High-energy tech and YouTube-growth style.',
    url: asset('lime-pop')
  },
  {
    id: 'pixel-game',
    name: 'Pixel Game',
    summary: 'Pixel-art game signs',
    description:
      'Pixel-art lettering in white over a second line in a bright game colour (yellow, cyan, red, green or '
      + 'purple), with a dark pixel outline, set into a small pixel-art sign: grass and dirt blocks, stone, '
      + 'wooden planks, coins, torches, crystals or a treasure book. Retro video-game and gameplay-channel '
      + 'feel.',
    url: asset('pixel-game')
  }
];

export const TAG_STYLE_BY_ID = new Map(TAG_STYLES.map((style) => [style.id, style]));

export function tagStyleOf(id: string | null | undefined): TagStyleOption {
  return TAG_STYLE_BY_ID.get(String(id ?? '')) ?? TAG_STYLE_BY_ID.get(DEFAULT_TAG_STYLE_ID)!;
}

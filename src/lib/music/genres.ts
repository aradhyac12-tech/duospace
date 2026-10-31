/**
 * Browse-by-genre catalogue (Spotify "Browse all" / Apple Music "Browse").
 *
 * Each genre maps to:
 *  - `jamendoTag`: a Jamendo tag for the licensed, background-capable "Free Music" rail;
 *  - `query`: a search phrase for the mainstream rail (SoundCloud search).
 * Gradients are literal class strings so Tailwind's scanner keeps them.
 */
export interface Genre {
  id: string;
  label: string;
  emoji: string;
  gradient: string;
  jamendoTag: string;
  query: string;
  blurb: string;
}

export const GENRES: Genre[] = [
  { id: "pop",        label: "Pop",         emoji: "🎤", gradient: "bg-gradient-to-br from-pink-500 to-rose-700",       jamendoTag: "pop",        query: "pop hits",            blurb: "Big hooks and chart-ready songs" },
  { id: "indie",      label: "Indie",       emoji: "🎸", gradient: "bg-gradient-to-br from-amber-500 to-orange-700",    jamendoTag: "indie",      query: "indie music",         blurb: "Independent artists and fresh sounds" },
  { id: "hiphop",     label: "Hip-Hop",     emoji: "🎧", gradient: "bg-gradient-to-br from-violet-600 to-purple-900",   jamendoTag: "hiphop",     query: "hip hop",             blurb: "Beats, bars and bass" },
  { id: "rock",       label: "Rock",        emoji: "🤘", gradient: "bg-gradient-to-br from-red-600 to-stone-800",       jamendoTag: "rock",       query: "rock music",          blurb: "Guitars, drums and attitude" },
  { id: "electronic", label: "Electronic",  emoji: "🎛️", gradient: "bg-gradient-to-br from-cyan-500 to-blue-800",       jamendoTag: "electronic", query: "electronic music",    blurb: "Synths, club and future sounds" },
  { id: "dance",      label: "Dance",       emoji: "💃", gradient: "bg-gradient-to-br from-fuchsia-500 to-indigo-700",  jamendoTag: "dance",      query: "dance hits",          blurb: "Songs built for the floor" },
  { id: "lofi",       label: "Lo-fi",       emoji: "☕", gradient: "bg-gradient-to-br from-teal-500 to-emerald-800",    jamendoTag: "lofi",       query: "lofi beats",          blurb: "Soft beats to relax or study to" },
  { id: "chill",      label: "Chill",       emoji: "🌊", gradient: "bg-gradient-to-br from-sky-400 to-teal-700",        jamendoTag: "chillout",   query: "chill music",         blurb: "Slow down and breathe" },
  { id: "acoustic",   label: "Acoustic",    emoji: "🪕", gradient: "bg-gradient-to-br from-yellow-600 to-amber-900",    jamendoTag: "acoustic",   query: "acoustic songs",      blurb: "Unplugged and intimate" },
  { id: "rnb",        label: "R&B / Soul",  emoji: "🌹", gradient: "bg-gradient-to-br from-rose-600 to-fuchsia-900",    jamendoTag: "rnb",        query: "rnb soul",            blurb: "Smooth vocals and warm grooves" },
  { id: "jazz",       label: "Jazz",        emoji: "🎷", gradient: "bg-gradient-to-br from-blue-700 to-slate-900",      jamendoTag: "jazz",       query: "jazz music",          blurb: "Improvised, timeless, late-night" },
  { id: "classical",  label: "Classical",   emoji: "🎻", gradient: "bg-gradient-to-br from-stone-500 to-neutral-800",   jamendoTag: "classical",  query: "classical music",     blurb: "Orchestras, piano and strings" },
  { id: "ambient",    label: "Ambient",     emoji: "🌌", gradient: "bg-gradient-to-br from-indigo-500 to-slate-900",    jamendoTag: "ambient",    query: "ambient music",       blurb: "Atmospheres for focus and sleep" },
  { id: "folk",       label: "Folk",        emoji: "🍂", gradient: "bg-gradient-to-br from-lime-600 to-green-900",      jamendoTag: "folk",       query: "folk music",          blurb: "Stories told with strings" },
  { id: "metal",      label: "Metal",       emoji: "⚡", gradient: "bg-gradient-to-br from-zinc-600 to-black",          jamendoTag: "metal",      query: "metal music",         blurb: "Heavy riffs, full volume" },
  { id: "reggae",     label: "Reggae",      emoji: "🌴", gradient: "bg-gradient-to-br from-green-500 to-yellow-700",    jamendoTag: "reggae",     query: "reggae music",        blurb: "Sunny rhythm and good vibes" },
];

export const getGenre = (id: string): Genre | undefined => GENRES.find((g) => g.id === id);

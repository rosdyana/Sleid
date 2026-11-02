// reveal.js 5.x ships JavaScript only. These are the two ESM builds the present view imports.
declare module 'reveal.js/dist/reveal.esm.js' {
  const Reveal: unknown
  export default Reveal
}
declare module 'reveal.js/plugin/notes/notes.esm.js' {
  const RevealNotes: unknown
  export default RevealNotes
}

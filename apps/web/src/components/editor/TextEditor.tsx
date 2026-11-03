// TipTap editor used while a text box is being edited on the canvas.
// The content is committed once, when the editor loses focus or Escape is pressed.
import { useRef, type CSSProperties } from 'react'
import { EditorContent, Extension, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import type { RichText } from '@sleid/model'
import { TEXT_STYLE_ATTRS } from './text-style-attrs.ts'

// M10. Keeps the textStyle attributes the model stores (size, family, weight, letter spacing). TipTap's TextStyle mark
// drops any attribute no extension declares, so without this a text box loses those marks when it is edited.
const TextStyleAttrs = Extension.create({
  name: 'textStyleAttrs',
  addGlobalAttributes() {
    return [{ types: ['textStyle'], attributes: TEXT_STYLE_ATTRS }]
  },
})

export function TextEditor({
  content,
  style,
  headingFont,
  onCommit,
}: {
  content: RichText
  style: CSSProperties
  /** The theme's heading font stack. Headings in the box use it, as the renderer does. */
  headingFont?: string | undefined
  onCommit: (content: RichText) => void
}) {
  const committed = useRef(false)
  const commit = (json: RichText) => {
    if (committed.current) return
    committed.current = true
    onCommit(json)
  }
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false, underline: false }),
      TextStyle,
      TextStyleAttrs,
      Color,
      Underline,
      Link.configure({ openOnClick: false, autolink: false }),
    ],
    content,
    immediatelyRender: false,
    autofocus: 'end',
    onBlur: ({ editor: ed }) => commit(ed.getJSON() as RichText),
    editorProps: {
      attributes: { class: 'w-full outline-none sleid-rich-edit', 'aria-label': 'Edit text' },
      handleKeyDown: (view, event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          view.dom.blur()
          return true
        }
        return false
      },
    },
  })

  // The heading font is a CSS variable, read by the .sleid-rich-edit rules in styles.css.
  const boxStyle = { ...style, '--sleid-heading-font': headingFont } as CSSProperties
  return (
    <div className="w-full cursor-text bg-white/80 ring-2 ring-accent" style={boxStyle} onPointerDown={(e) => e.stopPropagation()}>
      <EditorContent editor={editor} className="w-full [&_.ProseMirror]:outline-none [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-[1.2em] [&_ol]:pl-[1.2em]" />
    </div>
  )
}

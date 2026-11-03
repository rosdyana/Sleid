// TipTap editor used while a text box is being edited on the canvas.
// The content is committed once, when the editor loses focus or Escape is pressed.
import { useRef, type CSSProperties } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import type { RichText } from '@sleid/model'

export function TextEditor({
  content,
  style,
  onCommit,
}: {
  content: RichText
  style: CSSProperties
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
      Color,
      Underline,
      Link.configure({ openOnClick: false, autolink: false }),
    ],
    content,
    immediatelyRender: false,
    autofocus: 'end',
    onBlur: ({ editor: ed }) => commit(ed.getJSON() as RichText),
    editorProps: {
      attributes: { class: 'h-full w-full outline-none', 'aria-label': 'Edit text' },
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

  return (
    <div className="h-full w-full cursor-text bg-white/80 ring-2 ring-accent" style={style} onPointerDown={(e) => e.stopPropagation()}>
      <EditorContent editor={editor} className="h-full w-full [&_.ProseMirror]:h-full [&_.ProseMirror]:outline-none [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-[1.2em] [&_ol]:pl-[1.2em]" />
    </div>
  )
}

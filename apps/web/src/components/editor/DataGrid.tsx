// Chart data as a mini spreadsheet, shown in a drawer above the section tabs.
// Row 1 holds the column headers, column A holds the categories. Editing a
// cell is committed with updateElement. Paste TSV from Excel or Sheets, or
// import a CSV or XLSX file (SheetJS).
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import * as XLSX from 'xlsx'
import type { ChartData, ChartElement } from '@sleid/model'
import { X } from 'lucide-react'

type Grid = string[][]

function toGrid(data: ChartData): Grid {
  return [data.columns, ...data.rows.map((row) => row.map((cell) => (cell === null ? '' : String(cell))))]
}

const NUMERIC = /^-?\d+(\.\d+)?$/

/** Grid back to chart data. Numeric-looking cells become numbers; the first row is the header. */
function toData(grid: Grid): ChartData {
  const headerRow = grid[0] ?? []
  const width = Math.max(1, headerRow.length)
  const columns = Array.from({ length: width }, (_, c) => headerRow[c]?.trim() || `Column ${String.fromCharCode(65 + c)}`)
  const rows = grid.slice(1).map((row) =>
    columns.map((_, c) => {
      const raw = (row[c] ?? '').trim()
      if (raw === '') return null
      return NUMERIC.test(raw) ? Number(raw) : raw
    }),
  )
  return { columns, rows }
}

function colName(c: number): string {
  let n = c
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

function pad(grid: Grid): Grid {
  const width = Math.max(1, ...grid.map((r) => r.length))
  return grid.map((r) => [...r, ...Array(width - r.length).fill('')])
}

export function DataGrid({ chart, onCommit, onClose, onToast }: { chart: ChartElement; onCommit: (data: ChartData) => void; onClose: () => void; onToast: (m: string) => void }) {
  const [grid, setGrid] = useState<Grid>(() => toGrid(chart.data))
  const [sel, setSel] = useState<{ r: number; c: number }>({ r: 0, c: 0 })
  const [editing, setEditing] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Undo, or a change from elsewhere, replaces the chart data. Follow it.
  useEffect(() => {
    setGrid(pad(toGrid(chart.data)))
  }, [chart.data])

  const commitGrid = (next: Grid) => {
    const padded = pad(next)
    setGrid(padded)
    onCommit(toData(padded))
  }

  function setCell(r: number, c: number, value: string) {
    const next = grid.map((row) => [...row])
    while (next.length <= r) next.push(Array(grid[0]?.length ?? 1).fill(''))
    next[r]![c] = value
    commitGrid(next)
  }

  function move(dr: number, dc: number) {
    setSel((s) => ({
      r: Math.max(0, Math.min(grid.length - 1, s.r + dr)),
      c: Math.max(0, Math.min((grid[0]?.length ?? 1) - 1, s.c + dc)),
    }))
  }

  function finishEdit(next: 'down' | 'right' | 'none') {
    if (editing !== null) setCell(sel.r, sel.c, editing)
    setEditing(null)
    if (next === 'down') move(1, 0)
    if (next === 'right') move(0, 1)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (editing !== null) return
    if (e.key === 'ArrowDown') return (e.preventDefault(), move(1, 0))
    if (e.key === 'ArrowUp') return (e.preventDefault(), move(-1, 0))
    if (e.key === 'ArrowLeft') return (e.preventDefault(), move(0, -1))
    if (e.key === 'ArrowRight' || e.key === 'Tab') return (e.preventDefault(), move(0, e.shiftKey ? -1 : 1))
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault()
      setEditing(grid[sel.r]?.[sel.c] ?? '')
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      setCell(sel.r, sel.c, '')
      return
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      setEditing(e.key)
    }
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    if (editing !== null) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((line) => line.split('\t'))
    const next = grid.map((row) => [...row])
    rows.forEach((cells, dr) => {
      const r = sel.r + dr
      while (next.length <= r) next.push(Array((grid[0] ?? ['']).length).fill(''))
      cells.forEach((value, dc) => {
        const c = sel.c + dc
        for (const row of next) while (row.length <= c) row.push('')
        next[r]![c] = value.trim()
      })
    })
    commitGrid(next)
    onToast(`Pasted ${rows.length} row${rows.length === 1 ? '' : 's'}`)
  }

  function addRow() {
    commitGrid([...grid, Array((grid[0] ?? ['']).length).fill('')])
  }

  function addColumn() {
    commitGrid(grid.map((row, r) => [...row, r === 0 ? `Series ${(grid[0]?.length ?? 1)}` : '']))
  }

  function deleteRow() {
    if (sel.r === 0 || grid.length <= 2) return onToast('Select a data row (not the header), and keep at least one row')
    commitGrid(grid.filter((_, r) => r !== sel.r))
    setSel((s) => ({ ...s, r: Math.max(0, s.r - 1) }))
  }

  function deleteColumn() {
    const width = grid[0]?.length ?? 0
    if (width <= 1) return onToast('A chart needs at least one column')
    commitGrid(grid.map((row) => row.filter((_, c) => c !== sel.c)))
    setSel((s) => ({ ...s, c: Math.max(0, Math.min(s.c, width - 2)) }))
  }

  async function importFile(file: File) {
    try {
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv'
      const workbook = isCsv ? XLSX.read(await file.text(), { type: 'string' }) : XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const first = workbook.SheetNames[0]
      if (!first) return onToast('The file has no sheets')
      const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[first]!, { header: 1, defval: '', blankrows: false })
      const next = rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))))
      if (next.length < 2) return onToast('The file needs a header row and at least one data row')
      setSel({ r: 0, c: 0 })
      commitGrid(next)
      onToast(`Imported ${next.length - 1} rows from ${file.name}`)
    } catch (err) {
      onToast(err instanceof Error ? `Import failed: ${err.message}` : 'Import failed')
    }
  }

  const width = grid[0]?.length ?? 1

  return (
    <section aria-label="Chart data" className="flex h-64 shrink-0 flex-col border-t border-rule bg-white">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-rule px-3 text-[12px]">
        <span className="font-medium">Data for {chart.chartType} chart</span>
        <span className="text-ink-muted">Row 1 is the header. Column A holds the categories.</span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="rounded px-2 py-1 hover:bg-hover" onClick={addRow}>+ Row</button>
          <button type="button" className="rounded px-2 py-1 hover:bg-hover" onClick={addColumn}>+ Column</button>
          <button type="button" className="rounded px-2 py-1 hover:bg-hover" onClick={deleteRow}>Delete row</button>
          <button type="button" className="rounded px-2 py-1 hover:bg-hover" onClick={deleteColumn}>Delete column</button>
          <button type="button" className="rounded px-2 py-1 text-accent hover:bg-hover" onClick={() => fileRef.current?.click()}>Import CSV/XLSX</button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void importFile(file)
            }}
          />
          <button type="button" aria-label="Close data" className="ml-2 rounded p-1 hover:bg-hover" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>
      <div
        ref={wrapRef}
        tabIndex={0}
        role="grid"
        aria-label="Chart data grid"
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        <table className="border-collapse text-[13px]">
          <thead>
            <tr>
              <th className="sticky top-0 z-10 w-10 border border-rule bg-[#f1f3f4] text-[11px] font-normal text-ink-muted" />
              {Array.from({ length: width }, (_, c) => (
                <th key={c} className="sticky top-0 z-10 min-w-28 border border-rule bg-[#f1f3f4] px-2 text-[11px] font-normal text-ink-muted">
                  {colName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, r) => (
              <tr key={r}>
                <th className="sticky left-0 border border-rule bg-[#f1f3f4] px-2 text-[11px] font-normal text-ink-muted">{r + 1}</th>
                {Array.from({ length: width }, (_, c) => {
                  const selected = sel.r === r && sel.c === c
                  const isEditing = selected && editing !== null
                  const value = row[c] ?? ''
                  return (
                    <td
                      key={c}
                      role="gridcell"
                      aria-selected={selected}
                      onClick={() => {
                        setEditing(null)
                        setSel({ r, c })
                        wrapRef.current?.focus()
                      }}
                      onDoubleClick={() => setEditing(value)}
                      className={`h-7 min-w-28 border px-0 ${selected ? 'border-2 border-accent' : 'border-rule-soft'} ${
                        r === 0 || c === 0 ? 'font-medium' : ''
                      }`}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          aria-label="Cell editor"
                          value={editing ?? ''}
                          onChange={(e) => setEditing(e.target.value)}
                          onBlur={() => finishEdit('none')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.preventDefault(), finishEdit('down'))
                            if (e.key === 'Tab') (e.preventDefault(), finishEdit('right'))
                            if (e.key === 'Escape') (e.preventDefault(), setEditing(null), wrapRef.current?.focus())
                          }}
                          className="h-full w-full bg-white px-2 outline-none"
                        />
                      ) : (
                        <div className="h-full truncate px-2 leading-7">{value}</div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

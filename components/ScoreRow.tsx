'use client';

import { useEffect, useRef } from 'react';
import { numberAt, crossCount, rightmostIndex, scoreRow, LOCK_INDEX, MIN_CROSSES_TO_LOCK, type Color, type Sheet } from '@/lib/scoring';
import { NumberCell } from './NumberCell';
import { LockCell, type LockCellState } from './LockCell';
import { RowGlyph, ROW_LABEL, ROW_DIRECTION, ROW_CLASSES } from './RowGlyph';

interface ScoreRowProps {
  color: Color;
  sheet: Sheet;
  closedByName: string | null;
  onCross: (index: number) => void;
}

export function ScoreRow({ color, sheet, closedByName, onCross }: ScoreRowProps) {
  const crossed = sheet.crosses[color];
  const rightmost = rightmostIndex(sheet, color);
  const count = crossCount(sheet, color);
  const locked = sheet.locks[color];
  const closed = closedByName !== null;
  const rowScore = scoreRow(count, locked);
  const classes = ROW_CLASSES[color];
  const describedById = `${color}-row-status`;

  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const wasClosedRef = useRef(closed);

  // A remote closure disables every cell in this row. If keyboard focus was sitting
  // on one of those cells when the poll landed, move it deliberately to the row
  // heading rather than letting the browser drop it to <body>.
  useEffect(() => {
    const wasClosed = wasClosedRef.current;
    wasClosedRef.current = closed;
    if (closed && !wasClosed) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && sectionRef.current?.contains(active)) {
        headingRef.current?.focus();
      }
    }
  }, [closed]);

  const cells = Array.from({ length: LOCK_INDEX + 1 }, (_, index) => {
    const isCrossed = crossed.includes(index);
    const state = isCrossed ? 'crossed' : index < rightmost ? 'blocked' : 'open';
    return (
      <NumberCell
        key={index}
        color={color}
        number={numberAt(color, index)}
        state={state}
        closedByName={closedByName}
        onPress={() => onCross(index)}
      />
    );
  });

  const lockState: LockCellState = locked ? 'locked' : count >= MIN_CROSSES_TO_LOCK ? 'available' : 'unavailable';

  return (
    <section
      ref={sectionRef}
      aria-label={`${ROW_LABEL[color]} row`}
      aria-describedby={closed ? describedById : undefined}
      className={`rounded-card border-2 p-2 ${classes.card} ${classes.edge}`}
    >
      <div className="mb-1.5 flex items-center justify-between text-sm font-semibold">
        <div ref={headingRef} tabIndex={-1} className={`flex items-center gap-1.5 focus:outline-none ${classes.ink}`}>
          <RowGlyph color={color} className={classes.ink} />
          {ROW_LABEL[color]}
          <span className="font-normal text-qx-muted">{ROW_DIRECTION[color]}</span>
        </div>
        <span className={classes.ink}>
          {rowScore}
        </span>
      </div>

      {closed && (
        <p id={describedById} className={`mb-1.5 text-xs font-medium ${classes.ink}`}>
          Closed by {closedByName}
        </p>
      )}

      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
        {cells}
        <LockCell color={color} state={lockState} closedByName={closedByName} onPress={() => onCross(LOCK_INDEX)} />
      </div>
    </section>
  );
}

"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  TASK_IMAGE_WIDTH_MAX,
  TASK_IMAGE_WIDTH_MIN,
  TASK_IMAGE_WIDTH_PRESETS,
  TASK_IMAGE_WIDTH_STEP,
  parseTaskImageReferences,
  replaceTaskImageWidth,
  type TaskImageReference,
} from "@/lib/task-description-format";

type ImageChoice = TaskImageReference & { key: string };

export function NativeImageWidthEditor({
  taskId,
  value,
  onChange,
  disabled,
}: {
  taskId: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  const choices = useMemo(() => imageChoices(value), [value]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = choices.find((choice) => choice.key === selectedKey) ?? choices[0] ?? null;
  const drag = useRef<{ pointerId: number; originX: number; originWidth: number } | null>(null);

  if (!selected) return null;

  function applyWidth(width: number | null) {
    if (!selected || disabled) return;
    const current = imageChoices(valueRef.current).find((choice) => choice.key === selected.key);
    if (!current) return;
    const next = replaceTaskImageWidth(valueRef.current, current.start, current.end, width);
    valueRef.current = next;
    onChange(next);
  }

  function changeBy(delta: number) {
    const current = selected?.width ?? 480;
    applyWidth(clampWidth(current + delta));
  }

  function onHandleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      changeBy(-TASK_IMAGE_WIDTH_STEP);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      changeBy(TASK_IMAGE_WIDTH_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      applyWidth(TASK_IMAGE_WIDTH_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      applyWidth(TASK_IMAGE_WIDTH_MAX);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      applyWidth(null);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originWidth: selected.width ?? Math.round(
        event.currentTarget.parentElement?.getBoundingClientRect().width ?? 480,
      ),
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    applyWidth(clampWidth(drag.current.originWidth + event.clientX - drag.current.originX));
  }

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  return (
    <section className="native-image-width-editor" aria-label="Inline image size">
      {choices.length > 1 && (
        <div className="native-image-width-tabs" role="list" aria-label="Images in this draft">
          {choices.map((choice, index) => (
            <button
              key={choice.key}
              type="button"
              className={choice.key === selected.key ? "active" : ""}
              aria-pressed={choice.key === selected.key}
              onClick={() => setSelectedKey(choice.key)}
            >Image {index + 1}</button>
          ))}
        </div>
      )}
      <div
        className="native-image-width-preview"
        style={{ width: `min(100%, ${selected.width ?? 620}px)` }}
        data-width={selected.width ?? "auto"}
      >
        <img
          src={`/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(selected.ref)}/content?variant=thumbnail&disposition=inline`}
          alt={selected.alt}
          draggable={false}
        />
        <div
          className="native-image-resize-handle"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={`Resize ${selected.alt}`}
          aria-valuemin={TASK_IMAGE_WIDTH_MIN}
          aria-valuemax={TASK_IMAGE_WIDTH_MAX}
          aria-valuenow={selected.width ?? 620}
          aria-valuetext={selected.width == null ? "Auto" : `${selected.width} pixels`}
          aria-disabled={disabled}
          onKeyDown={onHandleKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        ><span>{selected.width == null ? "Auto" : `${selected.width}px`}</span></div>
      </div>
      <div className="native-image-width-presets" role="toolbar" aria-label="Image width presets">
        <button type="button" disabled={disabled} aria-label="Reset image width to Auto" aria-pressed={selected.width == null} onClick={() => applyWidth(null)}>Reset to Auto</button>
        {TASK_IMAGE_WIDTH_PRESETS.map((width) => (
          <button
            key={width}
            type="button"
            disabled={disabled}
            aria-pressed={selected.width === width}
            onClick={() => applyWidth(width)}
          >{width}px</button>
        ))}
      </div>
      <p>Drag the lower handle, use Arrow keys in {TASK_IMAGE_WIDTH_STEP}px steps, or choose a preset.</p>
    </section>
  );
}

function imageChoices(value: string): ImageChoice[] {
  const occurrences = new Map<string, number>();
  return parseTaskImageReferences(value).map((reference) => {
    const occurrence = occurrences.get(reference.ref) ?? 0;
    occurrences.set(reference.ref, occurrence + 1);
    return { ...reference, key: `${reference.ref}:${occurrence}` };
  });
}

function clampWidth(value: number) {
  const rounded = Math.round(value / TASK_IMAGE_WIDTH_STEP) * TASK_IMAGE_WIDTH_STEP;
  return Math.max(TASK_IMAGE_WIDTH_MIN, Math.min(TASK_IMAGE_WIDTH_MAX, rounded));
}

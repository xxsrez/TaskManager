import {
  parseTaskImageReferences,
  replaceTaskImageWidth,
  type TaskImageReference,
} from "./task-description-format";

const IMAGE_SELECTION_CONTEXT_LENGTH = 96;

export type TaskImageSelection = {
  ref: string;
  token: string;
  start: number;
  before: string;
  after: string;
};

export function createTaskImageSelection(
  body: string,
  reference: TaskImageReference,
): TaskImageSelection {
  return {
    ref: reference.ref,
    token: reference.token,
    start: reference.start,
    before: body.slice(
      Math.max(0, reference.start - IMAGE_SELECTION_CONTEXT_LENGTH),
      reference.start,
    ),
    after: body.slice(
      reference.end,
      reference.end + IMAGE_SELECTION_CONTEXT_LENGTH,
    ),
  };
}

export function resolveTaskImageSelection(
  body: string,
  selection: TaskImageSelection,
): TaskImageReference | null {
  const sameRef = parseTaskImageReferences(body).filter(
    (reference) => reference.ref === selection.ref,
  );
  if (sameRef.length === 0) return null;
  const exactToken = sameRef.filter(
    (reference) => reference.token === selection.token,
  );
  const candidates = exactToken.length > 0 ? exactToken : sameRef;
  if (candidates.length === 1) return candidates[0]!;

  return [...candidates].sort((left, right) => {
    const contextDifference = selectionContextScore(body, selection, right) -
      selectionContextScore(body, selection, left);
    if (contextDifference !== 0) return contextDifference;
    return Math.abs(left.start - selection.start) - Math.abs(right.start - selection.start);
  })[0]!;
}

export function replaceSelectedTaskImageWidth(
  body: string,
  selection: TaskImageSelection,
  width: number | null,
) {
  const current = resolveTaskImageSelection(body, selection);
  if (!current) return null;
  const value = replaceTaskImageWidth(body, current.start, current.end, width);
  const resized = parseTaskImageReferences(value).find(
    (reference) => reference.start === current.start,
  );
  if (!resized) return null;
  return {
    value,
    selection: createTaskImageSelection(value, resized),
  };
}

function selectionContextScore(
  body: string,
  selection: TaskImageSelection,
  reference: TaskImageReference,
) {
  const before = body.slice(
    Math.max(0, reference.start - IMAGE_SELECTION_CONTEXT_LENGTH),
    reference.start,
  );
  const after = body.slice(
    reference.end,
    reference.end + IMAGE_SELECTION_CONTEXT_LENGTH,
  );
  return (selection.before === before ? IMAGE_SELECTION_CONTEXT_LENGTH * 2 : 0) +
    (selection.after === after ? IMAGE_SELECTION_CONTEXT_LENGTH * 2 : 0) +
    commonSuffixLength(selection.before, before) +
    commonPrefixLength(selection.after, after);
}

function commonPrefixLength(left: string, right: string) {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left: string, right: string) {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < length &&
    left[left.length - 1 - index] === right[right.length - 1 - index]
  ) index += 1;
  return index;
}
